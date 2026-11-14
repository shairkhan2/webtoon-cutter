/** Times each detection step on a few windows. Usage: npx tsx scripts/profile-detect.ts <file.cbz> */
import sharp from 'sharp';
import { loadStrip, stripRows } from '../src/core/cbz.ts';
import { config } from '../src/core/config.ts';
import { runDbnet } from '../src/core/detect/dbnet.ts';
import { createDetector, planWindows } from '../src/core/detect/index.ts';
import { runYolo } from '../src/core/detect/yolo.ts';
import { paths } from '../src/core/library.ts';
import { analyzeRows } from '../src/core/rows.ts';

const strip = await loadStrip(process.argv[2]);
const rows = analyzeRows(strip.gray, strip.width, strip.height);
const windows = planWindows(rows.flat, strip.width, strip.height);
console.log(`windows: ${windows.length}, mean height ${Math.round(windows.reduce((s, w) => s + w.y1 - w.y0, 0) / windows.length)}`);
const det = await createDetector(paths.models);
const c = config.detect;
const t = { resize: 0, head: 0, person: 0, textResize: 0, text: 0 };
const W = strip.width;
for (const win of windows.slice(20, 30)) {
  const h = win.y1 - win.y0;
  const r = stripRows(strip, win.y0, win.y1);
  let s = performance.now();
  const sq = await sharp(r, { raw: { width: W, height: h, channels: 3 } }).resize(640, 640, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
  t.resize += performance.now() - s;
  s = performance.now();
  await runYolo(det.head, sq, 640, W, h, c.headConf, c.headIou);
  t.head += performance.now() - s;
  s = performance.now();
  await runYolo(det.person, sq, 640, W, h, c.personConf, c.personIou);
  t.person += performance.now() - s;
  s = performance.now();
  const tw = Math.round(W / 2);
  const th = Math.round(h / 2);
  const sm = await sharp(r, { raw: { width: W, height: h, channels: 3 } }).resize(tw, th, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
  t.textResize += performance.now() - s;
  s = performance.now();
  await runDbnet(det.text, sm, tw, th, c.textHeat, c.textBox, c.textUnclip);
  t.text += performance.now() - s;
}
console.log('ms per window', Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v / 10)])));
await det.release();
