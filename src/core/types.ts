/** Axis-aligned rectangle in strip pixel coordinates. x1/y1 are exclusive. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageInfo {
  index: number; // 1-based position inside the archive
  file: string;
  y0: number;
  y1: number;
  width: number; // original width before any resize
}

export interface SkippedPage {
  index: number;
  file: string;
  width: number;
  height: number;
  reason: string;
}

/** The stitched chapter. `rgb` is packed RGB (a Node Buffer at runtime), `gray` is BT.601 luma. */
export interface Strip {
  width: number;
  height: number;
  rgb: Uint8Array;
  gray: Uint8Array;
  pages: PageInfo[];
  skipped: SkippedPage[];
}

/** head = hair included; face = eyebrows to chin (much tighter); person = whole visible body. */
export type DetectionKind = 'head' | 'face' | 'person' | 'text';

export interface Detection extends Rect {
  kind: DetectionKind;
  score: number;
}

/**
 * One OCR line after classification.
 * - text: dialogue or narration (reads as English words). Protected and kept out of video.
 * - sfx: sound-effect lettering drawn into the art (Korean, or very large). Part of the art.
 * - watermark: site name, URL, credit, or lettering repeated on several pages.
 * - noise: the detector fired but nothing is readable (face strokes, hair, texture). Ignored.
 */
export type TextLineKind = 'text' | 'sfx' | 'watermark' | 'noise';

export interface TextLine extends Rect {
  score: number;
  kind: TextLineKind;
  /** What the English reader saw, and why the line got its kind. */
  read: string;
  readConf: number;
  /** What the Korean reader saw (publisher credit and copyright lines are in Korean). */
  readKo?: string;
  why: string;
  bg: number; // dominant gray level of the box's outer frame
  bgFrac: number; // share of the outer frame at that level
  inkFrac: number; // share of the box contrasting with it
  /**
   * Set on a line that R2a (config.text.shortOpenMinConf) turned from dialogue into sfx/noise: the
   * zone of the block it was in. The planner still offers the crops and edges that zone offered
   * (side crops around it, edges above and below it), but it protects nothing.
   */
  formerZone?: Rect;
}

/** A group of dialogue lines and the zone a cut must not cross. */
export interface TextBlock {
  id: number;
  lines: number[]; // indices into the text line list
  text: Rect; // union of the lines
  bubble: Rect | null; // traced balloon interior + outline, when the balloon is enclosed
  zone: Rect; // protected area: bubble, or padded text when no enclosed balloon was found
}

/** A straight panel border that spans the strip width. y is given at x = 0 and x = width. */
export interface FrameLine {
  yLeft: number;
  yRight: number;
  kind: 'stroke' | 'edge';
  score: number;
}

export interface Interval {
  y0: number;
  y1: number;
}

export type CutKind = 'start' | 'end' | 'gutter' | 'border' | 'split';
/** credits = scanlation credit or promo page: excluded from reader and video. */
export type PanelRole = 'art' | 'art_text' | 'text' | 'decor' | 'credits';

export interface Panel {
  id: string;
  index: number;
  y0: number;
  y1: number;
  /** Rows that hold the panel's content; [y0, y1) minus the gutter margin. */
  contentY0: number;
  contentY1: number;
  role: PanelRole;
  reader: boolean;
  top: CutKind;
  bottom: CutKind;
  heads: number;
  persons: number;
  textBlocks: number;
  artFrac: number;
  pages: number[];
  tall: boolean;
  /** Video shots cut from this panel, in reading order. */
  shotIds: string[];
  /** Why an art panel has no video shot. */
  videoSkip?: ShotReject;
}

/** Why a candidate shot was not usable. */
export type ShotReject =
  | 'too_small'
  | 'too_long'
  | 'crosses_border'
  | 'cuts_face'
  | 'cuts_head'
  | 'cuts_chin'
  | 'dialogue_on_face'
  | 'too_much_dialogue'
  | 'dialogue_text'
  | 'empty_stretch'
  | 'no_focus'
  | 'credits'
  /** The rest of a scene the neighbouring panel's shot already shows (no gutter between them). */
  | 'leftover';

/**
 * What makes the shot worth showing.
 * face: a whole face · body: a body without a usable face (back view, action) ·
 * detail: drawn objects, hands, rooms, scenery · effect: magic, explosions, glow (no line art)
 */
export type ShotFocus = 'face' | 'body' | 'detail' | 'effect';
/** Film shot size for people, from where the bottom edge sits relative to the chin. */
export type ShotFraming = 'close_up' | 'medium_close' | 'medium' | 'full' | 'wide';

/** One video shot: a crop of the strip plus what the matcher needs to choose and frame it. */
export interface Shot extends Rect {
  id: string;
  index: number;
  panelId: string;
  panelIndex: number;
  file: string;
  /** A = people shot, B = b-roll (scenery, objects, effects). */
  tier: 'A' | 'B';
  score: number;
  focus: ShotFocus;
  framing: ShotFraming;
  motion: 'still' | 'pan';
  /** Height in 16:9 frames at the shot's width (1 = fits one frame; more = camera pans). */
  screens: number;
  /** Where the camera should look: the main face, or the centre of interest. */
  focusPoint: { x: number; y: number };
  faces: number;
  people: number;
  /** Share of the shot covered by dialogue zones (0 = text-free). */
  dialogueShare: number;
  /** Dialogue lines at least half inside the shot. */
  dialogueLines: number;
  sfxShare: number;
  emptyShare: number;
  /** Watermark boxes inside the shot, for blurring. */
  watermarks: Rect[];
  pages: number[];
  why: string;
}

export interface Checks {
  uncoveredRows: number;
  uncoveredRuns: Interval[];
  readerCutsThroughHeads: number;
  readerCutsThroughText: number;
  readerCutsThroughBalloonPixels: number;
  /** Shots holding a dialogue line at least half inside. */
  shotsWithDialogueLines: number;
  /** Shots whose edge cuts through a face (10-90% of the face box inside). Should be 0. */
  shotEdgesThroughFaces: number;
}

export interface BenchmarkResult {
  labelCuts: number;
  predictedCuts: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
  missed: number[]; // label cuts with no predicted boundary (merged panels)
  extra: number[]; // predicted boundaries with no label (over-split)
  tolerancePx: number;
}

export interface Labels {
  chapterId: string;
  cuts: number[];
  updatedAt: string;
}

export interface ChunkInfo {
  file: string;
  y0: number;
  y1: number;
}

export interface Manifest {
  pipelineVersion: string;
  source: { file: string; chapterId: string; bytes: number };
  strip: { width: number; height: number; chunks: ChunkInfo[] };
  pages: PageInfo[];
  skippedPages: SkippedPage[];
  detections: Detection[];
  textLines: TextLine[];
  textBlocks: TextBlock[];
  gutters: Interval[];
  frameLines: FrameLine[];
  panels: Panel[];
  shots: Shot[];
  creditPages: number[];
  checks: Checks;
  counts: Record<string, number>;
  timings: Record<string, number>;
  createdAt: string;
}

export type ProgressFn = (stage: string, fraction: number) => void;
