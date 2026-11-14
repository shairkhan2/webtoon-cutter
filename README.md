# Webtoon Cutter

Cuts a webtoon chapter (`.cbz`) into **reader panels** (every panel in order, with dialogue, for
the vision model) and **video shots** (16:9-friendly crops with matcher tags), with a browser
viewer to check and score the result.

To use it from another project (command line, library, output format), see [TOOL.md](TOOL.md).

## Run the viewer

```powershell
npm install
npm start          # builds the viewer, then serves http://127.0.0.1:8787
npm run serve      # serve only (viewer already built)
```

Chapters come from the folders in `data/library.json` (copy `data/library.example.json`; paths
are relative to `data/`) plus anything uploaded in the viewer (`data/uploads/`). Results go to `data/runs/<chapterId>/`, labels to `data/labels/`.

## Output per chapter (`data/runs/<chapterId>/`)

| Path | What it is |
|---|---|
| `reader/pNNN.jpg` | Every panel, full width, in reading order. Credit and promo panels are written too, with `reader: false` in `manifest.json`: skip them. |
| `video/sNNN_pNNN.jpg` | Video shots. A panel gives 0, 1 or more shots. |
| `shots.json` | Matcher export: one entry per shot (below). |
| `manifest.json` | Everything: panels, shots, detections, text lines with readings, checks, timings. |
| `strip/` | The stitched strip in 4000 px chunks (for the viewer). |

### `shots.json` fields

| Field | Meaning |
|---|---|
| `tier` | `A` people shot, `B` b-roll (scenery, objects, effects). Filter B out to use people only. |
| `focus` | `face` · `body` (no face visible: back view, action) · `detail` (drawn scene or object) |
| `framing` | `close_up` · `medium_close` · `medium` · `full` · `wide` (from where the frame ends under the chin) |
| `size`, `screens` | Box size, and its height in 16:9 frames at its width. Shots are meant to be shown whole, fitted to the frame height over a blurred copy (the reference recap layout). Most tall panels give a 9:16 box (`screens` 3.16), at most 7% taller (3.38). |
| `motion` | `pan` when the box is taller than one 16:9 frame, for a project that fills the frame and scrolls instead. |
| `focusPoint` | Where the camera should look (main face, or centre of detail), in shot pixels. |
| `dialogueShare` | Share of the shot covered by balloons on screen (the balloon's own colour inside its zone, plus its lettering; not its bounding box). 0 = text-free. Up to 0.2 in people shots, 0.04 in b-roll. |
| `dialogueLines` | Whole dialogue lines inside (up to 4). Filter on this and `dialogueShare` to drop shots with text. |
| `watermarks` | Site lettering inside the shot, in shot pixels. Already blurred in the video image; listed so you can cover it differently if you like. |
| `score` | Shot quality, roughly 0.3 (weak b-roll) to 1.2 (big clear face, clean frame). |
| `panel`, `readerFile` | The reader panel the shot comes from, to line it up with the script. |

## How a shot is chosen

For each art panel the planner tries many crops (edges at heads, chins, framing lines from chest to
knees, balloon edges and content boundaries, plus fixed windows from 1 frame up to a 9:16 box) and
keeps the best set that does not overlap. A crop is rejected when it:

- cuts a face (the face box must be whole), trims more than 40% of the hair, or ends under the chin
  with too little room (close-ups may end right at the chin);
- cuts through a line of lettering, puts a balloon over a face, or holds too much balloon: more
  than a fifth of the box, or more than 4 lines. When a face is big enough to carry the shot
  (`minFaceHeight`, 8% of the strip width), the balloons must also stay smaller than the subject
  (`maxDialogueVsFace`). A wide shot of small figures is carried by the drawn scene, so only the
  fifth counts. B-roll without people allows only slivers of balloon (`maxDialogueShareBroll`);
- holds an empty stretch, or is more than 7% taller than 9:16;
- has no focus: no face, no body with its head, and too little drawn detail.

Switches (on by default; set to 0 or false to turn off): `bodyCutCost` charges a side crop for the body width it cuts, except a body box that also holds another person's head beside the shown head (a group box) or a body box the detector is less than `bodyCutMinConf` (0.6) sure of; `shortOpenMinConf` turns short low-confidence open text into sfx, which keeps offering the crops and edges of its former zone but protects nothing; `signsAreArt` plans a panel that has no shot a second time with drawn signs counted as detail.

A face, head or body box that pokes a few rows into the panel from its neighbour (less than
`minSubjectInside`, a fifth of the box, inside) belongs to the neighbour and is no subject here.

**Size.** The sweet spot is a 9:16 box (900×1600 at width 900): a shot shows as much of the
panel's art as the box holds. It may be up to 7% taller only when that shows something whole: the
whole panel, a whole stretch of art, or a figure from head to feet. A little balloon does not make
a box shrink: balloons cost a little score, so among equal boxes the one with less text wins.
Settings in `src/core/config.ts`: `sweetBox`, `maxOverSweet`, `overCost`, `artWeight`,
`maxDialogueShare`, `maxDialogueVsFace`, `maxDialogueLines`, `balloonCost`, `lineCost`.

A panel with people only gives a second shot when it has another real face, and only when the two
people are too far apart for one box: neighbouring shots that one box can replace (it shows
everyone in both, see `mergeFloor`) become one shot. A panel without people gives at most one
b-roll shot.

**Leftovers.** When two reader panels touch with no gutter between them (a border or split cut),
the art often runs on across the cut. A b-roll shot that starts right where the neighbouring
panel's shot ends is then the rest of a scene already shown, and is dropped (`videoSkip:
leftover`) unless it stands on its own: score at least `leftoverMinScore` (0.5) and at least
`leftoverMinScreens` (1) frame tall. Between two such b-roll shots, the smaller one goes.

What lettering is comes from **reading it**: readable English is dialogue (protected), Korean or a
huge single word is a sound effect (part of the art), site names and credits are watermarks, and
boxes that read as nothing are ignored.

**Credits, watermarks and promo pages, for any source.** There is no list of scan groups to keep
up to date (checked on test chapters from 15 groups). A line is a site or credit line when it
reads like one: a domain (`xyz.com`, `site . net`, `name.me`), a link word (Discord, Patreon,
Ko-fi, http, www), a one-word group name ending in "scans", "Read at ...", "translated by", or a
credit role (`TL:`, `PR -`, `QC:`, `Typesetter:`). Lettering repeated at the same place on several
pages is a watermark whatever it says.

Among the first 3 and last 5 pages, a page with two promo lines, or one large site banner, is a
credits page. Promo lines are site lines plus promo wording ("read only at", "thanks for reading",
"join our", "exclusively on", "dear readers", recruiting, a list of roles, a group name with
"scans"), the publisher's staff page ("PD / Studio") and the Korean publisher's copyright and staff
lines (저작권, 원작, 각색 ...). Every page after the end promo goes with it (catalogs of the group's
other series), and every page before the start promo. On a page shared with the story, reading
order decides which panels go: at the start, up to the last panel with a promo line; at the end,
from the first one, keeping story balloons. For a group whose watermark is a bare name with no
domain, add the name to `data/sources.json`: `{ "names": ["Some Group"] }`.

**Watermarks in video shots.** Site lettering inside a shot (a corner badge, a logo with its
".com", a "READ AT ..." banner) is blurred in the video image only; reader panels and the strip
keep it. The blur covers the lettering box plus 10% of its height, with a soft edge 25% of its
height wide, so the art around it is untouched (`config.blur`; lower `sigma` for a lighter blur).
A watermark costs a shot nothing, so shots do not shrink or crop art away to avoid one. Lettering
under about 25 px is missed by the half-resolution text pass, so video shots get a second pass at
0.75 scale; there, a line counts as site lettering when it reads like a domain or credit, or when
it is a banner line stacked on one and about as tall ("YOU CAN READ THE CHAPTER ON:" over
"EN-THUNDERSCANS.COM"). That pass adds about 6 s per chapter (9 s at most on the test chapters).

**Pages of another width.** A page much wider or narrower than the rest is a promo banner when it
is landscape or near square (dropped), and story at another resolution when it is tall (resized to
the strip width).

## How reader panels are cut

1. **Gutters**: full-width bands of flat rows. A band only counts when it looks like a real gap:
   white or black (near-white must be neutral, so pale skin is not white), or a coloured band at
   least `minColourGutter` (3% of W) tall. Inside a detected head or body it must be white/black
   or tall (`subjectGutterHeight`). Thin coloured bands are part of a picture: a rail, a strip of
   empty sky between figures, a smooth cheek in a close-up.
2. **Borders**: straight or slanted lines across the full width where touching panels meet,
   verified along their length. The cut takes a quiet row next to the line that misses balloons
   and heads. Artists often draw a balloon across the border: when no row next to the line is
   clear of balloons, the cut goes through the balloon the border runs through, at least
   `borderLetteringClear` (1% of W) from its lettering, so the lettering stays whole in one
   panel. When the lettering itself sits on the border, the two pictures stay one panel.
3. **Splits**: art taller than `maxHeight` (4 W) is cut at the quietest row that misses faces,
   heads and dialogue.

Known limit: a straight object drawn across the whole picture (a crib rail, a table edge, a light
streak) can pass as a border. `scripts/border-continuity.ts` lists borders where the picture runs
on across the line.

## Benchmark

1. In the viewer, turn on **Label cuts** and click the strip where each cut belongs
   (or press **Start from cutter's cuts** and fix the mistakes).
2. The **Benchmark F1** pill updates as you label. Red dashed lines are cuts the cutter missed;
   orange markers are cuts it made that you did not label.
3. From the terminal: `npm run bench` (add `-- --rerun` to re-cut labelled chapters first).

## CLI and tests

```powershell
npm run cut -- "path\to\chapter.cbz"   # or a chapter id, or --all
npm test                               # rule tests (shot framing, lettering, shot selection)
npm run typecheck
```

## Library use

```ts
import { runPipeline } from './src/index.ts';
const manifest = await runPipeline({ cbzPath, outDir, chapterId, modelDir });
```

## Models (CPU, onnxruntime-node)

| Model | Used for |
|---|---|
| `head_detect_v2.0_n` | heads (with hair) |
| `face_detect_v1.4_n` | faces (eyebrows to chin): the "never cut a face" rule |
| `person_detect_v1.1_n` | bodies |
| `ch_PP-OCRv4_det` | where lettering is |
| `en_PP-OCRv4_rec`, `korean_PP-OCRv3_rec` | what the lettering says |

All are read from the Hugging Face cache if present, else downloaded once to `data/models/`.
About 35–50 s per chapter on CPU.

## Debug scripts (`scripts/`)

- `render.ts <chapterId> <y0> <y1> <out.jpg> [scale] [--replan]`: strip region with every
  decision drawn on it (`--replan`: the shots from `replan.json`)
- `shot-report.ts <chapterId> [y...]`: art panels without shots and why; or the shots of given rows
- `shot-sheet.ts <chapterId|all> <out.jpg> <1-40 | A | B | #10,#11>`: contact sheet of shots
- `replan.ts <chapterId|all>`: re-plans shots with the current rules from saved detections (no
  models, a few seconds per chapter) into `replan.json`, and prints what changed
- `variants.ts [chapterId|all] [outDir]`: dry run of the rule switches (round 1: base, r1, r1b, r1both, r2a, r2b, r3, all; round 2: base, r1g, r2ac, r3f, pick via `variants.ts <id|all> <outDir> r2`) from saved detections; writes `replan-<variant>.json` per chapter and a report (`variants-report.json`, round 2: `variants-report-r2.json`). `frame-sheet.ts ... --variant=<name>` reads that file
- `frame-sheet.ts <chapterId|all> <out.jpg> [--variant=<name>] [--base=<name>: OLD column from replan-<name>.json instead of manifest.json] <#3,#7 | changed:N | multi | sample:N[:offset] | balloon:N | over:N | gained:N[:offset] | lost:N[:offset] | from=list.json[=N[=offset]]>`:
  old vs re-planned shots per panel, drawn as 16:9 frames in the reference layout (`=` may stand
  for `:`, e.g. `gained=12`)
- `why-no-shot.ts <chapterId|name> <panelIndex>...`: tries every box on a 16 px grid in an art
  panel without a shot and tallies which rule stopped each one
- `shot-sizes.ts [chapterId...]`: box shapes, share of each panel kept, panels with 2+ shots
- `why-small.ts [chapterId|all] [share] [-v] [--art]`: shots short of 9:16 in tall panels, and
  what the 9:16 boxes around them ran into
- `leftovers.ts [chapterId|all]`: b-roll shots that meet a neighbouring panel's shot across a
  border or split cut, with how alike the colours are on both sides
- `resegment.ts [chapterId|all] [--sheet out.jpg]`: dry run of panel cutting with the current
  rules from saved detections; lists every cut that would appear or disappear
- `thin-gutters.ts`, `gutter-features.ts`: thin gutter cuts between art panels and their colours
- `border-continuity.ts [--max r] [--sheet out.jpg]`: borders where the picture runs on across
  the line (possible false borders)
- `promo-check.ts [chapterId|all|folder] [--sheet out.jpg]`: first and last pages of each chapter,
  what was read on them, and whether they were taken as credits (green) or story (red)
- `watermark-report.ts [chapterId|all|name]`: watermark lines on story pages and the shots that
  hold them
- `blur-sheet.ts <chapterId|all|name> <out.jpg> [max]`: original next to the blurred video image,
  around each watermark in a shot
- `blur-tune.ts <out.png>`: blur strengths side by side on real watermarks
- `check-images.ts [chapterId|all]`: every reader and video image decodes and has the right size
  (a run that was killed can leave zero-filled files; re-cut those chapters)
- `panel-facts.ts <chapterId> <panelIndex>...`: detections, readings and shots of panels
- `ablate-face.ts`: shots with and without the face model, from saved detections
- `parity.ts` / `parity.py`: compares detector output with the Python imgutils reference
