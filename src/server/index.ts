import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply } from 'fastify';
import { benchmark } from '../core/benchmark.ts';
import { PIPELINE_VERSION } from '../core/config.ts';
import { chapterId, listChapters, paths, readLabels, readManifest, writeLabels } from '../core/library.ts';
import { JobQueue } from './jobs.ts';

const HOST = process.env.WSC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.WSC_PORT ?? 8787);
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

const app = Fastify({ logger: { level: 'warn' } });
const jobs = new JobQueue();

await mkdir(paths.runs, { recursive: true });
await mkdir(paths.uploads, { recursive: true });
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

const findChapter = (id: string) => listChapters().find((c) => c.id === id);
const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found` });

app.get('/api/chapters', async () => {
  const chapters = await Promise.all(
    listChapters().map(async (c) => {
      const m = await readManifest(c.id);
      const labels = await readLabels(c.id);
      const job = jobs.get(c.id);
      return {
        id: c.id,
        name: c.name,
        source: c.source,
        sizeMb: Math.round((c.bytes / 1024 / 1024) * 10) / 10,
        processed: Boolean(m),
        totalSeconds: m?.timings.total_s ?? null,
        labels: labels?.cuts.length ?? 0,
        job: job ?? null,
      };
    }),
  );
  return { pipelineVersion: PIPELINE_VERSION, chapters };
});

app.post<{ Params: { id: string }; Body: { force?: boolean } | undefined }>('/api/chapters/:id/process', async (req, reply) => {
  const c = findChapter(req.params.id);
  if (!c) return notFound(reply, 'Chapter');
  if (!req.body?.force && (await readManifest(c.id))) return { state: 'done', stage: 'done', fraction: 1 };
  return jobs.enqueue(c);
});

app.get<{ Params: { id: string } }>('/api/chapters/:id/status', async (req, reply) => {
  const c = findChapter(req.params.id);
  if (!c) return notFound(reply, 'Chapter');
  return jobs.get(c.id) ?? ((await readManifest(c.id)) ? { state: 'done', stage: 'done', fraction: 1 } : { state: 'new', stage: '', fraction: 0 });
});

app.get<{ Params: { id: string } }>('/api/chapters/:id/manifest', async (req, reply) => {
  const m = await readManifest(req.params.id);
  return m ?? notFound(reply, 'Manifest');
});

app.get<{ Params: { id: string } }>('/api/chapters/:id/labels', async (req) => {
  return (await readLabels(req.params.id)) ?? { chapterId: req.params.id, cuts: [], updatedAt: null };
});

app.put<{ Params: { id: string }; Body: { cuts?: unknown } }>('/api/chapters/:id/labels', async (req, reply) => {
  if (!findChapter(req.params.id)) return notFound(reply, 'Chapter');
  const cuts = req.body?.cuts;
  if (!Array.isArray(cuts) || cuts.length > 5000 || !cuts.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    return reply.code(400).send({ error: 'cuts must be an array of numbers' });
  }
  return writeLabels(req.params.id, cuts as number[]);
});

app.get<{ Params: { id: string } }>('/api/chapters/:id/benchmark', async (req, reply) => {
  const m = await readManifest(req.params.id);
  if (!m) return notFound(reply, 'Manifest');
  const labels = await readLabels(req.params.id);
  return labels?.cuts.length ? benchmark(m.panels, labels.cuts) : null;
});

/** Upload a .cbz into data/uploads and queue it. A chapter already in the library is not copied again. */
app.post('/api/upload', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file' });
  const base = path.basename(file.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!base.toLowerCase().endsWith('.cbz')) {
    file.file.resume();
    return reply.code(400).send({ error: 'Please upload a .cbz file' });
  }
  const tmp = path.join(paths.uploads, `.upload-${process.pid}-${Date.now()}`);
  await pipeline(file.file, createWriteStream(tmp));
  if (file.file.truncated) {
    await rm(tmp, { force: true });
    return reply.code(413).send({ error: 'File too large' });
  }
  const fh = await open(tmp, 'r');
  const head = Buffer.alloc(2);
  const { size } = await fh.stat();
  await fh.read(head, 0, 2, 0);
  await fh.close();
  if (head.toString('latin1') !== 'PK') {
    await rm(tmp, { force: true });
    return reply.code(400).send({ error: 'Not a zip/cbz archive' });
  }
  // Same name and size = same chapter: if it is already in the library (an upload folder or a
  // library folder), use that one and keep no copy. Never overwrite a different file.
  let id = chapterId(base, size);
  if (listChapters().some((ch) => ch.id === id)) await rm(tmp, { force: true });
  else {
    let dest = path.join(paths.uploads, base);
    for (let n = 2; existsSync(dest); n++) {
      dest = path.join(paths.uploads, `${path.basename(base, path.extname(base))} (${n}).cbz`);
    }
    await rename(tmp, dest);
    id = chapterId(dest, size);
  }
  const c = listChapters().find((ch) => ch.id === id);
  if (!c) return reply.code(500).send({ error: `Upload of ${base} was saved but the library scan did not list it` });
  if (await readManifest(c.id)) return { id: c.id, job: { state: 'done', stage: 'done', fraction: 1 } };
  return { id: c.id, job: jobs.enqueue(c) };
});

await app.register(fastifyStatic, { root: paths.runs, prefix: '/files/', decorateReply: false, maxAge: '1h' });
if (existsSync(paths.viewerDist)) {
  await app.register(fastifyStatic, { root: paths.viewerDist, prefix: '/', decorateReply: false });
} else {
  app.get('/', async (_req, reply) =>
    reply.type('text/html').send('<p>Viewer not built. Run <code>npm run build:viewer</code> or <code>npm start</code>.</p>'),
  );
}

await app.listen({ host: HOST, port: PORT });
console.log(`Webtoon cutter viewer: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
console.log(`Library folders: ${[...paths.library(), paths.uploads].join(' | ')}`);
