import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import type { Rect, Strip } from '../types.ts';
import { readDictionary, openSession } from './models.ts';

export interface Reading {
  text: string;
  conf: number; // mean probability of the kept characters, 0 when nothing was read
}

export interface LineReading {
  en: Reading;
  ko: Reading;
}

export interface Reader {
  read(strip: Strip, box: Rect): Promise<LineReading>;
  release(): Promise<void>;
}

interface Recogniser {
  session: ort.InferenceSession;
  dict: string[];
  height: number;
}

async function openRecogniser(name: 'readEn' | 'readKo', modelDir: string): Promise<Recogniser> {
  const [session, dict] = await Promise.all([openSession(name, modelDir), readDictionary(name, modelDir)]);
  return { session, dict, height: 48 };
}

/** PP-OCR text recogniser (CTC), preprocessing as in imgutils: height 48, (x/255 - 0.5) / 0.5. */
async function recognise(rec: Recogniser, rgb: Buffer, width: number, height: number): Promise<Reading> {
  const h = rec.height;
  const w = Math.max(16, Math.min(1600, Math.round((width * h) / height)));
  const pixels = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(w, h, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer();
  const plane = w * h;
  const data = new Float32Array(plane * 3);
  for (let i = 0, j = 0; i < plane; i++, j += 3) {
    for (let c = 0; c < 3; c++) data[c * plane + i] = (pixels[j + c] / 255 - 0.5) / 0.5;
  }
  const input = new ort.Tensor('float32', data, [1, 3, h, w]);
  const result = await rec.session.run({ [rec.session.inputNames[0]]: input });
  const out = result[rec.session.outputNames[0]];
  const probs = out.data as Float32Array;
  const [, steps, classes] = out.dims as number[];
  let text = '';
  let sum = 0;
  let kept = 0;
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestP = -1;
    for (let c = 0; c < classes; c++) {
      const p = probs[t * classes + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    // Standard CTC decoding: collapse repeats, then drop blanks.
    if (best !== 0 && best !== prev) {
      text += rec.dict[best] ?? '';
      sum += bestP;
      kept++;
    }
    prev = best;
  }
  input.dispose();
  out.dispose();
  return { text: text.trim(), conf: kept ? sum / kept : 0 };
}

export async function createReader(modelDir: string): Promise<Reader> {
  const [en, ko] = await Promise.all([openRecogniser('readEn', modelDir), openRecogniser('readKo', modelDir)]);
  return {
    async read(strip: Strip, box: Rect): Promise<LineReading> {
      const x0 = Math.max(0, Math.floor(box.x0));
      const x1 = Math.min(strip.width, Math.ceil(box.x1));
      const y0 = Math.max(0, Math.floor(box.y0));
      const y1 = Math.min(strip.height, Math.ceil(box.y1));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 4 || h < 4) return { en: { text: '', conf: 0 }, ko: { text: '', conf: 0 } };
      let crop = Buffer.allocUnsafe(w * h * 3);
      for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * strip.width + x0) * 3;
        crop.set(strip.rgb.subarray(src, src + w * 3), y * w * 3);
      }
      let cw = w;
      let ch = h;
      // Vertical lettering (tall boxes) is read after turning it upright, as imgutils does.
      if (h >= 1.5 * w) {
        crop = await sharp(crop, { raw: { width: w, height: h, channels: 3 } }).rotate(90).raw().toBuffer();
        cw = h;
        ch = w;
      }
      const enRead = await recognise(en, crop, cw, ch);
      // Clear English needs no second opinion; this skips the Korean model for most dialogue.
      const letters = (enRead.text.match(/[A-Za-z]/g) ?? []).length;
      if (enRead.conf >= 0.9 && letters >= 3 && letters >= 0.6 * enRead.text.replace(/\s/g, '').length) {
        return { en: enRead, ko: { text: '', conf: 0 } };
      }
      return { en: enRead, ko: await recognise(ko, crop, cw, ch) };
    },
    async release() {
      await Promise.all([en.session.release(), ko.session.release()]);
    },
  };
}
