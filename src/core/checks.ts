import { crossesY, intersect, runs } from './geometry.ts';
import type { Checks, Detection, Panel, Shot, TextLine } from './types.ts';

/**
 * Checks that do not reuse the cutter's own decisions:
 * - coverage uses a separate, simpler "row has visible content" test;
 * - cut checks use raw head boxes and dialogue lines, not the padded protection zones;
 * - the balloon check looks at the pixels on the cut row for a bright run enclosed by dark walls,
 *   which catches balloons the text detector missed.
 */
export function runChecks(
  gray: Uint8Array,
  width: number,
  height: number,
  panels: Panel[],
  shots: Shot[],
  heads: Detection[],
  faces: Detection[],
  lines: TextLine[],
): Checks {
  const visible = new Uint8Array(height);
  for (let y = 0; y < height; y++) visible[y] = rowHasEdges(gray, width, y) ? 1 : 0;
  for (const p of panels) visible.fill(0, p.y0, p.y1);
  const uncovered = runs(visible).filter((r) => r.y1 - r.y0 >= 4);

  const dialogue = lines.filter((l) => l.kind === 'text');
  const cuts = new Set<number>();
  for (const p of panels) {
    if (p.top !== 'start') cuts.add(p.y0);
    if (p.bottom !== 'end') cuts.add(p.y1);
  }
  let throughHeads = 0;
  let throughText = 0;
  let throughBalloon = 0;
  for (const y of cuts) {
    // A cut on an empty row cannot slice a face, whatever the box says.
    const rowVisible = y > 0 && y < height && rowHasEdges(gray, width, y);
    if (rowVisible && heads.some((h) => crossesY(h, y, 0.1 * (h.y1 - h.y0)))) throughHeads++;
    if (dialogue.some((l) => crossesY(l, y, 2))) throughText++;
    if (rowSlicesBalloon(gray, width, height, y)) throughBalloon++;
  }

  const area = (r: { x0: number; y0: number; x1: number; y1: number }) => (r.x1 - r.x0) * (r.y1 - r.y0);
  let withDialogue = 0;
  let throughFaces = 0;
  for (const s of shots) {
    if (dialogue.some((l) => (intersect(l, s) ? area(intersect(l, s)!) >= 0.5 * area(l) : false))) withDialogue++;
    for (const f of faces) {
      // Only the part of the face inside the shot's panel rows counts.
      const box = { ...f, y0: Math.max(f.y0, s.y0 - 2), y1: Math.min(f.y1, s.y1 + 2) };
      if (box.y1 <= box.y0 || box.y1 - box.y0 < 0.5 * (f.y1 - f.y0)) continue;
      const i = intersect(box, s);
      const share = i ? area(i) / area(box) : 0;
      if (share > 0.1 && share < 0.9) {
        throughFaces++;
        break;
      }
    }
  }

  return {
    uncoveredRows: uncovered.reduce((s, r) => s + r.y1 - r.y0, 0),
    uncoveredRuns: uncovered.slice(0, 50),
    readerCutsThroughHeads: throughHeads,
    readerCutsThroughText: throughText,
    readerCutsThroughBalloonPixels: throughBalloon,
    shotsWithDialogueLines: withDialogue,
    shotEdgesThroughFaces: throughFaces,
  };
}

/** Visible content = local edges. Smooth gradient gutters have a wide range but no edges. */
function rowHasEdges(gray: Uint8Array, width: number, y: number): boolean {
  const row = y * width;
  let edges = 0;
  for (let x = 3; x < width; x += 3) if (Math.abs(gray[row + x] - gray[row + x - 3]) > 24 && ++edges >= 3) return true;
  return false;
}

/** A bright run 0.1W..0.9W wide with dark walls on both sides, on this row and the next few. */
export function rowSlicesBalloon(gray: Uint8Array, width: number, height: number, y: number): boolean {
  if (y < 3 || y > height - 4) return false;
  let hits = 0;
  for (const yy of [y - 2, y, y + 2]) {
    const row = yy * width;
    let x = 0;
    let found = false;
    while (x < width && !found) {
      while (x < width && gray[row + x] <= 230) x++;
      const s = x;
      while (x < width && gray[row + x] > 230) x++;
      const e = x;
      const w = e - s;
      if (w >= 0.1 * width && w <= 0.9 * width && s > 6 && e < width - 6) {
        let left = 255;
        let right = 255;
        for (let k = Math.max(0, s - 24); k < s; k++) left = Math.min(left, gray[row + k]);
        for (let k = e; k < Math.min(width, e + 24); k++) right = Math.min(right, gray[row + k]);
        if (left < 120 && right < 120) found = true;
      }
    }
    if (found) hits++;
  }
  return hits === 3;
}
