import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_VERSION } from './config.ts';
import type { Labels, Manifest } from './types.ts';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where inputs come from and outputs go. Override with environment variables. */
export const paths = {
  data: path.resolve(process.env.WSC_DATA ?? path.join(PACKAGE_DIR, 'data')),
  get uploads() {
    return path.join(this.data, 'uploads');
  },
  get runs() {
    return path.join(this.data, 'runs');
  },
  get labels() {
    return path.join(this.data, 'labels');
  },
  get models() {
    return path.join(this.data, 'models');
  },
  /**
   * Folders scanned for .cbz files: WSC_LIBRARY (separated by ';' on Windows, ':' elsewhere),
   * else the "folders" array in data/library.json (relative paths resolve from data/).
   */
  library(): string[] {
    const fromEnv = process.env.WSC_LIBRARY?.split(path.delimiter).filter(Boolean);
    if (fromEnv) return fromEnv.map((p) => path.resolve(p));
    const file = path.join(this.data, 'library.json');
    if (!existsSync(file)) return [];
    try {
      const { folders } = JSON.parse(readFileSync(file, 'utf8')) as { folders?: string[] };
      return (folders ?? []).map((p) => path.resolve(this.data, p));
    } catch (err) {
      throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
    }
  },
  viewerDist: path.join(PACKAGE_DIR, 'viewer', 'dist'),
};

export interface ChapterRef {
  id: string;
  name: string;
  file: string;
  bytes: number;
  source: 'upload' | 'library';
}

/** Stable id from the file name and size: readable slug + short hash. */
export function chapterId(file: string, bytes: number): string {
  const base = path.basename(file, path.extname(file));
  const slug = base.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'chapter';
  const hash = createHash('sha1').update(`${base.toLowerCase()}:${bytes}`).digest('hex').slice(0, 8);
  return `${slug}_${hash}`;
}

export function listChapters(): ChapterRef[] {
  const seen = new Map<string, ChapterRef>();
  const scan = (dir: string, source: ChapterRef['source']) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.toLowerCase().endsWith('.cbz')) continue;
      const file = path.join(dir, name);
      const bytes = statSync(file).size;
      const id = chapterId(file, bytes);
      if (!seen.has(id)) seen.set(id, { id, name, file, bytes, source });
    }
  };
  for (const dir of paths.library()) scan(dir, 'library');
  scan(paths.uploads, 'upload');
  return [...seen.values()];
}

export const runDir = (id: string) => path.join(paths.runs, id);

export async function readManifest(id: string): Promise<Manifest | null> {
  const file = path.join(runDir(id), 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(await readFile(file, 'utf8')) as Manifest;
    return m.pipelineVersion === PIPELINE_VERSION ? m : null;
  } catch {
    return null;
  }
}

export async function readLabels(id: string): Promise<Labels | null> {
  const file = path.join(paths.labels, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8')) as Labels;
}

export async function writeLabels(id: string, cuts: number[]): Promise<Labels> {
  const clean = [...new Set(cuts.map((c) => Math.round(c)).filter((c) => Number.isFinite(c) && c > 0))].sort(
    (a, b) => a - b,
  );
  const labels: Labels = { chapterId: id, cuts: clean, updatedAt: new Date().toISOString() };
  await mkdir(paths.labels, { recursive: true });
  await writeFile(path.join(paths.labels, `${id}.json`), JSON.stringify(labels, null, 2));
  return labels;
}
