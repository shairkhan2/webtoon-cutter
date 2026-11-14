import { statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { benchmark } from './core/benchmark.ts';
import { createDetector } from './core/detect/index.ts';
import { chapterId, listChapters, paths, readLabels, readManifest, runDir } from './core/library.ts';
import { runPipeline } from './core/pipeline.ts';
import type { Manifest } from './core/types.ts';

const USAGE = `Usage:
  npm run cut -- <file.cbz | chapterId>... [--out <dir>]   cut chapters (default out: data/runs/<id>)
  npm run cut -- --all                                    cut every chapter in the library
  npm run bench [-- <chapterId>...] [--rerun]             score labelled chapters against their labels`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { out: { type: 'string' }, all: { type: 'boolean' }, rerun: { type: 'boolean' } },
  });
  if (command === 'cut') return cut(values.all ? listChapters().map((c) => c.file) : positionals, values.out);
  if (command === 'bench') return bench(positionals, Boolean(values.rerun));
  console.log(USAGE);
  process.exitCode = 1;
}

function resolveInput(arg: string): { file: string; id: string } {
  const known = listChapters().find((c) => c.id === arg || c.name === arg);
  if (known) return { file: known.file, id: known.id };
  const file = path.resolve(arg);
  return { file, id: chapterId(file, statSync(file).size) };
}

async function cut(inputs: string[], out?: string): Promise<Manifest[]> {
  if (!inputs.length) {
    console.log(USAGE);
    process.exitCode = 1;
    return [];
  }
  const detector = await createDetector(paths.models);
  const results: Manifest[] = [];
  try {
    for (const arg of inputs) {
      const { file, id } = resolveInput(arg);
      const outDir = out && inputs.length === 1 ? path.resolve(out) : runDir(id);
      console.log(`\n== ${path.basename(file)} -> ${outDir}`);
      let lastTenth = -1;
      const m = await runPipeline({
        cbzPath: file,
        outDir,
        chapterId: id,
        modelDir: paths.models,
        detector,
        log: console.log,
        progress: (stage, f) => {
          const tenth = Math.floor(f * 10);
          if (stage === 'detect' && tenth !== lastTenth) {
            lastTenth = tenth;
            console.log(`[detect] ${tenth * 10}%`);
          }
        },
      });
      printSummary(m);
      results.push(m);
    }
  } finally {
    await detector.release();
  }
  return results;
}

function printSummary(m: Manifest) {
  const c = m.counts;
  const k = m.checks;
  console.log(
    `panels ${c.panels} (art ${c.art}, art+text ${c.artText}, text ${c.text}, decor ${c.decor}, credits ${c.credits}) | ` +
      `shots ${c.shots} (A ${c.shotsA}, B ${c.shotsB}, pans ${c.shotsPan}, text-free ${c.shotsTextFree}) | art panels without shots ${c.artPanelsWithoutShots}`,
  );
  console.log(
    `cuts: border ${c.borderCuts}, split ${c.splitCuts}, tall panels ${c.tallPanels} | faces ${c.faces}, heads ${c.heads} | ` +
      `lines: dialogue ${c.textLines}, sfx ${c.sfxLines}, watermark ${c.watermarkLines}, noise ${c.noiseLines}`,
  );
  console.log(
    `checks: uncovered rows ${k.uncoveredRows}, cuts through heads ${k.readerCutsThroughHeads}, text ${k.readerCutsThroughText}, ` +
      `balloon pixels ${k.readerCutsThroughBalloonPixels} | shots with dialogue lines ${k.shotsWithDialogueLines}, shot edges through faces ${k.shotEdgesThroughFaces}`,
  );
  console.log(`timings: ${JSON.stringify(m.timings)}`);
}

async function bench(ids: string[], rerun: boolean) {
  const chapters = listChapters();
  const targets = [];
  for (const c of chapters) {
    if (ids.length && !ids.includes(c.id)) continue;
    const labels = await readLabels(c.id);
    if (labels?.cuts.length) targets.push({ chapter: c, labels });
  }
  if (!targets.length) {
    console.log('No labelled chapters. Label cuts in the viewer first (npm start, then "Label" mode).');
    return;
  }
  if (rerun) await cut(targets.map((t) => t.chapter.file));

  const rows = [];
  for (const { chapter, labels } of targets) {
    const m = await readManifest(chapter.id);
    if (!m) {
      rows.push({ chapter: chapter.name, status: 'not processed (run with --rerun)' });
      continue;
    }
    const b = benchmark(m.panels, labels.cuts);
    rows.push({
      chapter: chapter.name,
      labels: b.labelCuts,
      predicted: b.predictedCuts,
      precision: b.precision,
      recall: b.recall,
      f1: b.f1,
      missed: b.missed.length,
      extra: b.extra.length,
      shots: m.counts.shots,
      headCuts: m.checks.readerCutsThroughHeads,
      textCuts: m.checks.readerCutsThroughText,
    });
  }
  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
