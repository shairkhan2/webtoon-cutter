import { createDetector, type Detector } from '../core/detect/index.ts';
import { paths, runDir, type ChapterRef } from '../core/library.ts';
import { runPipeline } from '../core/pipeline.ts';

export type JobState = 'queued' | 'running' | 'done' | 'error';

export interface JobStatus {
  state: JobState;
  stage: string;
  fraction: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** One chapter at a time; the detector sessions stay loaded between jobs. */
export class JobQueue {
  private readonly status = new Map<string, JobStatus>();
  private readonly queue: ChapterRef[] = [];
  private running = false;
  private detector: Promise<Detector> | null = null;

  get(id: string): JobStatus | undefined {
    return this.status.get(id);
  }

  enqueue(chapter: ChapterRef): JobStatus {
    const current = this.status.get(chapter.id);
    if (current && (current.state === 'queued' || current.state === 'running')) return current;
    const s: JobStatus = { state: 'queued', stage: 'queued', fraction: 0 };
    this.status.set(chapter.id, s);
    this.queue.push(chapter);
    void this.pump();
    return s;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        const s = this.status.get(job.id)!;
        s.state = 'running';
        s.startedAt = new Date().toISOString();
        try {
          this.detector ??= createDetector(paths.models);
          await runPipeline({
            cbzPath: job.file,
            outDir: runDir(job.id),
            chapterId: job.id,
            modelDir: paths.models,
            detector: await this.detector,
            log: (msg) => console.log(`[${job.id}] ${msg}`),
            progress: (stage, fraction) => {
              s.stage = stage;
              s.fraction = fraction;
            },
          });
          s.state = 'done';
          s.stage = 'done';
          s.fraction = 1;
        } catch (err) {
          s.state = 'error';
          s.error = (err as Error).message;
          console.error(`[${job.id}]`, err);
        }
        s.finishedAt = new Date().toISOString();
      }
    } finally {
      this.running = false;
    }
  }
}
