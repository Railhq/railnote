---
name: railnote-explainers
description: Change, fix or add the animated openCanviz explainers in this Railnote vault (.canviz files, ```canviz blocks and ![[name.canviz]] embeds). Use when asked to edit an explainer in a note, for example "slow down the CDN explainer", "add a step about cache misses", "fix the explainer that shows an error", "rename the box", or "make an explainer for this note".
---

# Explainers in this vault

An explainer is openCanviz JSON that Railnote plays inside a note. Each one lives in one of three places:

- **A file of its own**, usually `Explainers/<name>.canviz`, embedded in a note as `![[name.canviz]]` or as a block:
  ````
  ```canviz
  src: Explainers/name.canviz
  autoplay: true
  ```
  ````
  Block options: `autoplay`, `loop`, `captions` (true or false) and `speed` (1 is normal).
- **Inline**: the JSON itself between the ```` ```canviz ```` fences. Keep inline explainers small; move one into its own file once it grows past a screen.

To find them: `grep -rln '```canviz\|\.canviz' --include='*.md' .` and `find . -name '*.canviz' -not -path './.trash/*'`.

Railnote watches the vault. When you save a `.canviz` file or the note holding an inline one, the open note redraws the explainer at the same moment of playback, so the user sees your change about a second later. If your file is broken, Railnote keeps showing the last version that played, with the problem written above it.

## How to make a change

1. Read the whole file first. Work out which step and which node ids the request is about from `caption`, `text` and `label` fields.
2. Change as little as you can. Keep every existing `id`: steps, edges and actions point at nodes by id, and an edit that renames one breaks them.
3. Write the file back as plain JSON: no comments, no trailing commas. Keep the formatting the file already has.
4. Check it: `node .claude/skills/railnote-explainers/check.mjs <file>` (or pass the note, which checks every inline block in it). It prints `ok` or what to fix, the same message Railnote would show. Fix and check again until it says `ok`.
5. Tell the user what changed in a sentence or two, by step and caption, not by JSON path.

Never edit files under `.railnote/`, `.obsidian/` or `.trash/`, and don't touch notes the request isn't about.

## The shape of the JSON

A one-scene explainer:

```json
{
  "artboard": { "x": -960, "y": -540, "width": 1920, "height": 1080, "background": "#0f172a" },
  "nodes": [ ...every node, as in step 0... ],
  "edges": [ ...every edge, as in step 0... ],
  "steps": [
    { "durationMs": 2500, "caption": "...", "nodes": [ ...all nodes in full... ], "edges": [ ... ], "actions": [] },
    { "delta": true, "durationMs": 2500, "caption": "...", "nodes": [ { "id": "api", "opacity": 1 } ], "edges": [], "actions": [ ... ] }
  ]
}
```

A file exported from opencanviz.com may instead hold several scenes: `"diagrams": [ { "nodes", "edges", "steps" }, ... ]` plus `title`, `artboard` and `transitions` at the top. Railnote plays the scenes one after another, with cuts between them. Ids only need to be unique within a scene.

Rules that matter most when editing:

- Step 0 lists every node and edge in full; things that appear later sit at `"opacity": 0` (nodes) or `"trim": 0` (edges). Every later step has `"delta": true` and lists only `id` plus the fields that change. Changes carry forward.
- A node is `{"id", "kind", "x", "y", "w", "h", ...}` with `kind` one of `rect`, `text`, `circle`, `cylinder`, `diamond`, `svg` and others. `x`, `y` is the top-left corner. Box text is `label`; a text node's is `text`.
- An edge is `{"id", "from", "to", ...}`; `from` and `to` are node ids in the same scene. Line width is `width`, not `strokeWidth`. Add `"animationStyle": "none"` unless the line should keep moving.
- `durationMs` is per step, in milliseconds. Inside a step, actions start at `offsetMs` and run for their own `durationMs`; keep `offsetMs + durationMs` within the step.
- To reveal a node in a step: set `"opacity": 1` on it in that step's `nodes` **and** add `{"type": "visibility", "target": {"kind": "node", "id": "..."}, "mode": "fadeIn", "durationMs": 400}`. To draw an edge in: `"trim": 1` in the step's `edges` and `{"type": "edgeTween", "target": {"kind": "edge", "id": "..."}, "from": {"trim": 0}, "to": {"trim": 1}, "durationMs": 700}`.
- To move or recolour a node: the new `x`/`y`/`fill` in the delta step plus a short `transformTween` with the same end values (`from.x` and `from.y` are ignored).
- Colours are hex strings. Easings are exact strings: `linear`, `ease`, `ease-in`, `ease-out`, `spring`, `bounce`, `back`, `step`.

## Common requests

| Asked for | Do this |
| --- | --- |
| Slower or faster | Scale every step's `durationMs`, and the `offsetMs` and `durationMs` of its actions, by the same factor. For playback only, set `speed:` on the block instead and leave the file alone. |
| Add a step | Append a delta step after the one it follows, with its own `caption`. New nodes go into step 0 (and the scene's `nodes`) at `"opacity": 0`, then get revealed in the new step. |
| Remove a step | Delete it, then move any change it made that later steps rely on into the step before. |
| Rename or reword | Change `label`, `text` or `caption` in the step where it first appears; later delta steps inherit it unless they set it again. |
| Fix an error shown in the note | Run the checker, read its message, fix that spot. Missing node ids and stray commas are the usual causes. |
| A new explainer | Write `Explainers/<name>.canviz` and add `![[<name>.canviz]]` to the note. For anything beyond a few boxes and arrows (charts, code walkthroughs, timelines, math, narration), install the full openCanviz authoring skill with `npx skills add opencanviz/opencanviz-skills-repo`, which has the complete schema, a Python builder, layout rules and examples. |

Narration clips (`narration`) are kept in the file but Railnote doesn't voice them; captions show when the block has `captions: true`.
