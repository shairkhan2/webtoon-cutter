/** Library entry point: import this from other projects. */
export { runPipeline, type RunOptions } from './core/pipeline.ts';
export { createDetector, type Detector } from './core/detect/index.ts';
export { benchmark, predictedCuts } from './core/benchmark.ts';
export { config, PIPELINE_VERSION } from './core/config.ts';
export * from './core/types.ts';
