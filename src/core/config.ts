/**
 * Every tunable in one place. Geometric values are fractions of the strip width (W)
 * so the same settings work for 690, 720, 800 or 900 px wide series.
 */
export const PIPELINE_VERSION = 'ts-2.7.0';

export const config = {
  load: {
    /**
     * A page whose width differs from the modal width by more than widthTolerance, and whose
     * height is under bannerMaxAspect × its width (landscape or near square), is a promo banner
     * and is dropped. Tall pages of another width are story at another resolution: resized.
     */
    widthTolerance: 0.1,
    bannerMaxAspect: 1.25,
  },
  rows: {
    /** A row is flat when at most this share of pixels deviate from the row median... */
    flatOutlierFrac: 0.006,
    /** ...by more than this many gray levels. */
    flatDeviation: 14,
    /** Smooth gradient rows: no neighbour step larger than this, total range below rangeMax. */
    smoothStep: 5,
    smoothRangeMax: 70,
    /** Shortest run of flat rows that counts as a gutter, in px. */
    minGutterPx: 8,
    /** A pixel counts toward row detail when its gradient exceeds this. */
    detailGradient: 24,
  },
  cells: {
    size: 16,
    /** Cell has content when its gray range exceeds this or its std exceeds stdMin. */
    rangeMin: 24,
    stdMin: 4,
  },
  detect: {
    /** Detection window height as a multiple of W, and the overlap between windows. */
    windowAspect: 1.4,
    overlap: 0.3,
    /** Gaps between content shorter than this (×W) are bridged into one detection region. */
    bridgeGap: 0.5,
    yoloSize: 640,
    headConf: 0.4,
    headIou: 0.7,
    /** imgutils defaults for face_detect_v1.4. */
    faceConf: 0.25,
    faceIou: 0.7,
    personConf: 0.35,
    personIou: 0.5,
    textScale: 0.5,
    textHeat: 0.3,
    textBox: 0.6,
    textUnclip: 2.0,
    /** Boxes of the same kind merge when IoU or intersection/smaller-area exceed these. */
    mergeIou: 0.5,
    mergeContain: 0.75,
  },
  text: {
    /** A line is lettering when this share of its box contrasts with the background by inkContrast. */
    minInkFrac: 0.02,
    maxInkFrac: 0.8,
    inkContrast: 40,
    /**
     * Enclosed region around the lettering is a balloon/box when its gray std is at most
     * balloonFlatStd, or at most balloonMaxStd with an area under balloonMaxAreaRatio × text area.
     */
    balloonFlatStd: 6,
    balloonMaxStd: 16,
    balloonMaxAreaRatio: 12,
    /**
     * Same-size lines at the same x on different pages whose gray thumbnails correlate at least this
     * much are the same lettering (a watermark badge over varying art measured 0.54-0.85; unrelated
     * lines stayed below 0.25).
     */
    watermarkSimilarity: 0.5,
    /** Open lettering is dialogue when this share of its surroundings is background. */
    minRingBg: 0.55,
    bgTolerance: 22,
    /** OCR lines narrower or shorter than this are noise. px at full res. */
    minLinePx: 10,
    /** Lines join a block when the vertical gap is below this many line heights. */
    joinGapLines: 1.15,
    /** A line seen at the same page position on this many pages is a watermark. */
    watermarkPages: 3,
    /** Balloon tracing: tolerance around the background level, and the outline margin (×W). */
    balloonTolerance: 30,
    balloonMargin: 0.012,
    /**
     * Balloon tracing: the search window around the lettering for the balloon fill (x W; never
     * less than the lettering's own height). A fill that touches the window edge means open text
     * (no balloon): its zone is only the lettering padded by `loosePadLines`. Big balloons leak at
     * 0.3 W (Vortex edb062 panel 49, shot s033: the balloon runs y85441-86239, the window ends at
     * y86123, so half the balloon stayed unprotected, dialogueShare 0). Measured on the 24 chapters:
     * of 1252 blocks without a balloon, 381 close and pass isBalloon at a bigger reach (251 at
     * 0.6 W, 130 more only at 1.0 W), and 96 shots have at least 2% of their box covered by a missed
     * balloon. Wrong finds seen: a fake start menu, game system windows, a few art regions.
     * Dry run (2026-11-14), kept at 0.3 by the user's decision. 0.6 W: 8 panels lose every shot (the
     * half balloon over the roof, the pentagon balloon on speed lines: right), 53 shots reshaped, 0
     * gained, but 34 reader cuts removed and 13 added. A balloon drawn against a panel edge hides the
     * border line (frames.ts treats samples near a dialogue zone as hidden), so 24 real borders were
     * no longer verified and the balloon strip merged into the picture. Also wrong: Vortex edb062
     * #219 lost its face shot (the round balloon's rectangle covers a small face in its corner), the
     * fake start menu became a balloon, and the "아" speed-line panel lost its red sfx. 1.0 W: the
     * same plus 54 cuts removed / 36 added and edb062 #42 lost (the fill ran out of the BEEP! box over
     * his head). Not tried: the bigger reach for shot planning only, with reader cuts unchanged.
     */
    balloonReach: 0.3 as number,
    /** Padding around text when no enclosed balloon is found, in line heights (min 12 px). */
    loosePadLines: 0.6,
    /**
     * R2a (0 = off). A block of open text (no traced balloon) whose every line reads as 3 or fewer
     * letters A-Z in the English reader at a confidence below this is not dialogue: a sound effect
     * read as English (edb062 #28: the shutter sound 'ye' at 0.617, Korean reading 'Hangul',
     * became an open-text zone over a girl's face and blocked every box with her). Its lines become
     * sfx (Hangul in the Korean reading) or noise. Test value 0.8. A demoted line keeps its block's zone as `formerZone`: the planner still offers
     * the side crops around it, the edges above and below it and at its lines (Asura ch3 #32 lost a
     * face shot when the crop x0-484 beside the zone of 'JCH' vanished), but it protects nothing: no
     * dialogue_on_face, no cut-through-line reject, no balloon area, no line count.
     */
    shortOpenMinConf: 0.8 as number,
  },
  frames: {
    maxSlope: 0.7,
    /** Minimum share of samples along a line that must look like a border. */
    strokeCoverage: 0.72,
    edgeCoverage: 0.92,
    maxStrokePx: 16,
    strokeContrast: 28,
    edgeContrast: 40,
    /** Ignore lines this close (×W) to the top or bottom of a content piece. */
    pieceMargin: 0.03,
    /** Reject a line when this many similar parallel candidates surround it (speedlines). */
    maxParallel: 3,
    /** Share of the line that must be visible (not behind a balloon) to be verified. */
    minVisible: 0.35,
  },
  panels: {
    /** Gutter margin kept around each panel (px, capped at half the gutter). */
    marginPx: 24,
    /** Soft maximum reader panel height (×W). Taller pieces split at the cheapest safe row. */
    maxHeight: 4.0,
    minSplitHeight: 0.7,
    /** Consecutive text-only pieces closer than this (×W) form one reader panel... */
    textJoinGap: 0.25,
    /** ...as long as the result stays shorter than this (×W). */
    textJoinMaxHeight: 1.6,
    /**
     * A piece without people is scenery art when this share of its cells (outside dialogue) has
     * content and that content covers at least sceneArtArea × W² pixels. Smaller pieces are decor.
     */
    artFrac: 0.1,
    sceneArtArea: 0.12,
    /** Person boxes protect their core; the outer share of the height at each end is soft. */
    personSoftEdge: 0.08,
    /** Inside a head/body, a flat band that is not white/black must be this tall (×W) to be a gutter. */
    subjectGutterHeight: 0.2,
    /**
     * White or black means gutter colour: mean gray <= 24, or >= 232 with no more than this much
     * colour (max - min of the mean RGB). Pale skin (254,243,236) is not white.
     */
    gutterChroma: 14,
    /**
     * A coloured flat band (not white or black) thinner than this (×W) is part of a picture: a rail,
     * a floor line, a strip of sky between figures. Real coloured gutters are taller.
     */
    minColourGutter: 0.03,
    /**
     * A balloon drawn across a border protects every row it covers, so the border could not be
     * cut and two pictures became one panel. At a verified border with no row clear of balloons
     * near the line, the cut may pass through a balloon the border runs through, at least this
     * far (×W) from its lettering; the lettering stays whole in one panel. Other balloons are
     * never cut.
     */
    borderLetteringClear: 0.01,
  },
  /**
   * Video shots. "screen" = one 16:9 frame at the shot's width (0.5625 × shot width).
   * A shot is a box shown whole, fitted to the frame height over a blurred copy of itself, as in
   * the reference recap video. Box shape = width / height.
   */
  shots: {
    frameAspect: 9 / 16,
    minWidth: 0.45, // ×W; narrower shots get too blurry when scaled to 1080p
    minScreens: 0.6, // part of a panel shorter than this needs too much zoom
    minScreensWholePanel: 0.3, // a short wide panel (eyes close-up) is shown whole, letterboxed
    /**
     * Sweet spot (w/h): a 9:16 box, 900×1600 at W = 900, like the reference video's tall panel
     * (0.58). A box may be up to maxOverSweet taller only when that lets it show something whole:
     * the whole panel, a whole stretch of art, or a figure from head to feet. It then loses
     * overCost of its score per unit of extra height, so it stays 9:16 when nothing is gained.
     */
    sweetBox: 9 / 16,
    maxOverSweet: 0.07,
    overCost: 0.1,
    /**
     * Share of a shot's score that depends on how much of the panel's art it shows: rows holding a
     * subject or drawn detail (balloons excluded), compared with the best box of the largest size.
     * This is what makes a shot fill the box instead of stopping at the face.
     */
    artWeight: 0.5,
    /**
     * Score lost when a face shot's bottom edge is not on a framing line (chest, waist, hips, knees
     * under the chin) or a body end. A tie-breaker only: showing more art matters more.
     */
    framingCost: 0.03,
    /**
     * One box rather than two: when two shots of a panel can be replaced by one box that shows
     * every person in both, and that box scores at least this share of the better shot, it wins.
     */
    mergeFloor: 0.8,
    /** Hair above the face may be trimmed by this share of the head box; sides by sideTrim. */
    hairTrim: 0.4,
    sideTrim: 0.2,
    /** Head padding kept above the head when space allows, in face heights. */
    headroom: 0.15,
    /**
     * Bottom edge must sit at least this many face heights under the chin; in an extreme close-up
     * (face taller than closeUpFace of the frame) it may end right at the chin.
     */
    minBelowChin: 0.3,
    minBelowChinCloseUp: 0.05,
    closeUpFace: 0.45,
    /**
     * Dialogue allowed in a shot, measured by what the balloons cover on screen (cells of the
     * balloon's colour inside its zone, plus its lettering), not by their bounding boxes.
     * "A little balloon is fine, a lot of balloon and little face is not": in a people shot
     * balloons may fill a fifth of the box, and when a face is big enough to carry the shot
     * (minFaceHeight) they must also stay under 0.6x the subject (faces plus a quarter of the
     * bodies). In a wide shot the drawn scene carries it, so only the share counts. B-roll (no
     * people) allows only slivers of balloon.
     */
    maxDialogueShare: 0.2,
    maxDialogueVsFace: 0.6,
    maxDialogueShareBroll: 0.04,
    /** Readable dialogue lines allowed inside a shot: about one balloon, never a wall of text. */
    maxDialogueLines: 4,
    /**
     * Score lost per unit of balloon share, and per whole dialogue line inside. Kept small, so a
     * box does not shrink and lose art just to leave a balloon out; among equal boxes, less text wins.
     */
    balloonCost: 0.5,
    lineCost: 0.03,
    /** Clearance around dialogue zones when an edge is placed next to one (×W). Tails point down. */
    padAbove: 0.02,
    padBelow: 0.05,
    padSide: 0.02,
    /** Empty runs (no subject, no drawn detail) longer than this many screens end a shot. */
    maxEmptyScreens: 0.7,
    /** Scenery/objects without people: see interest.ts for how these were measured. */
    detailIso: 0.008,
    detailContrast: 35,
    detailInk: 0.008,
    /** Drawn-detail cells must cover this share of the shot and this many frames' worth of area. */
    minDetailBusy: 0.1,
    minDetailFrames: 0.12,
    /** Shots below these scores are not kept. */
    minScoreA: 0.35,
    minScoreB: 0.28,
    /**
     * Every shot after a panel's first must be worth more than this. Face shots score 0.75-1.1,
     * body-only shots 0.4-0.6, so a second shot needs another real face.
     */
    extraShotCost: 0.55,
    /** Faces shorter than this (×W) are too small to carry a shot on their own: wide framing. */
    minFaceHeight: 0.08,
    /**
     * A face, head or body box with less than this share of its height inside the panel belongs
     * to the neighbouring panel (the detector's box spills a few rows over the border): it is no
     * subject here. Measured on 24 chapters: faces and heads crossing a panel edge have either
     * 1-19% of the box inside (spill) or 70% and more (a real subject cut by the panel edge).
     */
    minSubjectInside: 0.2,
    /** A slanted border may let at most this share of the neighbouring panel into a shot. */
    maxNeighbourShare: 0.1,
    /**
     * Leftovers: a b-roll shot that starts where a neighbouring panel's shot ends, across a border
     * or split (no gutter between), shows the rest of a scene that shot already shows, e.g. an
     * effect running on under a 9:16 box. It is kept only when it stands on its own: at least this
     * score and this many screens tall. Next to another b-roll shot, the smaller one is the leftover.
     */
    leftoverMinScore: 0.5,
    leftoverMinScreens: 1,
    /**
     * R1 (0 = off, test 1.0). A side crop (narrower than W) loses the share of a shown body's width
     * that lies outside it; the score is multiplied by 1 - bodyCutCost x the largest such share.
     * edb062 #25: the crop x308-800 scored 0.994 while leaving out 38% of her body (the hand with
     * the phone); the full-width box scored 0.928.
     * Group guard: a subject's body box is skipped when it holds the centre of another subject's head
     * and that centre lies outside the x range of its own head box (no head: any such centre). Round 1
     * read a man's close-up beside two people (one body box over all three, Vortex 2fcdcb #95, score
     * 0.843 -> 0.46) as a body cut in half. edb062 #25 is still charged: the false head on her neck
     * has its centre inside her own head's x range.
     * Confidence floor (bodyCutMinConf): only a body box the detector is at least this sure of is
     * charged. Vortex 2fcdcb #34: a 0.37 box over a man and the white area beside him made his
     * close-up widen onto a caption and the site logo. Charged boxes in the round-2 dry run were 0.72+.
     */
    bodyCutCost: 1 as number,
    bodyCutMinConf: 0.6 as number,
    /**
     * R1b (false = off). A side crop's art-kept term is multiplied by the busy cells in the crop over
     * the busy cells of the full-width box over the same rows (busy = detail iso/ink >= 0.02 on the
     * lettering-masked map, or inside a face, head or body box). A crop that drops a side holding
     * drawing then no longer counts as keeping all the art.
     */
    sideArtKept: false as boolean,
    /**
     * R2b (false = off). Drop a head detection H when no face is centred in it, its score is below 0.5
     * and a person box holds the centres of H and of another head G with a higher score whose centre
     * is above H's: an object (a coffee cup, edb062 #28, conf 0.45) seen as a head on a real person.
     */
    dropObjectHeads: false as boolean,
    /**
     * R3 (false = off). The b-roll focus test (iso, contrast, centre) reads a second detail map in
     * which sfx and noise lettering outside every dialogue zone is not masked, so a drawn sign counts
     * as art (edb062 #47: a shop sign read as 'EHH' 0.311, iso 0.0026 masked, 0.0129 unmasked, needs
     * 0.008). Dialogue, watermark lines and dialogue zones stay masked, and the busy checks, artKept,
     * busyRows and empty stretches keep the fully masked map, so lettering alone never makes art.
     * Fallback only: a panel is planned with the fully masked map first; only when that gives no shot
     * is it planned again with this map (round 1 used it everywhere and moved 26 existing b-roll shots
     * onto sound effects).
     */
    signsAreArt: true as boolean,
  },
  /**
   * Watermarks in video shots are blurred in the video image only (reader panels keep them),
   * tightly around the lettering so no art is lost: the lettering box padded by `pad` × its
   * height, a soft edge `feather` × its height wide, and a strength of `sigma` × its height.
   */
  blur: {
    sigma: 0.35,
    minSigma: 3,
    pad: 0.1,
    feather: 0.25,
    /**
     * Small corner banners (lettering under ~25 px) are missed by the half-resolution text pass.
     * Video shots get a second pass at this scale; a line found there is a site line when it
     * reads like one at minConf or more.
     */
    scanScale: 0.75,
    minConf: 0.5,
  },
  output: {
    chunkHeight: 4000,
    jpegQuality: 88,
  },
} as const;

export type Config = typeof config;
