# Ascension Talent Calculator — Bronzebeard (Warcraft Reborn)

Interactive talent calculator for the [Ascension](https://ascension.gg) Bronzebeard realm. One class-agnostic engine (`app.js`) renders any class from a data file.

All talents, abilities, Mystic Enchants, tooltips, icons and tree art come from the Ascension game client, extracted by the local datamine (`_asc_extract`, not in this repo). Only the generated runtime files are committed here.

## Structure

```
index.html              shell: loads styles.css, data/classes.js, builds/index.js, app.js (all ?v= stamped)
app.js                  engine: planner, overlays, URL state; FEATURES flags at the top
styles.css              mobile-first; palette in :root
sw.js                   service worker: network-first HTML, cache-first for ?v= versioned files
data/<class>.json       generated class data (talents, layout, trees, enchants, abilities; image paths carry ?v=)
data/classes.js         generated class list (window.ASC_CLASSES, with each data file's ?v= hash)
builds/index.js         generated saved builds (window.ASC_BUILDS)
assets/game/<class>/    generated icons + tree backgrounds
.githooks/pre-commit    re-stamps ?v= tokens (git config core.hooksPath .githooks, once per clone)
tools/
  build-class-data.mjs  extract → data/<class>.json + data/classes.js + assets/game/<class>/
  class-meta.json       class and tree accent colours (site styling)
  build-index.mjs       validates builds/ and writes builds/index.js
  encode-build.mjs      allocation → shareable ?build= URL
```

## Layout

The build is the home screen. On a phone one talent tree fills the screen; the switcher above it picks a tree
or the Mystic Enchant board and shows each tree's points as a bar (share of the largest tree). From 1000px wide
the three trees sit side by side with the board below. Everything else is an overlay opened from the build, and
the Back button closes one overlay at a time:

- Tap a talent (touch): sheet with the tooltip, next rank, requirements and − / + / Max. Mouse: click adds,
  right-click removes, hover shows the tooltip.
- Tap an enchant slot: selector for that slot's rarity (search, spec filter, detail of the pick); Confirm
  socket it, Clear empties the slot. Right-click a slot clears it with a mouse.
- Summary: notes, talents per tree, socketed enchants, pinned abilities (reorder with ↑ ↓ or by dragging the grip).
- Class name: class picker. ⋯: saved builds, copy link, reset (two taps).

Broken images are logged to the console, and shown in a banner on local previews or with `?debug404`.

## Updating the data

1. In `_asc_extract`: `python tools/extract_mpq.py dbc …` then `python tools/export_bronzebeard.py` (see its CONTEXT_MAP.md).
2. Here: `node tools/build-class-data.mjs --all` (or one class slug). It fails on any missing icon, label or broken reference.
3. `node tools/build-index.mjs` to re-validate saved builds.

Both builds re-stamp `index.html` and `sw.js` (`../tools/app/stamp_cache.py`, rule A-cache-bust).

The extract path defaults to `../_asc_extract`; override with `--extract <dir>` or `ASC_EXTRACT`.

## URLs

- `?class=warlock` — pick the class (without it: the class picker)
- `&build=2350222...` — point allocation, one digit per talent in layout order
- `&ench=key,key,...` — enchant picks in slot order (1 Legendary, 3 Epic,
  1 Artifact, 6 Rare); blanks allowed

The page keeps both parameters updated as you click, so the address bar is
always a shareable snapshot of the current build.

## Build files

`builds/<class>-<name>.json`:

```json
{ "name": "Display Name", "class": "warlock",
  "focus": "PvE — Raiding", "notes": "optional",
  "points": { "talent_key": 3 },
  "enchants": ["legendary", "e1", "e2", "e3", "artifact", "r1", "r2", "r3", "r4", "r5", "r6"] }
```

`node tools/build-index.mjs` validates everything (point caps, prereqs, row
gates, enchant slot rarities, and that each enchant's requirements hold
against the build's own talents) and regenerates `builds/index.js`, which
feeds the saved builds list in the ⋯ menu.

## Publishing a build

```
node tools/encode-build.mjs warlock "Improved Curse of Agony=2" haunt=1 ...
```

Validates point caps, prereqs, and row gates, then prints the URL fragment to
append to the site address.
