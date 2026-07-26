# Ascension Classic+ Talent Calculator

Interactive talent calculator for the [Ascension](https://ascension.gg) Classic+/Warcraft Reforged realm. One class-agnostic engine (`index.html`) renders any class from a data file.

## Structure

```
index.html            engine — loads data/<class>.json, renders everything from it
data/<class>.json     generated class data (talents, layout, tree colors)
assets/icons/...      talent + background art per class
tools/
  build-class-data.mjs   CSV → JSON converter (source CSVs live in the
                         ascension-theorycraft skill; run after any CSV change)
  encode-build.mjs       allocation → shareable ?build= URL
  class-meta.json        tree accent colors per class
```

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

## Adding a class

1. Author `references/data/<class>/talents.csv` + `talents-layout.csv` in the
   theorycraft skill (see the skill's SKILL.md for the schema).
2. Add the class's tree accent colors to `tools/class-meta.json`.
3. `node tools/build-class-data.mjs <class>` — validates and emits the JSON.
4. Copy `assets/icons/<class>/talents` + `backgrounds` into `assets/icons/<class>/`.

## Publishing a build from a theorycraft session

```
node tools/encode-build.mjs warlock "Improved Curse of Agony=2" haunt=1 ...
```

Validates point caps, prereqs, and row gates, then prints the URL fragment to
append to the site address. Build files in the skill can link straight to a
fully-allocated calculator view.
