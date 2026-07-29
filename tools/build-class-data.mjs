#!/usr/bin/env node
// Builds data/<class>.json from the ascension-theorycraft skill's CSVs.
//
//   node tools/build-class-data.mjs <class> [skill-dir]
//
// Reads:  <skill-dir>/references/data/<class>/<class>-talents.csv
//         <skill-dir>/references/data/<class>/<class>-talents-layout.csv
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
const tRows = parseCSV(readFileSync(join(dataDir, `${slug}-talents.csv`), 'utf8'));
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
  // CSVs may carry literal backslash-n or CRLF; normalize to real LF newlines
  // (CR would defeat the header-strip regexes below: `.` never matches \r in JS)
  let template = r[C.template].trim().replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');
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

// ── layout.csv (accepts both icon paths and display names as cell values) ──
const lRows = parseCSV(readFileSync(join(dataDir, `${slug}-layout.csv`), 'utf8'));
const lHeader = lRows.shift().map(h => h.trim());
const treeNames = [...new Set(lHeader)];
const layout = {};
treeNames.forEach((tree, ti) => {
  layout[tree] = lRows.map((row, ri) => row.slice(ti * 4, ti * 4 + 4).map(cell => {
    const c = cell.trim();
    if (!c || c === '-') return null;
    const key = stemToKey[iconStem(c)] || nameToKey[c];
    if (!key) errors.push(`layout ${tree} row ${ri + 1}: no talent matches '${c}'`);
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
  const eText = readFileSync(join(dataDir, `${slug}-enchants.csv`), 'utf8');
  const eRows = parseCSV(eText);
  const eHeader = eRows.shift().map(h => h.trim());
  const ec = name => eHeader.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const E = { name: ec('Mystic Enchant'), icon: ec('Icon_Path'), rarity: ec('Rarity'), spec: ec('Specialization'), tooltip: ec('Tooltip'),
              conflicting: ec('Conflicting'), required: ec('Required'), recommended: ec('Recommended') };
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
    const tooltip = r[E.tooltip].trim().replace(/\\n/g, '\n').replace(/\r\n?/g, '\n')
      .replace(/^.*\n+Mystic Enchant\s*\n+/, '');
    const e = { key, name, rarity: rarity.toLowerCase(), spec: r[E.spec].trim(), tooltip };
    if (stem !== key) e.iconFile = stem;
    // Raw relation columns; resolved to keys in a second pass below
    e._raw = {
      conflicts: E.conflicting >= 0 ? r[E.conflicting] : '',
      requires: E.required >= 0 ? r[E.required] : '',
      recommends: E.recommended >= 0 ? r[E.recommended] : '',
    };
    enchants.push(e);
  }

  // Second pass: resolve Conflicting/Required/Recommended names to keys.
  // Names may point at talents, other enchants, or plain abilities; matching
  // collapses separators so "Shadow Fury" finds the talent "Shadowfury".
  const collapse = s => keyOf(s).replace(/_/g, '');
  const talentByCollapsed = Object.fromEntries(
    Object.entries(talents).map(([k, t]) => [collapse(t.name), k]));
  const enchantByCollapsed = Object.fromEntries(
    enchants.map(en => [collapse(en.name), en.key]));

  const parseRefs = raw => {
    raw = (raw || '').trim();
    if (!raw || raw === '-') return undefined;
    return raw.split(',').map(part => {
      part = part.trim();
      // Tree-investment gates: "30 Affliction or 30 Demonology" — any-of
      if (/^\d+\s+/.test(part)) {
        const alts = part.split(/\s+or\s+/i).map(alt => {
          const am = alt.trim().match(/^(\d+)\s+(.+)$/);
          return am && treeNames.includes(am[2].trim())
            ? { tree: am[2].trim(), pts: parseInt(am[1], 10) } : null;
        });
        if (alts.every(Boolean)) return { anyOf: alts };
      }
      const m = part.match(/^(.*?)\s*\(\s*Rank\s*(\d+)\s*\)$/i);
      const name = (m ? m[1] : part).trim();
      const c = collapse(name);
      const ref = {};
      if (talentByCollapsed[c]) ref.talent = talentByCollapsed[c];
      else if (enchantByCollapsed[c]) ref.enchant = enchantByCollapsed[c];
      else ref.name = name; // ability or stance — informational only
      if (m) ref.rank = parseInt(m[2], 10);
      return ref;
    });
  };

  for (const e of enchants) {
    const conflicts = parseRefs(e._raw.conflicts);
    const requires = parseRefs(e._raw.requires);
    const recommends = parseRefs(e._raw.recommends);
    delete e._raw;
    if (conflicts) e.conflicts = conflicts;
    if (requires) e.requires = requires;
    if (recommends) e.recommends = recommends;
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  enchants = undefined; // no enchant data for this class yet
}

if (errors.length) {
  console.error(`FAILED — ${errors.length} error(s):\n  ` + errors.join('\n  '));
  process.exit(1);
}

// ── abilities.csv (optional) ──
// Reads display-relevant fields only; Effect_N columns are preserved raw for
// future modifier calculations but are NOT parsed here.
let abilities;
try {
  const abText = readFileSync(join(dataDir, `${slug}-abilities.csv`), 'utf8');
  const abRows = parseCSV(abText);
  const abHeader = abRows.shift().map(h => h.trim());
  const ac = name => abHeader.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const AB = {
    name: ac('Spell'), icon: ac('Icon_Path'), spec: ac('Specialization'),
    source: ac('Source'), replaces: ac('Replaces'), requires: ac('Requires'),
    lvl: ac('Lvl'), costValue: ac('Cost_Value'), costUnit: ac('Cost_Unit'),
    costPower: ac('Cost_Power'), durInt: ac('Dur_Int'), durStr: ac('Dur_Str'),
    range: ac('Range'), school: ac('School'), castTime: ac('Cast_Time'),
    cooldownInt: ac('Cooldown_Int'), cooldownStr: ac('Cooldown_Str'),
    gcd: ac('GCD'), spDirect: ac('SP_Direct_Coeff'), spTick: ac('SP_Tick_Coeff'),
    tooltip: ac('Tooltip_Template'), rankValues: ac('Rank_Values'),
  };

  // Only tree specs; exclude pet/stance/form sources for this initial display
  const treeSet = new Set(treeNames);
  const DISP_SRC = new Set(['Core', 'Talent', 'Mystic Enchant', 'Stance', 'Form']);

  // Build set of spells that are superseded (appear in another spell's Replaces field)
  const superseded = new Set();
  for (const r of abRows) {
    const rep = r[AB.replaces]?.trim();
    if (rep && rep !== '-') superseded.add(rep);
  }

  abilities = [];
  for (const r of abRows) {
    const name = r[AB.name]?.trim();
    if (!name) continue;
    const spec = r[AB.spec]?.trim();
    const src  = r[AB.source]?.trim();
    if (!treeSet.has(spec) || !DISP_SRC.has(src)) continue;
    if (superseded.has(name)) continue; // old rank in an upgrade chain — skip

    const key  = keyOf(name);
    const stem = iconStem(r[AB.icon]?.trim() || '');

    // per-rank level array — determines rank active at lvl 60
    const lvls = (r[AB.lvl]?.trim() || '60').split('|').map(v => parseInt(v, 10) || 0);
    const rank60idx = lvls.reduce((best, lvl, i) => lvl <= 60 ? i : best, 0);

    // pick the value at rank-60 from a pipe-delimited field (or return null for '-')
    const atRank = field => {
      const s = r[field]?.trim();
      if (!s || s === '-') return null;
      const parts = s.split('|');
      return parts[Math.min(rank60idx, parts.length - 1)].trim() || null;
    };
    const toNum = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

    // Scalars (not per-rank)
    const school   = r[AB.school]?.trim() || null;
    const gcd      = toNum(r[AB.gcd]?.trim());

    const ctRaw = r[AB.castTime]?.trim();
    const castTime = ctRaw === 'Channeled' ? 'Channeled'
      : ctRaw === '-' ? null : toNum(ctRaw);

    const cdInt = atRank(AB.cooldownInt);
    const cdStr = r[AB.cooldownStr]?.trim();
    const cooldown = cdInt && cdInt !== '-' && cdStr && cdStr !== '-'
      ? `${cdInt} ${cdStr}` : null;

    const dInt = atRank(AB.durInt);
    const dStr = r[AB.durStr]?.trim();
    const duration = dInt && dInt !== '-' && dStr && dStr !== '-'
      ? `${dInt} ${dStr}` : null;

    const rangeVal = toNum(r[AB.range]?.trim());

    // Cost at rank 60
    const costValue = atRank(AB.costValue);
    const costUnit  = r[AB.costUnit]?.trim() || null;
    const costPower = r[AB.costPower]?.trim() || null;

    // SP coefficients (may be per-rank)
    const spDirect = toNum(atRank(AB.spDirect));
    const spTick   = toNum(r[AB.spTick]?.trim() === '-' ? null : r[AB.spTick]?.trim());

    // Tooltip: strip the in-game header lines (spell name, cost, cast time, cooldown)
    // so only the description text remains.  [V\d] placeholders stand in for
    // per-rank cast times and costs in some tooltips — strip those too.
    const rawTip = (r[AB.tooltip]?.trim() || '').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tooltipTemplate = rawTip
      .replace(new RegExp('^' + escapedName + '[^\\n]*\\n+', 'i'), '')  // spell name line
      .replace(/^\d[\d.]*%[^\n]*mana[^\n]*\n+/i, '')                     // percent mana
      .replace(/^\d+\s+(?:Mana|Energy|Rage)[^\n]*\n+/i, '')             // flat resource
      .replace(/^(?:Instant(?:\s+cast)?|Channeled|(?:\d[\d.]*|\[V\d+\])\s*sec(?:\s+cast)?)[^\n]*\n+/i, '') // cast time (incl. [Vn] variant)
      .replace(/^(?:\d[\d.]*|\[V\d+\])\s+(?:sec|min)(?:\s+cooldown)?[^\n]*\n+/i, '')  // cooldown
      .replace(/^Reagents?:[^\n]*\n+/i, '')
      .trim();

    // Rank values: rank-60 slice for tooltip substitution
    const rvRaw = r[AB.rankValues]?.trim();
    let rank60 = null;
    if (rvRaw && rvRaw !== '-') {
      const allRanks = rvRaw.split('|').map(rank =>
        rank.split(',').map(v => { const n = parseFloat(v.trim()); return isNaN(n) ? v.trim() : n; }));
      rank60 = allRanks[Math.min(rank60idx, allRanks.length - 1)];
    }

    const a = { key, name, spec, source: src, school, castTime, gcd, rank60idx };
    if (stem !== key) a.iconFile = stem;
    if (costValue !== null) { a.costValue = costValue; a.costUnit = costUnit; a.costPower = costPower; }
    if (cooldown)  a.cooldown  = cooldown;
    if (duration)  a.duration  = duration;
    if (rangeVal !== null) a.range = rangeVal;
    if (spDirect !== null) a.spDirect = spDirect;
    if (spTick   !== null) a.spTick   = spTick;
    if (tooltipTemplate) a.tooltipTemplate = tooltipTemplate;
    if (rank60)   a.rank60 = rank60;
    const repRaw = r[AB.replaces]?.trim();
    if (repRaw && repRaw !== '-') a.replaces = repRaw;
    const reqRaw = r[AB.requires]?.trim();
    if (reqRaw && reqRaw !== '-') a.requires = reqRaw;
    abilities.push(a);
  }

  // Mark known non-combat utilities so the frontend can hide them by default.
  // These are kept in the data (never deleted) so a future "show all" toggle works.
  const UTILITY_BY_CLASS = {
    warlock: new Set([
      'unending_breath', 'eye_of_kilrogg', 'detect_invisibility',
      'create_healthstone', 'create_soulstone', 'create_firestone', 'create_spellstone',
      'ritual_of_summoning', 'ritual_of_doom', 'temporary_enslave_demon',
    ]),
  };
  const utilitySet = UTILITY_BY_CLASS[slug] || new Set();
  abilities.forEach(a => { if (utilitySet.has(a.key)) a.hidden = true; });

  // Sort: tree order → source order → name
  const srcOrder = ['Core', 'Stance', 'Form', 'Talent', 'Mystic Enchant'];
  abilities.sort((a, b) => {
    const si = treeNames.indexOf(a.spec) - treeNames.indexOf(b.spec);
    if (si !== 0) return si;
    const oi = srcOrder.indexOf(a.source) - srcOrder.indexOf(b.source);
    if (oi !== 0) return oi;
    return a.name.localeCompare(b.name);
  });
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  abilities = undefined;
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
if (enchants)   out.enchants   = enchants;
if (abilities)  out.abilities  = abilities;

mkdirSync(join(ROOT, 'data'), { recursive: true });
const outPath = join(ROOT, 'data', `${slug}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 1));

// Mark this class available in data/classes.json
const classesPath = join(ROOT, 'data', 'classes.json');
try {
  let classList = [];
  try { classList = JSON.parse(readFileSync(classesPath, 'utf8')); } catch {}
  const entry = classList.find(c => c.slug === slug);
  if (entry) { entry.available = true; }
  else classList.push({ slug, name: meta.name, accent: Object.values(meta.trees)[0], available: true });
  writeFileSync(classesPath, JSON.stringify(classList, null, 1));
} catch (err) { console.warn(`Warning: could not update classes.json: ${err.message}`); }

console.log(`OK — ${Object.keys(talents).length} talents, ${treeNames.length} trees` +
  (enchants   ? `, ${enchants.length} enchants`   : '') +
  (abilities  ? `, ${abilities.length} abilities`  : '') +
  ` -> ${outPath}`);
