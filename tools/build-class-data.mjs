#!/usr/bin/env node
// Builds data/<class>.json from the ascension-theorycraft skill's CSVs.
//
//   node tools/build-class-data.mjs <class> [skill-dir]
//
// Reads:  <skill-dir>/references/data/<class>/talents.csv
//         <skill-dir>/references/data/<class>/talents-layout.csv
//         tools/class-meta.json  (tree accent colors per class)
// Writes: data/<class>.json
//
// Validates rank-value shapes against [Vn] placeholders and layout/talent
// cross-references; exits non-zero on structural errors.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug) {
  console.error('usage: node tools/build-class-data.mjs <class> [skill-dir]');
  process.exit(1);
}
const skillDir = process.argv[3] || join(ROOT, '..', '.claude', 'skills', 'ascension-theorycraft');
const dataDir = join(skillDir, 'references', 'data', slug);

// ── CSV parser: quoted fields, embedded commas/quotes/newlines ──
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

const keyOf = name => name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const iconStem = p => basename(p.replace(/\\/g, '/')).replace(/\.\w+$/, '');

const meta = JSON.parse(readFileSync(join(ROOT, 'tools', 'class-meta.json'), 'utf8'))[slug];
if (!meta) { console.error(`no entry for '${slug}' in tools/class-meta.json`); process.exit(1); }

// ── talents.csv ──
const tRows = parseCSV(readFileSync(join(dataDir, 'talents.csv'), 'utf8'));
const header = tRows.shift().map(h => h.trim());
const col = name => {
  const i = header.findIndex(h => h.toLowerCase() === name.toLowerCase());
  if (i === -1) { console.error(`talents.csv missing column '${name}' (have: ${header.join(', ')})`); process.exit(1); }
  return i;
};
const C = {
  name: col('Talent'), icon: col('Icon_Path'), spec: col('Specialization'),
  points: col('Points'), template: col('Tooltip_Template'),
  ranks: col('Rank_Values'), prereq: col('Prior Talent'),
};

const talents = {};
const stemToKey = {};   // icon filename stem -> talent key (for layout lookup)
const nameToKey = {};   // talent display name -> key (for prereq lookup)
const errors = [];

for (const r of tRows) {
  const name = r[C.name].trim();
  if (!name) continue;
  const key = keyOf(name);
  const stem = iconStem(r[C.icon].trim());
  const maxPts = parseInt(r[C.points], 10);
  // CSVs may carry literal backslash-n; normalize to real newlines
  let template = r[C.template].trim().replace(/\\n/g, '\n');
  // Most CSV tooltips open with an embedded "<Name>   Rank 1" header line;
  // the calculator renders name/rank itself, so drop it.
  template = template.replace(/^.*Rank 1\s*\n+/, '');
  const ranksRaw = r[C.ranks].trim();
  const prereqRaw = r[C.prereq].trim();

  const t = { name, maxPts, prereq: prereqRaw === '-' || !prereqRaw ? null : prereqRaw, tooltipTemplate: template };
  if (stem !== key) t.iconFile = stem;

  if (ranksRaw && ranksRaw !== '-') {
    t.rankValues = ranksRaw.split('|').map(rank => rank.split(',').map(v => {
      const n = parseFloat(v);
      if (Number.isNaN(n)) errors.push(`${name}: non-numeric rank value '${v}'`);
      return n;
    }));
    if (t.rankValues.length !== maxPts)
      errors.push(`${name}: Points=${maxPts} but ${t.rankValues.length} rank groups`);
    const width = t.rankValues[0].length;
    if (!t.rankValues.every(rv => rv.length === width))
      errors.push(`${name}: inconsistent value counts across ranks`);
    const maxV = Math.max(0, ...[...template.matchAll(/\[V(\d)\]/g)].map(m => +m[1]));
    if (maxV !== width)
      errors.push(`${name}: template uses up to [V${maxV}] but ranks carry ${width} values`);
  } else if (maxPts > 1 && /\[V\d\]/.test(template)) {
    errors.push(`${name}: has [Vn] placeholders but no Rank_Values`);
  }

  talents[key] = t;
  stemToKey[stem] = key;
  nameToKey[name] = key;
}

// prereq names -> keys
for (const t of Object.values(talents)) {
  if (!t.prereq) continue;
  const pk = nameToKey[t.prereq];
  if (!pk) { errors.push(`${t.name}: unknown prereq '${t.prereq}'`); continue; }
  t.prereq = pk;
}

// ── talents-layout.csv ──
const lRows = parseCSV(readFileSync(join(dataDir, 'talents-layout.csv'), 'utf8'));
const lHeader = lRows.shift().map(h => h.trim());
const treeNames = [...new Set(lHeader)];
const layout = {};
treeNames.forEach((tree, ti) => {
  layout[tree] = lRows.map((row, ri) => row.slice(ti * 4, ti * 4 + 4).map(cell => {
    const c = cell.trim();
    if (!c || c === '-') return null;
    const key = stemToKey[iconStem(c)];
    if (!key) errors.push(`layout ${tree} row ${ri + 1}: no talent matches icon '${iconStem(c)}'`);
    return key || null;
  }));
});

// every talent must appear in the layout
const placed = new Set(Object.values(layout).flat(2).filter(Boolean));
for (const key of Object.keys(talents))
  if (!placed.has(key)) errors.push(`${talents[key].name}: not placed in talents-layout.csv`);

for (const tree of treeNames)
  if (!meta.trees[tree]) errors.push(`class-meta.json has no accent color for tree '${tree}'`);

// ── mystic-enchants.csv (optional) ──
// Columns: Mystic Enchant, Icon_Path, Rarity, Specialization, Tooltip
const RARITIES = ['Rare', 'Epic', 'Legendary', 'Artifact'];
let enchants;
try {
  const eText = readFileSync(join(dataDir, 'mystic-enchants.csv'), 'utf8');
  const eRows = parseCSV(eText);
  const eHeader = eRows.shift().map(h => h.trim());
  const ec = name => eHeader.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const E = { name: ec('Mystic Enchant'), icon: ec('Icon_Path'), rarity: ec('Rarity'), spec: ec('Specialization'), tooltip: ec('Tooltip') };
  const iconsDir = join(skillDir, 'assets', 'icons', slug, 'mystic-enchants');
  enchants = [];
  for (const r of eRows) {
    const name = r[E.name].trim();
    if (!name) continue;
    const key = keyOf(name);
    const stem = iconStem(r[E.icon].trim());
    const rarity = r[E.rarity].trim();
    if (!RARITIES.includes(rarity)) errors.push(`enchant ${name}: unknown rarity '${rarity}'`);
    try { readFileSync(join(iconsDir, stem + '.jpg')); }
    catch { errors.push(`enchant ${name}: icon '${stem}.jpg' not found in skill assets`); }
    // Tooltips open with "<Name>  <Rarity>" + "Mystic Enchant" header lines; drop both
    const tooltip = r[E.tooltip].trim().replace(/\\n/g, '\n')
      .replace(/^.*\n+Mystic Enchant\s*\n+/, '');
    const e = { key, name, rarity: rarity.toLowerCase(), spec: r[E.spec].trim(), tooltip };
    if (stem !== key) e.iconFile = stem;
    enchants.push(e);
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  enchants = undefined; // no enchant data for this class yet
}

if (errors.length) {
  console.error(`FAILED — ${errors.length} error(s):\n  ` + errors.join('\n  '));
  process.exit(1);
}

const out = {
  class: meta.name,
  slug,
  pointCap: 51,
  trees: treeNames.map(name => ({
    name,
    accent: meta.trees[name],
    background: `assets/icons/${slug}/backgrounds/${name.toLowerCase().replace(/\s+/g, '-')}.jpg`,
  })),
  talents,
  layout,
};
if (enchants) out.enchants = enchants;

mkdirSync(join(ROOT, 'data'), { recursive: true });
const outPath = join(ROOT, 'data', `${slug}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`OK — ${Object.keys(talents).length} talents, ${treeNames.length} trees` +
  (enchants ? `, ${enchants.length} enchants` : '') + ` -> ${outPath}`);
