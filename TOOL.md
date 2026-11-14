# Using webtoon-cutter from another project

webtoon-cutter takes one webtoon chapter (`.cbz`) and writes two things into a folder:

- **Reader panels**: every panel in reading order, with its dialogue, for a vision model that
  writes the script.
- **Video shots**: crops sized for 16:9 recap videos, with a `shots.json` that says what each shot
  shows, how much balloon it holds and where the camera should look.

It runs on the CPU only. It works on any series without tuning: every size rule is a fraction of
the strip width.

## Install

Requires Node 22 or later (tested on Node 24, Windows).

```bash
git clone https://github.com/shairkhan2/webtoon-cutter.git
```

```bash
cd webtoon-cutter && npm install
```

The six models (head, face and person detectors, text detector, English and Korean readers) are
downloaded from Hugging Face on the first run. The tool looks in the Hugging Face cache first
(`HF_HOME` or `HF_HUB_CACHE`, default `~/.cache/huggingface/hub`), then in `data/models/`, and
downloads into `data/models/` when neither has them.

## Run one chapter

```bash
npm run cut -- "path/to/chapter.cbz" --out "path/to/output"
```

- `--out` works with one input only. Without it, the output goes to `data/runs/<chapterId>/`,
  where `chapterId` is the file name plus a short hash of the name and size.
- The command exits with code 0 when the chapter is done and 1 on any error.
- Time per chapter on the test machine: 9 s for 20 pages, 56 s for 118 pages, 102 s for 337 pages.
  Most of it is detection.
- A new run into the same folder deletes the old `reader/`, `video/` and `strip/` images first.
- **Don't kill a run halfway.** It leaves images that are zero-filled or missing. If a run was
  stopped, delete the output folder and run again. To be safe, write into a temporary folder and
  rename it when the command exits with 0.

## Use it as a library

Add it to your project from GitHub, with `tsx`:

```bash
npm install github:shairkhan2/webtoon-cutter tsx
```

The source is TypeScript and is not compiled, so run your code with `tsx`
(`npx tsx main.ts`, or `node --import tsx main.ts`). Plain `node` refuses TypeScript inside
`node_modules`.

```ts
import path from 'node:path';
import { createDetector, runPipeline } from 'webtoon-cutter/src/index.ts';

const chapters = ['path/to/chapter-1.cbz', 'path/to/chapter-2.cbz'];
const name = (cbzPath: string) => path.basename(cbzPath, '.cbz');

// Load the models once and reuse them for every chapter.
const detector = await createDetector('path/to/models');
try {
  for (const cbzPath of chapters) {
    const manifest = await runPipeline({
      cbzPath,
      outDir: `out/${name(cbzPath)}`,
      chapterId: name(cbzPath), // any id you like; it is written into the outputs
      modelDir: 'path/to/models',
      detector,
      progress: (stage, fraction) => {}, // load, analyze, detect, read, layout, banners, write, done
      log: console.log,
    });
    console.log(manifest.counts.shots, 'shots');
  }
} finally {
  await detector.release();
}
```

Run one chapter at a time per detector. Each model uses up to 8 CPU threads.

`runPipeline` resolves with the same object it writes to `manifest.json`. `config` and
`PIPELINE_VERSION` are exported too, and so are all the types (`Shot`, `Panel`, `Manifest`, ...).

## What the output folder holds

| Path | What it is |
|---|---|
| `shots.json` | One entry per video shot, everything needed to pick and frame it (below). |
| `video/sNNN_pNNN.jpg` | The video shots. A panel gives 0, 1 or more. |
| `reader/pNNN.jpg` | Every panel, full width, in reading order. |
| `manifest.json` | Everything: panels, shots, detections, text lines and their readings, checks, timings. |
| `strip/chunk_NNN.jpg` | The whole chapter stitched into one strip, in 4000 px pieces (for the viewer). |

`manifest.json` and `shots.json` are written after the images, `shots.json` last.

### Reader panels

They are listed in `manifest.json` under `panels`, in reading order. The image of a panel is
`reader/<id>.jpg`.

| Field | Meaning |
|---|---|
| `id`, `index` | `p001`, 1, ... |
| `role` | `art`, `art_text` (art with balloons), `text` (dialogue only), `decor`, `credits` |
| `reader` | `false` for credit and promo panels. Their images are written too: skip them. |
| `y0`, `y1` | Where the panel sits in the strip, in pixels. |
| `pages` | The `.cbz` pages it comes from. |
| `shotIds` | The video shots cut from it. |
| `videoSkip` | Why an art panel has no shot: `too_much_dialogue`, `empty_stretch`, `no_focus`, `leftover`, ... |

The lettering is in `textLines`, and the dialogue groups and balloons are in `textBlocks`. A text
line's `kind` is `text` (dialogue), `sfx` (sound effect), `watermark` (site or credit lettering)
or `noise`. Its `read` field is the OCR reading the tool uses to classify it. It is rough (mixed
case, missing letters), so have the vision model read the panel image for the script.

### `shots.json`

```json
{
  "chapter": "Vortex Scans_Chapter 1_edb062.cbz",
  "chapterId": "Vortex_Scans_Chapter_1_edb062_d13eac92",
  "pipelineVersion": "ts-2.7.0",
  "stripWidth": 800,
  "shots": [
    {
      "id": "s006",
      "file": "video/s006_p014.jpg",
      "panel": "p014",
      "panelIndex": 14,
      "readerFile": "reader/p014.jpg",
      "tier": "A",
      "score": 0.821,
      "focus": "face",
      "framing": "close_up",
      "motion": "pan",
      "screens": 3.16,
      "rect": { "x0": 0, "y0": 22836, "x1": 800, "y1": 24258 },
      "size": { "width": 800, "height": 1422 },
      "focusPoint": { "x": 380, "y": 948 },
      "faces": 1,
      "people": 1,
      "dialogueShare": 0.122,
      "dialogueLines": 2,
      "sfxShare": 0,
      "watermarks": [],
      "pages": [18, 19],
      "why": "1 face, close up, 12% balloon"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `file`, `readerFile` | Paths relative to the output folder. |
| `panel`, `panelIndex` | The reader panel the shot comes from, to line it up with the script. |
| `tier` | `A` people shot, `B` b-roll (scenery, objects, signs). |
| `focus` | `face`, `body` (a person with no usable face: back view, action) or `detail` (drawn scene or object). |
| `framing` | `close_up`, `medium_close`, `medium`, `full`, `wide`, from where the frame ends under the chin. |
| `score` | Shot quality, from about 0.3 (weak b-roll) to 1.2 (big clear face, clean frame). |
| `rect` | The shot in strip pixels. |
| `size`, `screens` | Shot size, and its height in 16:9 frames at its width. Most tall panels give a 9:16 shot (`screens` 3.16), at most 7% taller (3.38). |
| `motion` | `pan` when the shot is taller than one 16:9 frame, `still` otherwise. |
| `focusPoint` | Where the camera should look (the main face, or the centre of the detail), in shot pixels. |
| `faces`, `people` | Faces and people in the shot. |
| `dialogueShare` | Share of the shot covered by balloons and their lettering. 0 means no balloon was found in it. At most 0.2 in people shots and 0.04 in b-roll. |
| `dialogueLines` | Whole dialogue lines inside the shot (at most 4). |
| `sfxShare` | Share of the shot covered by sound-effect lettering. |
| `watermarks` | Site lettering inside the shot, in shot pixels. It is already blurred in the video image (only there). |
| `pages` | The `.cbz` pages the shot comes from. |
| `why` | A short human-readable summary. |

The shots are made to be shown whole, fitted to the frame height over a blurred copy of
themselves. A project that fills the frame instead can pan down shots with `motion: "pan"` and zoom
toward `focusPoint`.

Pick shots like this:

```ts
const textFree = shots.filter((s) => s.dialogueShare === 0 && s.dialogueLines === 0);
const people = shots.filter((s) => s.tier === 'A');
const best = [...shots].sort((a, b) => b.score - a.score);
```

## Settings and versions

Every rule value is in `src/core/config.ts`, with a note on what it does and what it was measured
on. `pipelineVersion` in the outputs is the version that cut the chapter; compare it with
`PIPELINE_VERSION` to find chapters cut by an older version.

Environment variables:

| Variable | What it sets |
|---|---|
| `HF_HOME`, `HF_HUB_CACHE` | Where to look for cached models. |
| `WSC_DATA` | The `data/` folder (default output, uploads, models, labels). |
| `WSC_LIBRARY` | Chapter folders for the viewer and `cut --all`, separated by `;` on Windows and `:` elsewhere. Otherwise `data/library.json` (copy `data/library.example.json`). |
| `WSC_HOST`, `WSC_PORT` | Where the viewer listens (default `127.0.0.1:8787`). |

To check the results by eye, run the viewer (`npm start`). See [README.md](README.md).

## Known limits

- **Large balloons can be missed in part.** The balloon finder searches 0.3 W around the
  lettering. When a balloon runs further, only the lettering is protected, and a shot can hold
  part of the balloon with a `dialogueShare` of 0. On the 24 test chapters, 96 of 1863 shots had
  at least 2% of their area covered this way. Check the image if a shot must be text-free.
- Very dark scenes can read as empty, so they may get no b-roll shot.
- A short panel that is mostly lettering (a shop sign) gets no b-roll shot.
- A straight object drawn across a whole picture (a rail, a table edge) can pass as a panel
  border and split one picture into two panels.
- Chinese publisher title pages are not recognised as credits, and Chinese site logos are not
  blurred. Banner icons that are not lettering are not blurred either.
