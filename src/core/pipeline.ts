import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadStrip, stripRows } from './cbz.ts';
import { runChecks } from './checks.ts';
import { config, PIPELINE_VERSION } from './config.ts';
import { creditPanels, findCreditPages } from './credits.ts';
import { createDetector, detectObjects, detectSmallText, type Detector } from './detect/index.ts';
import type { LineReading } from './detect/reader.ts';
import { analyzeDetail } from './interest.ts';
import { analyzeCells, analyzeRows } from './rows.ts';
import { buildPanels, segment } from './segment.ts';
import { planShots } from './shots.ts';
import { analyzeText, lineCandidates, smallSiteLines } from './text.ts';
import type { ChunkInfo, Detection, Manifest, ProgressFn, Shot, Strip } from './types.ts';
import { blurMarks } from './watermarks.ts';

export interface RunOptions {
  cbzPath: string;
  outDir: string;
  chapterId: string;
  modelDir: string;
  detector?: Detector;
  progress?: ProgressFn;
  log?: (msg: string) => void;
}

export async function runPipeline(opts: RunOptions): Promise<Manifest> {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  let tStage = t0;
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - tStage) / 1000;
    tStage = now;
  };
  const progress = opts.progress ?? (() => {});
  const log = opts.log ?? (() => {});

  progress('load', 0);
  const strip = await loadStrip(opts.cbzPath);
  const { width, height, gray } = strip;
  lap('load_s');
  log(`[load] ${strip.pages.length} pages -> ${width}x${height}px, skipped ${strip.skipped.length}`);

  progress('analyze', 0);
  const rows = analyzeRows(gray, width, height);
  const cells = analyzeCells(gray, width, height);
  const detail = analyzeDetail(gray, width, height);
  lap('rows_s');

  const detector = opts.detector ?? (await createDetector(opts.modelDir));
  let detections: Detection[] = [];
  let lineDets: Detection[] = [];
  const readings: LineReading[] = [];
  try {
    ({ detections } = await detectObjects(strip, rows.flat, detector, progress));
    lap('detect_s');
    progress('read', 0);
    lineDets = lineCandidates(detections);
    for (const [i, d] of lineDets.entries()) {
      readings.push(await detector.reader.read(strip, d));
      if (i % 20 === 0) progress('read', i / lineDets.length);
    }
    lap('read_s');
  } catch (err) {
    if (!opts.detector) await detector.release();
    throw err;
  }

  progress('layout', 0);
  // A real face has no empty full-width rows through it. Head and face boxes that are largely
  // blank rows span a gutter: detector false positives on effects or noise.
  detections = detections.filter((d) => {
    if (d.kind !== 'head' && d.kind !== 'face') return true;
    let blank = 0;
    for (let y = d.y0; y < d.y1; y++) blank += rows.flat[y];
    return blank < 0.3 * (d.y1 - d.y0);
  });
  const heads = detections.filter((d) => d.kind === 'head');
  const faces = detections.filter((d) => d.kind === 'face');
  const persons = detections.filter((d) => d.kind === 'person');
  // Layout, then the small-text pass. The detector is released however this ends.
  let text: ReturnType<typeof analyzeText>;
  let seg: ReturnType<typeof segment>;
  let panels: Manifest['panels'];
  let creditPages: number[];
  let shots: Shot[];
  let smallSiteCount = 0;
  try {
    text = analyzeText(strip, lineDets, readings);
    seg = segment({ width, height, gray, rgb: strip.rgb, rows, cells, heads, persons, blocks: text.blocks, pages: strip.pages });
    panels = buildPanels(seg, strip.pages, width, height);
    creditPages = findCreditPages(strip.pages, text.lines, width);
    for (const p of creditPanels(panels, strip.pages, creditPages, text.lines, text.blocks)) {
      p.role = 'credits';
      p.reader = false;
    }
    const plan = () =>
      planShots(panels, {
        width,
        height,
        detail,
        faces,
        heads,
        persons,
        blocks: text.blocks,
        lines: text.lines,
        frameLines: seg.frameLines,
        pages: strip.pages,
      });
    shots = plan();
    lap('layout_s');

    // Small corner banners are missed at half resolution. Look again inside the video shots only,
    // keep what reads as site lettering (and banner lines stacked on it), and plan the shots again
    // so they know about it. Reader panels are not affected: blurring is for video images only.
    progress('banners', 0);
    const small = (await detectSmallText(strip, shots, detections, detector, config.blur.scanScale)).filter(
      (d) => d.x1 - d.x0 >= config.text.minLinePx && d.y1 - d.y0 >= 6,
    );
    const smallReadings: LineReading[] = [];
    for (const d of small) smallReadings.push(await detector.reader.read(strip, d));
    const found = smallSiteLines(small, smallReadings, text.lines);
    if (found.length) {
      smallSiteCount = found.length;
      text = { ...text, lines: [...text.lines, ...found] };
      shots = plan();
    }
  } finally {
    if (!opts.detector) await detector.release();
  }
  lap('banners_s');
  const checks = runChecks(gray, width, height, panels, shots, heads, faces, text.lines);

  progress('write', 0);
  const chunks = await writeImages(strip, panels, shots, opts.outDir, progress);
  lap('write_s');
  timings.total_s = Math.round(performance.now() - t0) / 1000;

  const count = <T>(list: T[], pred: (t: T) => boolean) => list.filter(pred).length;
  const isArt = (p: Manifest['panels'][number]) => p.role === 'art' || p.role === 'art_text';
  const manifest: Manifest = {
    pipelineVersion: PIPELINE_VERSION,
    source: { file: path.basename(opts.cbzPath), chapterId: opts.chapterId, bytes: (await stat(opts.cbzPath)).size },
    strip: { width, height, chunks },
    pages: strip.pages,
    skippedPages: strip.skipped,
    detections,
    textLines: text.lines,
    textBlocks: text.blocks,
    gutters: seg.gutters,
    frameLines: seg.frameLines,
    panels,
    shots,
    creditPages,
    checks,
    counts: {
      panels: panels.length,
      art: count(panels, (p) => p.role === 'art'),
      artText: count(panels, (p) => p.role === 'art_text'),
      text: count(panels, (p) => p.role === 'text'),
      decor: count(panels, (p) => p.role === 'decor'),
      credits: count(panels, (p) => p.role === 'credits'),
      artPanelsWithShots: count(panels, (p) => isArt(p) && p.shotIds.length > 0),
      artPanelsWithoutShots: count(panels, (p) => isArt(p) && p.shotIds.length === 0),
      shots: shots.length,
      shotsA: count(shots, (s) => s.tier === 'A'),
      shotsB: count(shots, (s) => s.tier === 'B'),
      shotsPan: count(shots, (s) => s.motion === 'pan'),
      shotsTextFree: count(shots, (s) => s.dialogueShare === 0),
      tallPanels: count(panels, (p) => p.tall),
      borderCuts: count(panels, (p) => p.bottom === 'border'),
      splitCuts: count(panels, (p) => p.bottom === 'split'),
      heads: heads.length,
      faces: faces.length,
      persons: persons.length,
      textLines: count(text.lines, (l) => l.kind === 'text'),
      sfxLines: count(text.lines, (l) => l.kind === 'sfx'),
      watermarkLines: count(text.lines, (l) => l.kind === 'watermark'),
      smallSiteLines: smallSiteCount,
      shotsWithWatermarks: count(shots, (s) => s.watermarks.length > 0),
      noiseLines: count(text.lines, (l) => l.kind === 'noise'),
      textBlocks: text.blocks.length,
      enclosedBalloons: count(text.blocks, (b) => b.bubble !== null),
      crossPagePanels: count(panels, (p) => p.pages.length > 1),
    },
    timings,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(opts.outDir, 'shots.json'), JSON.stringify(matcherExport(manifest), null, 1));
  progress('done', 1);
  log(`[done] ${panels.length} panels, ${shots.length} shots in ${timings.total_s}s`);
  return manifest;
}

/** Compact list for the video matcher: one entry per shot, everything needed to filter and frame it. */
function matcherExport(m: Manifest) {
  return {
    chapter: m.source.file,
    chapterId: m.source.chapterId,
    pipelineVersion: m.pipelineVersion,
    stripWidth: m.strip.width,
    shots: m.shots.map((s: Shot) => ({
      id: s.id,
      file: `video/${s.file}`,
      panel: s.panelId,
      panelIndex: s.panelIndex,
      readerFile: `reader/${s.panelId}.jpg`,
      tier: s.tier,
      score: s.score,
      focus: s.focus,
      framing: s.framing,
      motion: s.motion,
      screens: s.screens,
      rect: { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 },
      size: { width: s.x1 - s.x0, height: s.y1 - s.y0 },
      focusPoint: { x: s.focusPoint.x - s.x0, y: s.focusPoint.y - s.y0 },
      faces: s.faces,
      people: s.people,
      dialogueShare: s.dialogueShare,
      dialogueLines: s.dialogueLines,
      sfxShare: s.sfxShare,
      watermarks: s.watermarks.map((w) => ({ x0: w.x0 - s.x0, y0: w.y0 - s.y0, x1: w.x1 - s.x0, y1: w.y1 - s.y0 })),
      pages: s.pages,
      why: s.why,
    })),
  };
}

async function writeImages(
  strip: Strip,
  panels: Manifest['panels'],
  shots: Shot[],
  outDir: string,
  progress: ProgressFn,
): Promise<ChunkInfo[]> {
  const { width, height } = strip;
  const q = config.output.jpegQuality;
  for (const dir of ['strip', 'reader', 'video']) {
    await rm(path.join(outDir, dir), { recursive: true, force: true });
    await mkdir(path.join(outDir, dir), { recursive: true });
  }
  const jobs: (() => Promise<void>)[] = [];
  const encode = (y0: number, y1: number, file: string, x0 = 0, x1 = width) =>
    jobs.push(async () => {
      let img = sharp(stripRows(strip, y0, y1), { raw: { width, height: y1 - y0, channels: 3 } });
      if (x0 > 0 || x1 < width) img = img.extract({ left: x0, top: 0, width: x1 - x0, height: y1 - y0 });
      await img.jpeg({ quality: q }).toFile(path.join(outDir, file));
    });
  // Video shots: watermark lettering blurred tightly, on a copy (the strip and reader panels keep it).
  const encodeShot = (s: Shot) =>
    jobs.push(async () => {
      const w = s.x1 - s.x0;
      const h = s.y1 - s.y0;
      const rgb = Buffer.allocUnsafe(w * h * 3);
      for (let y = 0; y < h; y++) {
        const src = ((s.y0 + y) * width + s.x0) * 3;
        rgb.set(strip.rgb.subarray(src, src + w * 3), y * w * 3);
      }
      const local = s.watermarks.map((m) => ({ x0: m.x0 - s.x0, y0: m.y0 - s.y0, x1: m.x1 - s.x0, y1: m.y1 - s.y0 }));
      if (local.length) await blurMarks(rgb, w, h, local);
      await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: q }).toFile(path.join(outDir, 'video', s.file));
    });

  const chunks: ChunkInfo[] = [];
  for (let y = 0, i = 0; y < height; y += config.output.chunkHeight, i++) {
    const y1 = Math.min(height, y + config.output.chunkHeight);
    const file = `chunk_${String(i).padStart(3, '0')}.jpg`;
    chunks.push({ file, y0: y, y1 });
    encode(y, y1, `strip/${file}`);
  }
  for (const p of panels) encode(p.y0, p.y1, `reader/${p.id}.jpg`);
  for (const s of shots) encodeShot(s);

  let done = 0;
  const workers = Array.from({ length: 4 }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      await job();
      progress('write', ++done / (done + jobs.length));
    }
  });
  await Promise.all(workers);
  return chunks;
}
