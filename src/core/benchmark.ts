import type { BenchmarkResult, Panel } from './types.ts';

export interface PredictedCut {
  y0: number; // the boundary can sit anywhere in [y0, y1] (the gutter between two panels)
  y1: number;
}

/** Boundaries between consecutive reader panels. A gutter cut matches anywhere inside the gutter. */
export function predictedCuts(panels: Panel[]): PredictedCut[] {
  const out: PredictedCut[] = [];
  for (let i = 1; i < panels.length; i++) {
    const a = panels[i - 1];
    const b = panels[i];
    out.push({ y0: Math.min(a.contentY1, b.contentY0), y1: Math.max(a.contentY1, b.contentY0) });
  }
  return out;
}

/**
 * Compare predicted cuts with hand-labelled cuts. One-to-one greedy matching by distance;
 * a label matches a prediction when it lies within `tolerancePx` of the predicted gutter.
 */
export function benchmark(panels: Panel[], labelCuts: number[], tolerancePx = 40): BenchmarkResult {
  const pred = predictedCuts(panels);
  const labels = [...labelCuts].sort((a, b) => a - b);
  const pairs: { li: number; pi: number; d: number }[] = [];
  for (const [li, y] of labels.entries()) {
    for (const [pi, c] of pred.entries()) {
      const d = y < c.y0 ? c.y0 - y : y > c.y1 ? y - c.y1 : 0;
      if (d <= tolerancePx) pairs.push({ li, pi, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedL = new Set<number>();
  const usedP = new Set<number>();
  for (const p of pairs) {
    if (usedL.has(p.li) || usedP.has(p.pi)) continue;
    usedL.add(p.li);
    usedP.add(p.pi);
  }
  const matched = usedL.size;
  const precision = pred.length ? matched / pred.length : labels.length ? 0 : 1;
  const recall = labels.length ? matched / labels.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    labelCuts: labels.length,
    predictedCuts: pred.length,
    matched,
    precision: r3(precision),
    recall: r3(recall),
    f1: r3(f1),
    missed: labels.filter((_, i) => !usedL.has(i)),
    extra: pred.filter((_, i) => !usedP.has(i)).map((c) => Math.round((c.y0 + c.y1) / 2)),
    tolerancePx,
  };
}
