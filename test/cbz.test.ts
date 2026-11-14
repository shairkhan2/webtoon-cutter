import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { loadStrip } from '../src/core/cbz.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function cbz(pages: [number, number][]): Promise<string> {
  const files: Record<string, Uint8Array> = {};
  for (const [i, [w, h]] of pages.entries()) {
    const img = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 40 * i, g: 120, b: 200 } } }).png().toBuffer();
    files[`${String(i + 1).padStart(3, '0')}.png`] = new Uint8Array(img);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wsc-cbz-'));
  dirs.push(dir);
  const file = path.join(dir, 'chapter.cbz');
  await writeFile(file, zipSync(files, { level: 0 }));
  return file;
}

describe('loading pages', () => {
  it('drops a landscape promo banner but keeps tall story pages of another width', async () => {
    // Strip pages 458 wide, two later pages at 800 wide (another resolution), one 1600x900 banner.
    const s = await loadStrip(await cbz([[458, 900], [458, 900], [458, 900], [800, 1250], [800, 1250], [1600, 900]]));
    expect(s.width).toBe(458);
    expect(s.pages.map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);
    expect(s.skipped.map((p) => p.index)).toEqual([6]);
    // The 800-wide pages are resized to the strip width, keeping their shape.
    expect(s.pages[3].y1 - s.pages[3].y0).toBe(Math.round((1250 * 458) / 800));
  });
});
