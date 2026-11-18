# Ascension Talent Calculator — Bronzebeard (Warcraft Reborn)

Interactive talent calculator for the [Ascension](https://ascension.gg) Bronzebeard realm. One class-agnostic engine (`index.html`) renders any class from a data file.

All talents, abilities, Mystic Enchants, tooltips, icons and tree art come from the Ascension game client, extracted by the local datamine (`_asc_extract`, not in this repo). Only the generated runtime files are committed here.

## Structure

```
index.html              engine — loads data/<class>.json, renders everything from it
data/<class>.json       generated class data (talents, layout, trees, enchants, abilities)
data/classes.json       class picker list
assets/game/<class>/    generated icons + tree backgrounds
tools/
  build-class-data.mjs  extract → data/<class>.json + assets/game/<class>/
  class-meta.json       tree accent colours (site styling)
  build-index.mjs       validates builds/ and writes builds/index.json
  encode-build.mjs      allocation → shareable ?build= URL
```

## Updating the data

1. In `_asc_extract`: `python tools/extract_mpq.py dbc …` then `python tools/export_bronzebeard.py` (see its CONTEXT_MAP.md).
2. Here: `node tools/build-class-data.mjs --all` (or one class slug). It fails on any missing icon, label or broken reference.
3. `node tools/build-index.mjs` to re-validate saved builds.

The extract path defaults to `../_asc_extract`; override with `--extract <dir>` or `ASC_EXTRACT`.

## URLs

- `?class=warlock` — pick the class (default: warlock)
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
against the build's own talents) and regenerates `builds/index.json`, which
feeds the site's "Load a build…" dropdown.

## Publishing a build

```
node tools/encode-build.mjs warlock "Improved Curse of Agony=2" haunt=1 ...
```

Validates point caps, prereqs, and row gates, then prints the URL fragment to
append to the site address.
