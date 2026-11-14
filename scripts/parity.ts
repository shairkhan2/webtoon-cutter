/**
 * Detector parity check: runs the TS detectors on one strip window, saves the window as PNG and
 * prints the boxes so the same PNG can be fed to imgutils (scripts/parity.py).
 * Usage: npx tsx scripts/parity.ts <file.cbz> <y0> <y1> <out.png>
 */
import sharp from 'sharp';
import { loadStrip, stripRows } from '../src/core/cbz.ts';
import { config } from '../src/core/config.ts';
import { runDbnet } from '../src/core/detect/dbnet.ts';
import { createDetector } from '../src/core/detect/index.ts';
import { runYolo } from '../src/core/detect/yolo.ts';
import { paths } from '../src/core/library.ts';

const [file, a, b, out] = process.argv.slice(2);
const strip = await loadStrip(file);
const y0 = Number(a);
const y1 = Number(b);
const w = strip.width;
const h = y1 - y0;
const rows = stripRows(strip, y0, y1);
await sharp(rows, { raw: { width: w, height: h, channels: 3 } }).png().toFile(out);

const det = await createDetector(paths.models);
const c = config.detect;
const img = sharp(out);
const square = await img.clone().resize(c.yoloSize, c.yoloSize, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
const tw = Math.round(w * c.textScale);
const th = Math.round(h * c.textScale);
const small = await img.clone().resize(tw, th, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
const fmt = (bs: { x0: number; y0: number; x1: number; y1: number; score: number }[], s = 1) =>
  bs.map((q) => [q.x0 / s, q.y0 / s, q.x1 / s, q.y1 / s].map(Math.round).join(',') + ` ${q.score.toFixed(2)}`);
console.log('head', fmt(await runYolo(det.head, square, c.yoloSize, w, h, c.headConf, c.headIou)));
console.log('person', fmt(await runYolo(det.person, square, c.yoloSize, w, h, c.personConf, c.personIou)));
console.log('text', fmt(await runDbnet(det.text, small, tw, th, c.textHeat, c.textBox, c.textUnclip), c.textScale));
await det.release();
