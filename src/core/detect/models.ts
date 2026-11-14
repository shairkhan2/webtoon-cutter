import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as ort from 'onnxruntime-node';

interface ModelSpec {
  repo: string;
  file: string;
}

export const MODELS = {
  head: { repo: 'deepghs/anime_head_detection', file: 'head_detect_v2.0_n/model.onnx' },
  face: { repo: 'deepghs/anime_face_detection', file: 'face_detect_v1.4_n/model.onnx' },
  person: { repo: 'deepghs/anime_person_detection', file: 'person_detect_v1.1_n/model.onnx' },
  text: { repo: 'deepghs/paddleocr', file: 'det/ch_PP-OCRv4_det/model.onnx' },
  readEn: { repo: 'deepghs/paddleocr', file: 'rec/en_PP-OCRv4_rec/model.onnx' },
  readKo: { repo: 'deepghs/paddleocr', file: 'rec/korean_PP-OCRv3_rec/model.onnx' },
} satisfies Record<string, ModelSpec>;

export type ModelName = keyof typeof MODELS;

function hfCacheDir(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  const home = process.env.HF_HOME ?? path.join(os.homedir(), '.cache', 'huggingface');
  return path.join(home, 'hub');
}

/** Look in the Hugging Face cache first (shared with the Python tools), then our own model dir. */
function findCached(spec: ModelSpec, modelDir: string): string | null {
  const snapshots = path.join(hfCacheDir(), `models--${spec.repo.replace('/', '--')}`, 'snapshots');
  if (existsSync(snapshots)) {
    for (const snap of readdirSync(snapshots)) {
      const p = path.join(snapshots, snap, ...spec.file.split('/'));
      if (existsSync(p)) return p;
    }
  }
  const local = path.join(modelDir, spec.repo.replace('/', '__'), ...spec.file.split('/'));
  return existsSync(local) ? local : null;
}

async function download(spec: ModelSpec, modelDir: string): Promise<string> {
  const target = path.join(modelDir, spec.repo.replace('/', '__'), ...spec.file.split('/'));
  const url = `https://huggingface.co/${spec.repo}/resolve/main/${spec.file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (${res.status}) for ${url}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.part`, Buffer.from(await res.arrayBuffer()));
  await rename(`${target}.part`, target);
  return target;
}

export async function resolveModel(name: ModelName, modelDir: string): Promise<string> {
  return resolveFile(MODELS[name], modelDir);
}

/** Any file from a model repo (e.g. a recogniser's dict.txt next to its model.onnx). */
export async function resolveFile(spec: ModelSpec, modelDir: string): Promise<string> {
  return findCached(spec, modelDir) ?? (await download(spec, modelDir));
}

/** The character list of a text-recognition model: blank, dictionary entries, space. */
export async function readDictionary(name: 'readEn' | 'readKo', modelDir: string): Promise<string[]> {
  const spec = MODELS[name];
  const file = await resolveFile({ repo: spec.repo, file: spec.file.replace(/model\.onnx$/, 'dict.txt') }, modelDir);
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return ['<blank>', ...lines.map((l) => l.replace(/\r$/, '')), ' '];
}

export async function openSession(name: ModelName, modelDir: string): Promise<ort.InferenceSession> {
  const file = await resolveModel(name, modelDir);
  return ort.InferenceSession.create(file, {
    executionProviders: ['cpu'],
    intraOpNumThreads: Math.max(1, Math.min(8, os.availableParallelism())),
    // Several sessions run back to back; spinning worker pools starve each other (6x slower).
    extra: { session: { intra_op: { allow_spinning: '0' } } },
  });
}
