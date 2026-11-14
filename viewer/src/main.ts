import { benchmark } from '../../src/core/benchmark.ts';
import type { BenchmarkResult, Manifest, Panel, Shot, ShotReject } from '../../src/core/types.ts';

interface JobStatus {
  state: 'new' | 'queued' | 'running' | 'done' | 'error';
  stage: string;
  fraction: number;
  error?: string;
}

interface ChapterItem {
  id: string;
  name: string;
  source: 'upload' | 'library';
  sizeMb: number;
  processed: boolean;
  totalSeconds: number | null;
  labels: number;
  job: JobStatus | null;
}

type LayerKey = 'seams' | 'boxes' | 'text' | 'frames' | 'cuts' | 'shots' | 'labels';
type ReaderFilter = 'all' | 'art' | 'text' | 'novideo';
type ShotFilter = 'all' | 'A' | 'B';

const LAYERS: { key: LayerKey; label: string; color: string; title: string }[] = [
  { key: 'cuts', label: 'Reader cuts', color: '#10b981', title: 'Panel bounds. Green = art, orange = dialogue only, gray = decor or credits.' },
  { key: 'shots', label: 'Video shots', color: '#22d3ee', title: 'Cyan dashed = people shot (A), yellow dashed = b-roll (B). The dot is the focus point.' },
  { key: 'boxes', label: 'Heads / faces / bodies', color: '#ef4444', title: 'Red = head (with hair), orange = face, green dashed = person.' },
  { key: 'text', label: 'Dialogue / SFX', color: '#e040fb', title: 'Magenta = protected dialogue zone, yellow = sound effect, gray = watermark or credit, gray dashed = unreadable (ignored). Hover a box to see what it reads.' },
  { key: 'frames', label: 'Frame borders', color: '#3b82f6', title: 'Verified borders between touching panels.' },
  { key: 'seams', label: 'Page seams', color: '#f43f5e', title: 'Where CBZ page images were stitched.' },
  { key: 'labels', label: 'Labels', color: '#ffffff', title: 'Your labelled cuts. Red = the cutter missed it. Orange marker = the cutter cut where you did not.' },
];

const SKIP_TEXT: Record<ShotReject, string> = {
  too_small: 'no frame-sized area',
  too_long: 'too tall for one shot',
  crosses_border: 'would show the next panel',
  cuts_face: 'every frame cuts a face',
  cuts_head: 'every frame cuts a head',
  cuts_chin: 'every frame cuts the chin',
  dialogue_on_face: 'dialogue covers the face',
  too_much_dialogue: 'too much dialogue, too little art',
  dialogue_text: 'dialogue text in every frame',
  empty_stretch: 'mostly empty',
  no_focus: 'nothing worth showing',
  credits: 'credits page',
  leftover: 'rest of the scene the next shot already shows',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  version: $('version'),
  chapterSelect: $<HTMLSelectElement>('chapterSelect'),
  processBtn: $<HTMLButtonElement>('processBtn'),
  rerunBtn: $<HTMLButtonElement>('rerunBtn'),
  fileInput: $<HTMLInputElement>('fileInput'),
  dropZone: $('dropZone'),
  labelBtn: $<HTMLButtonElement>('labelBtn'),
  issueSelect: $<HTMLSelectElement>('issueSelect'),
  layoutBtn: $<HTMLButtonElement>('layoutBtn'),
  syncBtn: $<HTMLButtonElement>('syncBtn'),
  score: $('score'),
  toggles: $('toggles'),
  labelBar: $('labelBar'),
  seedLabelsBtn: $<HTMLButtonElement>('seedLabelsBtn'),
  clearLabelsBtn: $<HTMLButtonElement>('clearLabelsBtn'),
  labelStatus: $('labelStatus'),
  workspace: $('workspace'),
  lane1: $('lane1'),
  lane2: $('lane2'),
  lane3: $('lane3'),
  lane1Sub: $('lane1Sub'),
  lane2Sub: $('lane2Sub'),
  lane3Sub: $('lane3Sub'),
  stage: $('stage'),
  readerList: $('readerList'),
  shotList: $('shotList'),
  readerFilters: $('readerFilters'),
  shotFilters: $('shotFilters'),
  exportLink: $<HTMLAnchorElement>('exportLink'),
  frameBtn: $<HTMLButtonElement>('frameBtn'),
  busy: $('busy'),
  busyTitle: $('busyTitle'),
  busyBar: $('busyBar'),
  busySub: $('busySub'),
};

const state = {
  chapters: [] as ChapterItem[],
  id: null as string | null,
  m: null as Manifest | null,
  labels: [] as number[],
  bench: null as BenchmarkResult | null,
  labelMode: false,
  sync: true,
  readerFilter: 'all' as ReaderFilter,
  shotFilter: 'all' as ShotFilter,
  layers: Object.fromEntries(LAYERS.map((l) => [l.key, true])) as Record<LayerKey, boolean>,
  active: null as string | null,
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pad3 = (n: number) => String(n).padStart(3, '0');
const isArt = (p: Panel) => p.role === 'art' || p.role === 'art_text';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

// ---------------------------------------------------------------- chapters & processing

async function loadChapters(): Promise<void> {
  const data = await api<{ pipelineVersion: string; chapters: ChapterItem[] }>('/api/chapters');
  state.chapters = data.chapters;
  el.version.textContent = `pipeline ${data.pipelineVersion}`;
  el.chapterSelect.replaceChildren(
    ...data.chapters.map((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      const status =
        c.job && (c.job.state === 'queued' || c.job.state === 'running') ? c.job.state : c.processed ? `${c.totalSeconds}s` : 'not processed';
      o.textContent = `${c.name}  [${status}${c.labels ? `, ${c.labels} labels` : ''}]`;
      return o;
    }),
  );
  if (state.id) el.chapterSelect.value = state.id;
}

async function selectChapter(id: string): Promise<void> {
  state.id = id;
  state.m = null;
  state.active = null;
  history.replaceState(null, '', `#${id}`);
  el.chapterSelect.value = id;
  const labels = await api<{ cuts: number[] }>(`/api/chapters/${id}/labels`);
  state.labels = labels.cuts;
  const chapter = state.chapters.find((c) => c.id === id);
  if (chapter?.job && (chapter.job.state === 'queued' || chapter.job.state === 'running')) {
    await waitForJob(id);
    return;
  }
  if (chapter?.processed) await loadManifest(id);
  else renderAll();
}

async function loadManifest(id: string): Promise<void> {
  state.m = await api<Manifest>(`/api/chapters/${id}/manifest`);
  renderAll();
}

async function process(force: boolean): Promise<void> {
  if (!state.id) return;
  const s = await api<JobStatus>(`/api/chapters/${state.id}/process`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  if (s.state === 'done' && !force) await loadManifest(state.id);
  else await waitForJob(state.id);
}

const STAGES: Record<string, string> = {
  queued: 'Waiting for the previous chapter',
  load: 'Reading and stitching pages',
  analyze: 'Measuring rows and detail',
  detect: 'Detecting heads, faces, bodies and text',
  read: 'Reading the text',
  layout: 'Cutting panels and planning shots',
  banners: 'Looking for small watermarks in the shots',
  write: 'Writing images',
};

async function waitForJob(id: string): Promise<void> {
  el.busy.hidden = false;
  try {
    for (;;) {
      const s = await api<JobStatus>(`/api/chapters/${id}/status`);
      el.busyTitle.textContent = STAGES[s.stage] ?? s.stage ?? 'Working…';
      el.busyBar.style.width = `${Math.round((s.fraction ?? 0) * 100)}%`;
      el.busySub.textContent = state.chapters.find((c) => c.id === id)?.name ?? id;
      if (s.state === 'done') break;
      if (s.state === 'error') throw new Error(s.error ?? 'Processing failed');
      if (s.state === 'new') throw new Error('Job was not started');
      await new Promise((r) => setTimeout(r, 700));
    }
    await loadChapters();
    if (state.id === id) await loadManifest(id);
  } catch (err) {
    alert(`Processing failed: ${(err as Error).message}`);
  } finally {
    el.busy.hidden = true;
  }
}

async function upload(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.cbz')) {
    alert('Please choose a .cbz file.');
    return;
  }
  el.busy.hidden = false;
  el.busyTitle.textContent = `Uploading ${file.name}`;
  el.busyBar.style.width = '0%';
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await api<{ id: string }>('/api/upload', { method: 'POST', body: form });
    await loadChapters();
    state.id = res.id;
    el.chapterSelect.value = res.id;
    state.labels = [];
    await waitForJob(res.id);
  } catch (err) {
    alert(`Upload failed: ${(err as Error).message}`);
    el.busy.hidden = true;
  }
}

// ---------------------------------------------------------------- labels

let saveTimer: number | undefined;
function setLabels(cuts: number[]): void {
  state.labels = [...new Set(cuts.map(Math.round))].sort((a, b) => a - b);
  renderScore();
  renderStrip();
  renderIssues();
  el.labelStatus.textContent = 'saving…';
  clearTimeout(saveTimer);
  const id = state.id;
  saveTimer = window.setTimeout(async () => {
    try {
      await api(`/api/chapters/${id}/labels`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cuts: state.labels }),
      });
      el.labelStatus.textContent = `${state.labels.length} labels saved`;
    } catch (err) {
      el.labelStatus.textContent = `save failed: ${(err as Error).message}`;
    }
  }, 400);
}

function stripScale(): number {
  return state.m ? el.stage.clientWidth / state.m.strip.width : 1;
}

function onStageClick(ev: MouseEvent): void {
  const m = state.m;
  if (!m) return;
  const rect = el.stage.getBoundingClientRect();
  const y = ((ev.clientY - rect.top) / rect.height) * m.strip.height;
  if (!state.labelMode) {
    const p = m.panels.find((q) => y >= q.y0 && y < q.y1);
    if (p) focusPanel(p.id, 'strip');
    return;
  }
  const scale = stripScale();
  const near = state.labels.find((l) => Math.abs(l - y) <= Math.max(20, 10 / scale));
  if (near !== undefined) {
    setLabels(state.labels.filter((l) => l !== near));
    return;
  }
  const snapTol = Math.max(40, 14 / scale);
  const gutter = m.gutters.find((g) => g.y0 > 0 && g.y1 < m.strip.height && y >= g.y0 - snapTol && y <= g.y1 + snapTol);
  setLabels([...state.labels, gutter ? (gutter.y0 + gutter.y1) / 2 : y]);
}

// ---------------------------------------------------------------- rendering

function renderAll(): void {
  renderScore();
  renderStrip();
  renderReader();
  renderShots();
  renderIssues();
  el.processBtn.disabled = !state.id || Boolean(state.m);
  el.rerunBtn.disabled = !state.id;
  el.exportLink.hidden = !state.m;
  if (state.m) el.exportLink.href = `/files/${state.id}/shots.json?t=${encodeURIComponent(state.m.createdAt)}`;
}

function pill(label: string, value: string | number, cls = '', title = ''): string {
  return `<span class="pill ${cls}" title="${esc(title)}">${esc(label)} <b>${esc(String(value))}</b></span>`;
}

function renderScore(): void {
  const m = state.m;
  state.bench = m && state.labels.length ? benchmark(m.panels, state.labels) : null;
  if (!m) {
    el.score.innerHTML = state.id
      ? '<span class="muted">Not processed yet. Click <b>Process</b>.</span>'
      : '<span class="muted">Pick a chapter.</span>';
    return;
  }
  const c = m.counts;
  const k = m.checks;
  const zeroOk = (v: number, bad = 'bad') => (v === 0 ? 'ok' : bad);
  const b = state.bench;
  el.score.innerHTML = [
    pill('Time', `${m.timings.total_s}s`, '', JSON.stringify(m.timings)),
    pill('Panels', c.panels, '', `${c.art} art, ${c.artText} art with dialogue, ${c.text} dialogue only, ${c.decor} decor, ${c.credits} credits`),
    pill('Shots', `${c.shots} (A ${c.shotsA} · B ${c.shotsB})`, 'ok', 'A = people shots, B = b-roll (scenery, objects, effects). Lane 3 filters them; shots.json has every tag.'),
    pill('Art panels without a shot', c.artPanelsWithoutShots, c.artPanelsWithoutShots ? 'warn' : 'ok', 'Art panels where no frame passes the rules. Lane 2 filter "Art, no shot" lists them with the reason.'),
    pill('Uncovered rows', k.uncoveredRows, zeroOk(k.uncoveredRows), 'Rows with visible content that are in no reader panel.'),
    pill('Cuts through heads', k.readerCutsThroughHeads, zeroOk(k.readerCutsThroughHeads), 'Reader cuts on a non-empty row inside a detected head box.'),
    pill('Cuts through text', k.readerCutsThroughText, zeroOk(k.readerCutsThroughText), 'Reader cuts through a dialogue line.'),
    pill('Cuts through balloon pixels', k.readerCutsThroughBalloonPixels, zeroOk(k.readerCutsThroughBalloonPixels, 'warn'), 'Image-only check: the cut row crosses a bright area walled by dark lines. Catches balloons the text detector missed; can also fire on white clothing.'),
    pill('Shots with dialogue text', k.shotsWithDialogueLines, zeroOk(k.shotsWithDialogueLines, 'warn'), 'Shots containing a whole readable dialogue line. One short line (a small balloon by a face) is allowed; check these by eye.'),
    pill('Shot edges through faces', k.shotEdgesThroughFaces, zeroOk(k.shotEdgesThroughFaces), 'Shot edges that cut 10–90% of a face box.'),
    b
      ? pill('Benchmark F1', `${b.f1} · P ${b.precision} · R ${b.recall}`, 'bench', `${b.labelCuts} labelled cuts, ${b.predictedCuts} predicted, ${b.missed.length} missed (merged panels), ${b.extra.length} extra (over-split). Tolerance ${b.tolerancePx}px.`)
      : pill('Benchmark', 'no labels', 'bench', 'Turn on "Label cuts" and mark the correct cuts to score this chapter.'),
  ].join('');
  el.lane1Sub.textContent = `${m.strip.width} × ${m.strip.height.toLocaleString()} px · ${m.pages.length} pages${m.skippedPages.length ? ` (${m.skippedPages.length} skipped)` : ''}`;
  el.lane2Sub.textContent = `${c.panels} panels: ${c.art + c.artText} art, ${c.text} dialogue only${c.decor ? `, ${c.decor} decor` : ''}${c.credits ? `, ${c.credits} credits` : ''}`;
  el.lane3Sub.textContent = `${c.shots} shots from ${c.artPanelsWithShots} of ${c.art + c.artText} art panels`;
}

function renderToggles(): void {
  el.toggles.innerHTML = LAYERS.map(
    (l) =>
      `<span class="chip ${state.layers[l.key] ? 'on' : ''}" data-layer="${l.key}" title="${esc(l.title)}"><i style="background:${l.color}"></i>${esc(l.label)}</span>`,
  ).join('');
}

function renderStrip(): void {
  const m = state.m;
  if (!m) {
    el.stage.innerHTML = '';
    el.stage.dataset.chapter = '';
    return;
  }
  const W = m.strip.width;
  const H = m.strip.height;
  const t = encodeURIComponent(m.createdAt);
  if (el.stage.dataset.chapter !== `${state.id}:${m.createdAt}`) {
    el.stage.innerHTML = m.strip.chunks
      .map((c) => `<img loading="lazy" width="${W}" height="${c.y1 - c.y0}" src="/files/${state.id}/strip/${c.file}?t=${t}" alt="">`)
      .join('');
    el.stage.dataset.chapter = `${state.id}:${m.createdAt}`;
  }
  const ns = 'vector-effect="non-scaling-stroke"';
  const line = (y0: number, y1: number, color: string, w: number, extra = '') =>
    `<line x1="0" x2="${W}" y1="${y0}" y2="${y1}" stroke="${color}" stroke-width="${w}" ${ns} ${extra}/>`;
  const rect = (r: { x0: number; y0: number; x1: number; y1: number }, style: string, title = '') =>
    `<rect x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" fill="none" ${ns} ${style}>${title ? `<title>${esc(title)}</title>` : ''}</rect>`;
  const g = (key: LayerKey, body: string) => `<g class="${state.layers[key] ? '' : 'layer-off'}">${body}</g>`;

  const seams = m.pages.slice(1).map((p) => line(p.y0, p.y0, '#f43f5e', 1.5, 'stroke-dasharray="8,6" opacity="0.8"')).join('');
  const boxStyle: Record<string, string> = {
    head: 'stroke="#ef4444" stroke-width="2"',
    face: 'stroke="#fb923c" stroke-width="2"',
    person: 'stroke="#22c55e" stroke-width="1.5" stroke-dasharray="6,4"',
  };
  const boxes = m.detections
    .filter((d) => d.kind !== 'text')
    .map((d) => rect(d, boxStyle[d.kind], `${d.kind} ${d.score.toFixed(2)}`))
    .join('');
  const lineStyle: Record<string, string> = {
    sfx: 'stroke="#facc15" stroke-width="1.5"',
    watermark: 'stroke="#94a3b8" stroke-width="1.5"',
    noise: 'stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,4"',
  };
  const text =
    m.textBlocks.map((b) => rect(b.zone, 'stroke="#e040fb" stroke-width="2"', b.bubble ? 'dialogue (balloon)' : 'dialogue (open text)')).join('') +
    m.textLines
      .filter((l) => l.kind !== 'text')
      .map((l) => rect(l, lineStyle[l.kind], `${l.kind}: ${l.why}`))
      .join('');
  const frames = m.frameLines
    .map((f) => `<line x1="0" x2="${W}" y1="${f.yLeft}" y2="${f.yRight}" stroke="#3b82f6" stroke-width="3" ${ns}><title>frame ${f.kind} ${f.score}</title></line>`)
    .join('');
  const roleColor = (p: Panel) => (p.role === 'text' ? '#f59e0b' : p.role === 'decor' || p.role === 'credits' ? '#94a3b8' : '#10b981');
  const cuts = m.panels
    .map(
      (p) =>
        line(p.y0, p.y0, roleColor(p), 2.5) +
        line(p.y1, p.y1, roleColor(p), 2.5) +
        `<rect class="hit ${p.id === state.active ? 'active' : ''}" data-id="${p.id}" x="0" y="${p.y0}" width="${W}" height="${p.y1 - p.y0}"><title>#${p.index} ${p.role} ${p.top}/${p.bottom}</title></rect>`,
    )
    .join('');
  const shots = m.shots
    .map((s) => {
      const color = s.tier === 'A' ? '#22d3ee' : '#facc15';
      const inset = { x0: s.x0 + 4, x1: s.x1 - 4, y0: s.y0 + 4, y1: s.y1 - 4 };
      return (
        rect(inset, `stroke="${color}" stroke-width="2.5" stroke-dasharray="10,6"`, `${s.id} ${s.tier} ${s.focus} ${s.framing}: ${s.why}`) +
        `<circle cx="${s.focusPoint.x}" cy="${s.focusPoint.y}" r="${Math.round(0.012 * W)}" fill="${color}" opacity="0.9"/>` +
        `<text x="${s.x1 - 0.13 * W}" y="${s.y0 + 0.045 * W}" font-size="${Math.round(0.035 * W)}" font-family="system-ui,sans-serif" fill="${color}" stroke="#000" stroke-width="${Math.round(0.003 * W)}" paint-order="stroke">${s.id}</text>`
      );
    })
    .join('');
  const missed = new Set(state.bench?.missed ?? []);
  const labels =
    state.labels.map((y) => line(y, y, missed.has(y) ? '#f43f5e' : '#ffffff', missed.has(y) ? 4 : 3, 'stroke-dasharray="14,6"')).join('') +
    (state.bench?.extra ?? [])
      .map((y) => `<path d="M0 ${y - 30} L40 ${y} L0 ${y + 30} Z" fill="#fb923c"><title>extra cut (not in labels)</title></path>`)
      .join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${g('seams', seams)}${g('boxes', boxes)}${g('text', text)}${g('frames', frames)}${g('shots', shots)}${g('cuts', cuts)}${g('labels', labels)}</svg>`;
  el.stage.querySelector('svg')?.remove();
  el.stage.insertAdjacentHTML('beforeend', svg);
  el.stage.classList.toggle('labeling', state.labelMode);
}

function readerPasses(p: Panel): boolean {
  if (state.readerFilter === 'art') return isArt(p);
  if (state.readerFilter === 'text') return p.role === 'text';
  if (state.readerFilter === 'novideo') return isArt(p) && !p.shotIds.length;
  return true;
}

const ROLE_NAME: Record<Panel['role'], string> = {
  art: 'art',
  art_text: 'art + dialogue',
  text: 'dialogue',
  decor: 'decor',
  credits: 'credits: excluded',
};

function renderReader(): void {
  const m = state.m;
  if (!m) {
    el.readerList.innerHTML = '';
    return;
  }
  const t = encodeURIComponent(m.createdAt);
  el.readerList.innerHTML = m.panels
    .filter(readerPasses)
    .map((p) => {
      const shotBadge = !isArt(p)
        ? ''
        : p.shotIds.length
          ? `<span class="badge b-video">→ ${p.shotIds.join(' ')}</span>`
          : `<span class="badge b-novideo">no shot: ${esc(SKIP_TEXT[p.videoSkip ?? 'no_focus'])}</span>`;
      return `<div class="card role-${p.role} ${p.id === state.active ? 'active' : ''}" data-id="${p.id}" data-y0="${p.y0}" data-y1="${p.y1}">
        <div class="card-head"><span class="badges"><b>#${pad3(p.index)}</b><span class="badge b-${p.role === 'credits' ? 'decor' : p.role}">${ROLE_NAME[p.role]}</span>${shotBadge}${p.tall ? '<span class="badge b-decor">tall</span>' : ''}</span>
          <span class="muted">${p.y1 - p.y0}px · y ${p.y0}–${p.y1}</span></div>
        <div class="img-wrap"><img loading="lazy" width="${m.strip.width}" height="${p.y1 - p.y0}" src="/files/${state.id}/reader/${p.id}.jpg?t=${t}" alt=""></div>
        <div class="card-foot"><span>pages ${p.pages.join(', ')}</span><span>top: ${p.top} · bottom: ${p.bottom}</span></div>
      </div>`;
    })
    .join('');
}

function shotCard(s: Shot, W: number, t: string): string {
  const sideCrop = s.x0 > 0 || s.x1 < W;
  const src = `/files/${state.id}/video/${s.file}?t=${t}`;
  const box = (s.x1 - s.x0) / (s.y1 - s.y0);
  return `<div class="card shot ${s.panelId === state.active ? 'active' : ''}" data-id="${s.panelId}" data-shot="${s.id}" data-y0="${s.y0}" data-y1="${s.y1}" style="--src:url('${src}')">
    <div class="card-head"><span class="badges"><b>${s.id}</b><span class="muted">from #${pad3(s.panelIndex)}</span>
      <span class="badge ${s.tier === 'A' ? 'b-art' : 'b-broll'}">${s.tier === 'A' ? 'A people' : 'B b-roll'}</span>
      <span class="badge b-tag">${s.framing.replace('_', ' ')}</span>
      <span class="badge b-video" title="Box shape, width / height. 0.56 = 9:16 sweet spot (up to 7% taller, 0.53, when it shows something whole), 1.78 = 16:9. ${s.screens} screens tall at 16:9.">box ${box.toFixed(2)}</span>
      ${s.dialogueShare > 0 ? `<span class="badge b-text">balloon ${Math.round(s.dialogueShare * 100)}%</span>` : ''}
      ${s.watermarks.length ? `<span class="badge b-tag" title="Site lettering in this shot is blurred in the video image (${s.watermarks.length} line${s.watermarks.length > 1 ? 's' : ''})">watermark blurred</span>` : ''}</span>
      <span class="muted">${s.x1 - s.x0}×${s.y1 - s.y0} · ${s.score}</span></div>
    <div class="img-wrap"><img loading="lazy" width="${s.x1 - s.x0}" height="${s.y1 - s.y0}" src="${src}" alt=""></div>
    <div class="card-foot"><span>${esc(s.why)}</span><span>y ${s.y0}–${s.y1}${sideCrop ? ` · x ${s.x0}–${s.x1}` : ''}</span></div>
  </div>`;
}

function renderShots(): void {
  const m = state.m;
  if (!m) {
    el.shotList.innerHTML = '';
    return;
  }
  const t = encodeURIComponent(m.createdAt);
  el.shotList.innerHTML = m.shots
    .filter((s) => state.shotFilter === 'all' || s.tier === state.shotFilter)
    .map((s) => shotCard(s, m.strip.width, t))
    .join('');
}

function renderIssues(): void {
  const m = state.m;
  const items: { y: number; text: string }[] = [];
  if (m) {
    for (const y of state.bench?.missed ?? []) items.push({ y, text: `Missed cut (labelled) @ ${y}` });
    for (const y of state.bench?.extra ?? []) items.push({ y, text: `Extra cut (not labelled) @ ${y}` });
    for (const r of m.checks.uncoveredRuns) items.push({ y: r.y0, text: `Uncovered rows ${r.y0}–${r.y1}` });
    for (const p of m.panels) {
      if (isArt(p) && !p.shotIds.length) items.push({ y: p.y0, text: `No shot #${pad3(p.index)}: ${SKIP_TEXT[p.videoSkip ?? 'no_focus']}` });
      if (p.tall) items.push({ y: p.y0, text: `Tall panel #${pad3(p.index)} (${p.y1 - p.y0}px)` });
    }
    for (const s of m.shots) {
      if (s.watermarks.length) items.push({ y: s.y0, text: `Watermark blurred in ${s.id}` });
      if (s.dialogueShare >= 0.05) items.push({ y: s.y0, text: `Balloon ${Math.round(s.dialogueShare * 100)}% in ${s.id}` });
    }
  }
  items.sort((a, b) => a.y - b.y);
  el.issueSelect.innerHTML =
    `<option value="">${items.length ? `Jump to issue (${items.length})` : 'No issues'}</option>` +
    items.map((i) => `<option value="${i.y}">${esc(i.text)}</option>`).join('');
}

// ---------------------------------------------------------------- focus & scroll sync

const programmatic = new Map<HTMLElement, number>();
function scrollLane(lane: HTMLElement, top: number): void {
  programmatic.set(lane, performance.now());
  lane.scrollTop = Math.max(0, top);
}

function scrollStripTo(y: number): void {
  if (!state.m) return;
  scrollLane(el.lane1, el.stage.offsetTop + y * stripScale() - el.lane1.clientHeight * 0.3);
}

function cardFor(list: HTMLElement, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const c of list.querySelectorAll<HTMLElement>('.card')) {
    const y0 = Number(c.dataset.y0);
    const y1 = Number(c.dataset.y1);
    const d = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    if (d < bestD) {
      best = c;
      bestD = d;
    }
    if (d === 0) break;
  }
  return best;
}

function focusPanel(id: string, from: 'strip' | 'reader' | 'shots'): void {
  const p = state.m?.panels.find((q) => q.id === id);
  if (!p) return;
  state.active = id;
  for (const n of document.querySelectorAll('.card.active, .hit.active')) n.classList.remove('active');
  el.stage.querySelector(`.hit[data-id="${id}"]`)?.classList.add('active');
  const rc = el.readerList.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  const shotCards = [...el.shotList.querySelectorAll<HTMLElement>(`.card[data-id="${id}"]`)];
  for (const c of shotCards) c.classList.add('active');
  rc?.classList.add('active');
  const vc = shotCards[0] ?? cardFor(el.shotList, p.y0);
  if (from !== 'strip') scrollStripTo(p.y0);
  if (from !== 'reader' && rc) scrollLane(el.lane2, rc.offsetTop - 40);
  if (from !== 'shots' && vc) scrollLane(el.lane3, vc.offsetTop - 40);
}

function laneY(lane: HTMLElement): number | null {
  if (!state.m) return null;
  if (lane === el.lane1) return (lane.scrollTop + lane.clientHeight * 0.3 - el.stage.offsetTop) / stripScale();
  const list = lane === el.lane2 ? el.readerList : el.shotList;
  const mark = lane.scrollTop + lane.clientHeight * 0.3;
  for (const c of list.querySelectorAll<HTMLElement>('.card')) {
    if (c.offsetTop + c.offsetHeight >= mark) {
      const frac = Math.max(0, Math.min(1, (mark - c.offsetTop) / c.offsetHeight));
      return Number(c.dataset.y0) + frac * (Number(c.dataset.y1) - Number(c.dataset.y0));
    }
  }
  return null;
}

function syncFrom(lane: HTMLElement): void {
  if (!state.sync || !state.m) return;
  const t = programmatic.get(lane);
  if (t && performance.now() - t < 200) return;
  const y = laneY(lane);
  if (y === null) return;
  if (lane !== el.lane1) scrollStripTo(y);
  for (const [other, list] of [
    [el.lane2, el.readerList],
    [el.lane3, el.shotList],
  ] as const) {
    if (other === lane) continue;
    const c = cardFor(list, y);
    if (!c) continue;
    const y0 = Number(c.dataset.y0);
    const y1 = Number(c.dataset.y1);
    const frac = y1 > y0 ? Math.max(0, Math.min(1, (y - y0) / (y1 - y0))) : 0;
    scrollLane(other, c.offsetTop + frac * c.offsetHeight - other.clientHeight * 0.3);
  }
}

// ---------------------------------------------------------------- events

el.chapterSelect.addEventListener('change', () => void selectChapter(el.chapterSelect.value));
el.processBtn.addEventListener('click', () => void process(false));
el.rerunBtn.addEventListener('click', () => void process(true));
el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files?.[0];
  if (f) void upload(f);
  el.fileInput.value = '';
});
el.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropZone.classList.add('over');
});
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('over'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) void upload(f);
});
el.labelBtn.addEventListener('click', () => {
  state.labelMode = !state.labelMode;
  el.labelBtn.textContent = `Label cuts: ${state.labelMode ? 'on' : 'off'}`;
  el.labelBtn.classList.toggle('label-on', state.labelMode);
  el.labelBar.hidden = !state.labelMode;
  el.labelStatus.textContent = `${state.labels.length} labels`;
  if (state.labelMode && !state.layers.labels) {
    state.layers.labels = true;
    renderToggles();
  }
  renderStrip();
});
el.seedLabelsBtn.addEventListener('click', () => {
  const m = state.m;
  if (!m) return;
  if (state.labels.length && !confirm(`Replace your ${state.labels.length} labels with the cutter's ${m.panels.length - 1} cuts?`)) return;
  const cuts = [];
  for (let i = 1; i < m.panels.length; i++) cuts.push(Math.round((m.panels[i - 1].contentY1 + m.panels[i].contentY0) / 2));
  setLabels(cuts);
});
el.clearLabelsBtn.addEventListener('click', () => {
  if (state.labels.length && confirm(`Delete all ${state.labels.length} labels for this chapter?`)) setLabels([]);
});
el.issueSelect.addEventListener('change', () => {
  const y = Number(el.issueSelect.value);
  if (!el.issueSelect.value || !state.m) return;
  const p = state.m.panels.find((q) => y >= q.y0 && y < q.y1) ?? state.m.panels.find((q) => q.y0 >= y);
  scrollStripTo(y);
  if (p) focusPanel(p.id, 'strip');
});
el.layoutBtn.addEventListener('click', () => {
  const rows = el.workspace.classList.toggle('rows');
  el.layoutBtn.textContent = `Layout: ${rows ? 'rows' : 'columns'}`;
});
el.syncBtn.addEventListener('click', () => {
  state.sync = !state.sync;
  el.syncBtn.classList.toggle('on', state.sync);
  el.syncBtn.textContent = `Sync scroll: ${state.sync ? 'on' : 'off'}`;
});
el.frameBtn.addEventListener('click', () => {
  const on = el.shotList.classList.toggle('frame-mode');
  el.frameBtn.classList.toggle('on', on);
  el.frameBtn.textContent = `16:9: ${on ? 'on' : 'off'}`;
});
el.toggles.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-layer]');
  if (!chip) return;
  const key = chip.dataset.layer as LayerKey;
  state.layers[key] = !state.layers[key];
  renderToggles();
  renderStrip();
});
el.readerFilters.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
  if (!b) return;
  state.readerFilter = b.dataset.f as ReaderFilter;
  for (const x of el.readerFilters.querySelectorAll('button')) x.classList.toggle('on', x === b);
  renderReader();
});
el.shotFilters.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
  if (!b) return;
  state.shotFilter = b.dataset.t as ShotFilter;
  for (const x of el.shotFilters.querySelectorAll('button')) x.classList.toggle('on', x === b);
  renderShots();
});
el.stage.addEventListener('click', onStageClick);
el.readerList.addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (c?.dataset.id) focusPanel(c.dataset.id, 'reader');
});
el.shotList.addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (c?.dataset.id) focusPanel(c.dataset.id, 'shots');
});
for (const lane of [el.lane1, el.lane2, el.lane3]) lane.addEventListener('scroll', () => syncFrom(lane), { passive: true });

// ---------------------------------------------------------------- start

renderToggles();
try {
  await loadChapters();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  const first = state.chapters.find((c) => c.id === fromHash) ?? state.chapters.find((c) => c.processed) ?? state.chapters[0];
  if (first) await selectChapter(first.id);
  else el.score.innerHTML = '<span class="muted">No chapters found. Upload a .cbz or add folders to data/library.json.</span>';
} catch (err) {
  el.score.innerHTML = `<span class="pill bad">Server error <b>${esc((err as Error).message)}</b></span>`;
}
