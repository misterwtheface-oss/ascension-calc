#!/usr/bin/env node
// Regenerates builds/index.json from the build files in builds/.
// Run after adding or removing a build:  node tools/build-index.mjs
//
// Each build file: { "name", "class", "focus"?, "notes"?, "points": {key: n} }
// Points are validated against data/<class>.json (caps, prereqs, row gates).

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildsDir = join(ROOT, 'builds');
mkdirSync(buildsDir, { recursive: true });

const dataCache = {};
const classData = slug => dataCache[slug] ??=
  JSON.parse(readFileSync(join(ROOT, 'data', `${slug}.json`), 'utf8'));

const entries = [];
const errors = [];

for (const file of readdirSync(buildsDir).sort()) {
  if (!file.endsWith('.json') || file === 'index.json') continue;
  let b;
  try { b = JSON.parse(readFileSync(join(buildsDir, file), 'utf8')); }
  catch (e) { errors.push(`${file}: invalid JSON — ${e.message}`); continue; }
  if (!b.name || !b.class || !b.points) {
    errors.push(`${file}: needs "name", "class", and "points"`); continue;
  }

  let D;
  try { D = classData(b.class); }
  catch { errors.push(`${file}: no data for class '${b.class}'`); continue; }

  const { talents: T, layout: LAYOUT } = D;
  const pts = k => b.points[k] || 0;
  const pos = {};
  Object.entries(LAYOUT).forEach(([tree, rows]) =>
    rows.forEach((row, r) => row.forEach(k => { if (k) pos[k] = { tree, row: r }; })));

  let total = 0;
  for (const [k, n] of Object.entries(b.points)) {
    if (!T[k]) { errors.push(`${file}: unknown talent '${k}'`); continue; }
    if (n < 0 || n > T[k].maxPts) errors.push(`${file}: ${k} ${n}/${T[k].maxPts}`);
    total += n;
    const t = T[k], p = pos[k];
    if (t.prereq && pts(t.prereq) < T[t.prereq].maxPts)
      errors.push(`${file}: ${k} requires ${t.prereq} maxed`);
    const below = LAYOUT[p.tree].slice(0, p.row).flat().filter(Boolean)
      .reduce((s, kk) => s + pts(kk), 0);
    if (below < p.row * 5)
      errors.push(`${file}: ${k} row gate — ${below}/${p.row * 5} pts below it in ${p.tree}`);
  }
  if (total > (D.pointCap || 51)) errors.push(`${file}: ${total} pts exceeds cap`);

  // Optional enchant picks: array of keys (or null) in slot order
  if (b.enchants) {
    const SLOT_RARITIES = ['legendary','epic','epic','epic','artifact','rare','rare','rare','rare','rare','rare'];
    const byKey = Object.fromEntries((D.enchants || []).map(e => [e.key, e]));
    if (!Array.isArray(b.enchants) || b.enchants.length > SLOT_RARITIES.length)
      errors.push(`${file}: "enchants" must be an array of up to ${SLOT_RARITIES.length} slot keys`);
    else b.enchants.forEach((k, i) => {
      if (!k) return;
      if (!byKey[k]) errors.push(`${file}: unknown enchant '${k}'`);
      else if (byKey[k].rarity !== SLOT_RARITIES[i])
        errors.push(`${file}: enchant '${k}' is ${byKey[k].rarity}, slot ${i} takes ${SLOT_RARITIES[i]}`);
    });
    const filled = b.enchants.filter(Boolean);
    if (new Set(filled).size !== filled.length) errors.push(`${file}: duplicate enchant picks`);
  }

  entries.push({ file, name: b.name, class: b.class, focus: b.focus || null, points: total });
}

if (errors.length) {
  console.error(`FAILED — ${errors.length} error(s):\n  ` + errors.join('\n  '));
  process.exit(1);
}

writeFileSync(join(buildsDir, 'index.json'), JSON.stringify(entries, null, 1));
console.log(`OK — ${entries.length} build(s) -> builds/index.json`);
entries.forEach(e => console.log(`  ${e.class}: ${e.name} (${e.points} pts)`));
