#!/usr/bin/env node
// Builds data/<class>.json and the class's icons from the Ascension client datamine (_asc_extract).
//
//   node tools/build-class-data.mjs <class>|--all [--extract <dir>]
//
// Reads:  <extract>/data/bronzebeard/<class>.json   (tools/export_bronzebeard.py in the extract)
//         <extract>/data/bronzebeard/classes.json
//         <extract>/labels.json                    (every display name; no raw game key reaches the page)
//         <extract>/assets/icons/*.jpg, <extract>/assets/talent-bg/*.jpg, <extract>/assets/provenance.json
//         tools/class-meta.json                    (tree accent colours: site styling, not game data)
// Writes: data/<class>.json, data/classes.json, assets/game/<class>/{talents,abilities,mystic-enchants,backgrounds}/
//
// The extract is local-only (decompiled game data never ships); only these runtime files land in the repo.
// Exits non-zero on any missing icon, label or broken reference (no silent fallbacks).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const xi = args.indexOf('--extract');
const EXTRACT = xi >= 0 ? args.splice(xi, 2)[1] : (process.env.ASC_EXTRACT || join(ROOT, '..', '_asc_extract'));
const BB = join(EXTRACT, 'data', 'bronzebeard');
if (!args.length) { console.error('usage: node tools/build-class-data.mjs <class>|--all [--extract <dir>]'); process.exit(1); }

const readJSON = p => JSON.parse(readFileSync(p, 'utf8'));
const LABELS = readJSON(join(EXTRACT, 'labels.json'));
const INDEX = readJSON(join(BB, 'classes.json'));
const PROV = readJSON(join(EXTRACT, 'assets', 'provenance.json'));
const META = readJSON(join(ROOT, 'tools', 'class-meta.json'));
const LEVEL = INDEX.renderLevel;           // character level the extract rendered tooltips at
const POINT_CAP = LEVEL - 9;               // one talent point per level from 10

const keyOf = name => name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const label = (table, k) => {
  const v = LABELS[table]?.[k];
  if (v === undefined) throw new Error(`labels.json has no ${table}.${k}`);
  return typeof v === 'string' ? v : v.name;
};

// ── tooltip template: numbers that change between ranks become [Vn], the rest stays literal ──
const NUM = /-?\d+(?:\.\d+)?/g;
function templateOf(texts) {
  const skel = texts.map(t => t.replace(NUM, '#'));
  if (texts.length < 2 || skel.some(s => s !== skel[0])) return { tooltipTemplate: texts[texts.length - 1] };
  const nums = texts.map(t => t.match(NUM) || []);
  let vi = 0, n = 0;
  const cols = [];
  const tpl = texts[0].replace(NUM, () => {
    const col = nums.map(r => r[n]);
    n++;
    if (col.every(v => v === col[0])) return col[0];
    cols.push(col.map(Number));
    return `[V${++vi}]`;
  });
  if (!cols.length) return { tooltipTemplate: texts[0] };
  return { tooltipTemplate: tpl, rankValues: texts.map((_, r) => cols.map(c => c[r])) };
}

function copyIcon(stem, slug, kind, errors) {
  const src = join(EXTRACT, 'assets', 'icons', `${stem}.jpg`);
  if (!stem || !existsSync(src) || !PROV.icons[stem]) { errors.push(`icon ${stem} (${kind}) missing from extract`); return; }
  const dir = join(ROOT, 'assets', 'game', slug, kind);
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, `${stem}.jpg`));
}

const fmtSec = ms => {
  const s = ms / 1000;
  return s >= 60 ? `${+(s / 60).toFixed(2)} min` : `${+s.toFixed(2)} sec`;
};

function build(slug) {
  const src = readJSON(join(BB, `${slug}.json`));
  const meta = META[slug];
  if (!meta) throw new Error(`no entry for '${slug}' in tools/class-meta.json`);
  const errors = [];
  const outDir = join(ROOT, 'assets', 'game', slug);
  rmSync(outDir, { recursive: true, force: true });   // generated output: rebuilt every run

  // trees in the game's tab order
  const tabs = src.class.tabs;
  const treeName = tt => label('tab', tabs.find(t => t.tabType === tt).key);
  const trees = tabs.map(t => {
    const name = label('tab', t.key);
    if (!meta.trees[name]) errors.push(`class-meta.json: no accent for ${slug} tree ${name}`);
    const bg = t.background && t.background.toLowerCase();
    const bgSrc = bg && join(EXTRACT, 'assets', 'talent-bg', `${bg}.jpg`);
    if (!bg || !existsSync(bgSrc)) errors.push(`tree background for ${name} missing`);
    else {
      mkdirSync(join(outDir, 'backgrounds'), { recursive: true });
      copyFileSync(bgSrc, join(outDir, 'backgrounds', `${bg}.jpg`));
    }
    return { name, accent: meta.trees[name], background: `assets/game/${slug}/backgrounds/${bg}.jpg` };
  });

  // talents + layout (grid columns normalised so the left-most used column is 1)
  const talents = {}, keyByCa = {}, keyBySpell = {};
  for (const t of src.talents) {
    let key = keyOf(t.name);
    if (talents[key]) key = `${key}_${t.caId}`;
    keyByCa[t.caId] = key;
    t.ranks.forEach((r, i) => { keyBySpell[r.spellId] = { talent: key, rank: i + 1 }; });
  }
  const minCol = {};
  for (const t of src.talents) minCol[t.tabType] = Math.min(minCol[t.tabType] ?? 99, t.col);
  const layout = Object.fromEntries(trees.map(tr => [tr.name, []]));
  for (const t of src.talents) {
    const key = keyByCa[t.caId];
    const tip = templateOf(t.ranks.map(r => r.text));
    const out = { name: t.name, maxPts: t.ranks.length, prereq: null, ...tip, iconFile: t.icon };
    // prerequisite arrows: Talent.dbc link that the game's own CA flag (0x200000) confirms; others stay in the
    // extract's report.json as open questions
    const p = t.prereq;
    if (p && p.caId && p.caFlag && (p.geometry === 'vertical' || p.geometry === 'horizontal')) out.prereq = keyByCa[p.caId];
    if (t.type === 'TalentAbility') out.active = true;
    talents[key] = out;
    copyIcon(t.icon, slug, 'talents', errors);
    const grid = layout[treeName(t.tabType)];
    const col = t.col - minCol[t.tabType];
    while (grid.length <= t.row) grid.push([null, null, null, null]);
    if (col > 3) errors.push(`${t.name}: column ${t.col} outside a 4-wide grid`);
    else if (grid[t.row][col]) errors.push(`${t.name}: cell ${t.row},${col} already holds ${grid[t.row][col]}`);
    else grid[t.row][col] = key;
  }

  // abilities: the class's Ability entries at the highest rank learnable by LEVEL, plus active talents
  const abilities = [];
  const addAbility = (name, tabType, icon, ranks, source) => {
    const usable = ranks.filter(r => (r.spellLevel || 0) <= LEVEL);
    const r = usable[usable.length - 1] || ranks[0];
    if (!r) return;
    const a = { key: keyOf(name), name, spec: treeName(tabType), source, rank: r.rank ?? 1,
                school: (r.schools || []).join('/') || null, castTime: r.castMs ? +(r.castMs / 1000).toFixed(2) : 0,
                gcd: r.gcdMs ? r.gcdMs / 1000 : 0, tooltipTemplate: r.text, iconFile: icon };
    if (r.costPctBase) Object.assign(a, { costValue: String(r.costPctBase / 100), costUnit: 'percent', costPower: r.power });
    else if (r.cost) Object.assign(a, { costValue: String(r.cost), costUnit: 'flat', costPower: r.power });
    if (r.cooldownMs) a.cooldown = fmtSec(r.cooldownMs);
    if (r.durationMs > 0) a.duration = fmtSec(r.durationMs);
    if (r.rangeYd) a.range = r.rangeYd;
    if (r.scaling?.length) a.scaling = r.scaling;
    abilities.push(a);
    copyIcon(icon, slug, 'abilities', errors);
  };
  for (const ab of src.abilities) if (ab.ranks.some(r => !r.passive)) addAbility(ab.name, ab.tabType, ab.icon, ab.ranks, 'Core');
  for (const t of src.talents) if (t.type === 'TalentAbility') {
    addAbility(t.name, t.tabType, t.icon, t.ranks.map((r, i) => ({ ...r, rank: i + 1, schools: [], spellLevel: 0 })), 'Talent');
  }
  const seen = new Set();
  const abil = abilities.filter(a => (seen.has(a.key) ? false : seen.add(a.key)));
  abil.sort((a, b) => trees.findIndex(t => t.name === a.spec) - trees.findIndex(t => t.name === b.spec) || a.name.localeCompare(b.name));

  // Mystic Enchants
  const enchants = src.enchants.map(e => {
    const q = LABELS.enchantQuality[e.quality];
    if (!q) { errors.push(`labels.json has no enchantQuality.${e.quality}`); return null; }
    const out = { key: keyOf(e.name || `enchant_${e.id}`), name: e.name, rarity: q.rarity,
                  spec: e.specs.map(s => label('enchantSpec', s)).join(', '), tooltip: e.text, iconFile: e.icon,
                  requiredLevel: e.requiredLevel };
    const req = (e.requires || []).map(sid => keyBySpell[sid] || { name: e.text.match(/Requires ([^\n]+)/)?.[1] || `spell ${sid}` });
    if (req.length) out.requires = req;
    copyIcon(e.icon, slug, 'mystic-enchants', errors);
    return out;
  }).filter(Boolean);
  const ekeys = new Set();
  for (const e of enchants) { if (ekeys.has(e.key)) e.key = `${e.key}_${e.rarity}`; ekeys.add(e.key); }

  if (errors.length) {
    console.error(`${slug}: FAILED — ${errors.length} error(s):\n  ` + [...new Set(errors)].join('\n  '));
    process.exitCode = 1;
    return null;
  }
  const out = { class: meta.name, slug, realm: INDEX.realm, level: LEVEL, pointCap: POINT_CAP, trees, talents, layout,
                enchants, abilities: abil };
  writeFileSync(join(ROOT, 'data', `${slug}.json`), JSON.stringify(out, null, 1) + '\n');
  console.log(`${slug}: ${Object.keys(talents).length} talents, ${enchants.length} enchants, ${abil.length} abilities`);
  return out;
}

const slugs = args[0] === '--all' ? INDEX.classes.map(c => c.slug).filter(s => META[s]) : args;
mkdirSync(join(ROOT, 'data'), { recursive: true });
const built = slugs.map(s => [s, build(s)]);

// class picker list: every class in class-meta.json, available when its data built
let prevList = [];
try { prevList = readJSON(join(ROOT, 'data', 'classes.json')); } catch {}
const classList = Object.entries(META).map(([slug, m]) => ({
  slug, name: m.name, accent: prevList.find(c => c.slug === slug)?.accent || Object.values(m.trees)[0],
  available: existsSync(join(ROOT, 'data', `${slug}.json`)),
}));
writeFileSync(join(ROOT, 'data', 'classes.json'), JSON.stringify(classList, null, 1) + '\n');
if (built.some(([, o]) => !o)) process.exit(1);
