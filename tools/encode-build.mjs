#!/usr/bin/env node
// Encodes a talent allocation into a shareable ?build= URL for the calculator.
// The bridge from a theorycraft skill session to the hosted page.
//
//   node tools/encode-build.mjs <class> <talent>=<pts> [<talent>=<pts> ...]
//   node tools/encode-build.mjs warlock improved_corruption=5 suppression=3 haunt=1
//
// Talent names accept either the key (improved_corruption) or the display
// name in quotes ("Improved Corruption"). Validates point caps, prereqs,
// row gates, and the total cap before printing the URL fragment.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
const pairs = process.argv.slice(3);
if (!slug || !pairs.length) {
  console.error('usage: node tools/encode-build.mjs <class> <talent>=<pts> ...');
  process.exit(1);
}

const DATA = JSON.parse(readFileSync(join(ROOT, 'data', `${slug}.json`), 'utf8'));
const T = DATA.talents, LAYOUT = DATA.layout;
const TREE_NAMES = DATA.trees.map(t => t.name);
const keyOf = name => name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const pts = {};
const errors = [];
for (const pair of pairs) {
  const m = pair.match(/^(.+?)=(\d+)$/);
  if (!m) { errors.push(`bad argument '${pair}' (want talent=pts)`); continue; }
  const key = T[m[1]] ? m[1] : keyOf(m[1]);
  if (!T[key]) { errors.push(`unknown talent '${m[1]}'`); continue; }
  const n = parseInt(m[2], 10);
  if (n < 0 || n > T[key].maxPts) { errors.push(`${T[key].name}: ${n} exceeds max ${T[key].maxPts}`); continue; }
  pts[key] = n;
}

// Validate prereqs, row gates, total
const talentPts = k => pts[k] || 0;
const treePts = tree => LAYOUT[tree].flat().filter(Boolean).reduce((s, k) => s + talentPts(k), 0);
const total = Object.values(pts).reduce((s, v) => s + v, 0);
if (total > (DATA.pointCap || 51)) errors.push(`total ${total} exceeds cap ${DATA.pointCap || 51}`);

const pos = {};
Object.entries(LAYOUT).forEach(([tree, rows]) =>
  rows.forEach((row, r) => row.forEach(k => { if (k) pos[k] = { tree, row: r }; })));

for (const [k, n] of Object.entries(pts)) {
  if (!n) continue;
  const t = T[k], { tree, row } = pos[k];
  if (t.prereq && talentPts(t.prereq) < T[t.prereq].maxPts)
    errors.push(`${t.name}: prereq ${T[t.prereq].name} not maxed`);
  const below = LAYOUT[tree].slice(0, row).flat().filter(Boolean).reduce((s, kk) => s + talentPts(kk), 0);
  if (below < row * 5)
    errors.push(`${t.name}: row needs ${row * 5} pts in ${tree} below it, allocation has ${below}`);
}

if (errors.length) {
  console.error(`INVALID BUILD — ${errors.length} error(s):\n  ` + errors.join('\n  '));
  process.exit(1);
}

const order = TREE_NAMES.flatMap(tr => LAYOUT[tr].flat().filter(Boolean));
const s = order.map(k => talentPts(k)).join('').replace(/0+$/, '');
const perTree = TREE_NAMES.map(tr => `${tr} ${treePts(tr)}`).join(' / ');
console.log(`${total} pts — ${perTree}`);
console.log(`?class=${slug}&build=${s}`);
