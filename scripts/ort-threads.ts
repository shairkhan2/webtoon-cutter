/** Compare onnxruntime-node settings when three sessions run back to back (the pipeline pattern). */
import * as ort from 'onnxruntime-node';
import { resolveModel } from '../src/core/detect/models.ts';
import { paths } from '../src/core/library.ts';

const files = await Promise.all((['head', 'person', 'text'] as const).map((m) => resolveModel(m, paths.models)));
const yoloIn = new Float32Array(3 * 640 * 640).map(() => Math.random());
const textIn = new Float32Array(3 * 640 * 512).map(() => Math.random());

for (const [label, extra] of [
  ['spinning on (default)', {}],
  ['spinning off', { session: { intra_op: { allow_spinning: '0' } } }],
] as const) {
  const sessions = await Promise.all(
    files.map((f) => ort.InferenceSession.create(f, { executionProviders: ['cpu'], intraOpNumThreads: 8, extra })),
  );
  const run = async () => {
    await sessions[0].run({ images: new ort.Tensor('float32', yoloIn, [1, 3, 640, 640]) });
    await sessions[1].run({ images: new ort.Tensor('float32', yoloIn, [1, 3, 640, 640]) });
    await sessions[2].run({ x: new ort.Tensor('float32', textIn, [1, 3, 640, 512]) });
  };
  await run();
  const t0 = performance.now();
  for (let i = 0; i < 8; i++) await run();
  console.log(label.padEnd(24), `${Math.round((performance.now() - t0) / 8)} ms per window (head+person+text)`);
  await Promise.all(sessions.map((s) => s.release()));
}
