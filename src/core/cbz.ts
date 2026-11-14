import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { config } from './config.ts';
import type { PageInfo, SkippedPage, Strip } from './types.ts';

const IMAGE_RE = /\.(webp|jpe?g|png|avif|gif|bmp)$/i;

/** Natural sort: "page2" < "page10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

interface PageEntry {
  index: number;
  file: string;
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Read every image in the archive, drop pages whose width is far from the modal width
 * (promo banners, credit cards) and stitch the rest into one continuous strip.
 * Pages that are within the width tolerance are resized to the modal width.
 */
export async function loadStrip(cbzPath: string): Promise<Strip> {
  const archive = unzipSync(new Uint8Array(await readFile(cbzPath)), {
    filter: (f) => !f.name.endsWith('/') && IMAGE_RE.test(f.name) && !f.name.startsWith('__MACOSX'),
  });
  const names = Object.keys(archive).sort(naturalCompare);
  if (!names.length) throw new Error(`No images found in ${cbzPath}`);

  const entries: PageEntry[] = [];
  const skipped: SkippedPage[] = [];
  for (const [i, name] of names.entries()) {
    const data = archive[name];
    try {
      const meta = await sharp(data).metadata();
      if (!meta.width || !meta.height) throw new Error('missing size');
      entries.push({ index: i + 1, file: name, data, width: meta.width, height: meta.height });
    } catch (err) {
      skipped.push({ index: i + 1, file: name, width: 0, height: 0, reason: `unreadable: ${(err as Error).message}` });
    }
  }

  const widthCounts = new Map<number, number>();
  for (const e of entries) widthCounts.set(e.width, (widthCounts.get(e.width) ?? 0) + 1);
  const width = [...widthCounts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];

  const kept: (PageEntry & { outHeight: number })[] = [];
  for (const e of entries) {
    // A page of another width is a promo banner or credit card when it is landscape or near
    // square. A tall page of another width is story at another resolution: resize it.
    const otherWidth = Math.abs(e.width - width) / width > config.load.widthTolerance;
    if (otherWidth && e.height < config.load.bannerMaxAspect * e.width) {
      skipped.push({ index: e.index, file: e.file, width: e.width, height: e.height, reason: 'banner: another width, not a strip page' });
      continue;
    }
    kept.push({ ...e, outHeight: e.width === width ? e.height : Math.round((e.height * width) / e.width) });
  }
  if (!kept.length) throw new Error(`No strip pages left in ${cbzPath}`);

  const height = kept.reduce((s, e) => s + e.outHeight, 0);
  const rgb = Buffer.allocUnsafe(width * height * 3);
  const pages: PageInfo[] = [];
  let y = 0;
  for (const e of kept) {
    let pipe = sharp(e.data, { limitInputPixels: false }).flatten({ background: '#ffffff' }).toColourspace('srgb');
    if (e.width !== width) pipe = pipe.resize(width, e.outHeight, { fit: 'fill', kernel: 'lanczos3' });
    const { data, info } = await pipe.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== e.outHeight || info.channels !== 3) {
      throw new Error(`Decoded ${e.file} as ${info.width}x${info.height}x${info.channels}, expected ${width}x${e.outHeight}x3`);
    }
    data.copy(rgb, y * width * 3);
    pages.push({ index: e.index, file: e.file, y0: y, y1: y + e.outHeight, width: e.width });
    y += e.outHeight;
  }

  return { width, height, rgb, gray: toGray(rgb, width * height), pages, skipped: skipped.sort((a, b) => a.index - b.index) };
}

/** BT.601 luma, the same weights OpenCV and PIL use. */
export function toGray(rgb: Uint8Array, pixels: number): Uint8Array {
  const gray = new Uint8Array(pixels);
  for (let i = 0, j = 0; i < pixels; i++, j += 3) {
    gray[i] = (rgb[j] * 299 + rgb[j + 1] * 587 + rgb[j + 2] * 114 + 500) / 1000;
  }
  return gray;
}

/** Strip rows [y0, y1) as a raw RGB view (no copy). */
export function stripRows(strip: Strip, y0: number, y1: number): Buffer {
  const { buffer, byteOffset } = strip.rgb;
  return Buffer.from(buffer, byteOffset + y0 * strip.width * 3, (y1 - y0) * strip.width * 3);
}
