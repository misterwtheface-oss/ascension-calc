'use strict';
// Ascension talent calculator — one class-agnostic engine, data/<class>.json per class (built from the client
// datamine by tools/build-class-data.mjs). Vanilla, explicit re-render: mutate state, call refresh().
//
// Layout: the build is the home screen (talent trees + Mystic Enchant board). Everything else is an overlay
// opened from it: talent sheet, enchant selector, Summary, class picker, menu. Phone first; from 1000px the
// three trees sit side by side with the enchant board below.

// Feature toggles (rule A-feature-toggle): script flags that hide a feature, never a UI button.
const FEATURES = {
  abilities: true,   // pinned ability cards in Summary
  notes: true,       // build notes + per-ability notes
};

const CLASSES = window.ASC_CLASSES || [];
const BUILDS = window.ASC_BUILDS || [];
const RARITY = {
  legendary: 'Legendary', epic: 'Epic', artifact: 'Artifact', rare: 'Rare',
};
// Slot order used by the URL (&ench=) and build files: 1 Legendary, 3 Epic, 1 Artifact, 6 Rare.
const SLOT_RARITIES = ['legendary', 'epic', 'epic', 'epic', 'artifact', 'rare', 'rare', 'rare', 'rare', 'rare', 'rare'];
const FINE = matchMedia('(hover: hover) and (pointer: fine)');
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = s => s[0].toUpperCase() + s.slice(1);

// ─── STORAGE (prefix ascbc.; older unprefixed keys are migrated on first read) ───
function lsGet(key, legacy) {
  let v = localStorage.getItem(key);
  if (v === null && legacy && (v = localStorage.getItem(legacy)) !== null) {
    localStorage.setItem(key, v);
    localStorage.removeItem(legacy);
  }
  return v;
}
function lsSet(key, v) { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); }
const notesKey = () => `ascbc.notes.${D.slug}`;
const pinsKey = () => `ascbc.pins.${D.slug}`;
const ablNoteKey = k => `ascbc.note.${D.slug}.${k}`;
function loadPins() {
  try { return JSON.parse(lsGet(pinsKey(), `abl-pins-${D.slug}`) || '[]'); } catch { return []; }
}
function savePins(p) { lsSet(pinsKey(), p.length ? JSON.stringify(p) : ''); }

// ─── STATE ───────────────────────────────────────────────────────────────────
let D, T, LAYOUT, TREES, POINT_CAP, CLS;
const pts = {};
const pos = {};
const enchPicks = new Array(SLOT_RARITIES.length).fill(null);
let enchByKey = {};
let tab = null;            // active tree name or 'enchants' (phone switcher)
let armed = null, armTimer = null;   // two-tap destructive actions: 'reset' | 'rm:<ability>'

const talentPts = k => pts[k] || 0;
const treeKeys = tree => LAYOUT[tree].flat().filter(Boolean);
const treePts = tree => treeKeys(tree).reduce((s, k) => s + talentPts(k), 0);
// Tier gating counts only points in rows strictly below: a row-N talent needs N*5 points beneath it.
const treePtsBelow = (tree, row) => LAYOUT[tree].slice(0, row).flat().filter(Boolean).reduce((s, k) => s + talentPts(k), 0);
const totalPts = () => Object.values(pts).reduce((s, v) => s + v, 0);
const treeOf = name => TREES.find(t => t.name === name);

function talentState(key) {
  const t = T[key], p = talentPts(key);
  if (p >= t.maxPts) return 'maxed';
  if (p > 0) return 'partial';
  const { tree, row } = pos[key];
  if (treePtsBelow(tree, row) < row * 5) return 'unavailable';
  if (t.prereq && talentPts(t.prereq) < T[t.prereq].maxPts) return 'unavailable';
  if (totalPts() >= POINT_CAP) return 'unavailable';
  return 'available';
}
function canAdd(key) {
  if (totalPts() >= POINT_CAP) return false;
  const s = talentState(key);
  return s === 'available' || s === 'partial';
}
function canRemove(key) {
  if (talentPts(key) <= 0) return false;
  const { tree, row } = pos[key];
  pts[key]--;
  let ok = true;
  LAYOUT[tree].forEach((r, ri) => {
    if (ri > row && treePtsBelow(tree, ri) < ri * 5 && r.some(k => k && talentPts(k) > 0)) ok = false;
  });
  if (ok) for (const [k, t] of Object.entries(T)) if (t.prereq === key && talentPts(k) > 0) ok = false;
  pts[key]++;
  return ok;
}
function addPoint(key) { if (!canAdd(key)) return false; pts[key] = talentPts(key) + 1; return true; }
function removePoint(key) { if (!canRemove(key)) return false; pts[key]--; return true; }

// ─── TEXT ────────────────────────────────────────────────────────────────────
// Tooltip template: [Vn] = per-rank values; at 0 points every rank shows slashed ("2/4/6%").
function talentText(t, p) {
  if (!t.tooltipTemplate) return '';
  if (!t.rankValues) return t.tooltipTemplate;
  const rv = t.rankValues;
  if (p === 0) {
    let s = t.tooltipTemplate.replace(/\[Rank\]/g, rv.map((_, i) => i + 1).join('/'));
    rv[0].forEach((_, vi) => { s = s.replace(new RegExp(`\\[V${vi + 1}\\]`, 'g'), rv.map(r => r[vi]).join('/')); });
    return s;
  }
  const rank = rv[Math.min(p, rv.length) - 1];
  let s = t.tooltipTemplate.replace(/\[Rank\]/g, p);
  rank.forEach((v, vi) => { s = s.replace(new RegExp(`\\[V${vi + 1}\\]`, 'g'), v); });
  return s;
}
function talentReqLines(key) {
  if (talentPts(key) > 0) return [];
  const t = T[key], { tree, row } = pos[key], out = [];
  if (treePtsBelow(tree, row) < row * 5) out.push(`Requires ${row * 5} points in ${tree}`);
  if (t.prereq && talentPts(t.prereq) < T[t.prereq].maxPts) out.push(`Requires ${T[t.prereq].maxPts} points in ${T[t.prereq].name}`);
  return out;
}
// Shared by the hover tooltip and the talent sheet.
function talentInfo(key, withName) {
  const t = T[key], p = talentPts(key);
  const rank = p === 0 && t.maxPts > 1 ? `Rank ${Array.from({ length: t.maxPts }, (_, i) => i + 1).join('/')}` : `Rank ${Math.max(1, p)}/${t.maxPts}`;
  let h = (withName ? `<div class="info-name">${esc(t.name)}</div>` : '') +
    `<div class="info-rank">${rank}</div><div class="info-body">${esc(talentText(t, p))}</div>`;
  if (p > 0 && p < t.maxPts) {
    h += `<div class="info-next"><div class="info-next-label">Next rank</div><div class="info-body">${esc(talentText(t, p + 1))}</div></div>`;
  }
  const reqs = talentReqLines(key);
  if (reqs.length) h += `<div class="info-lines">${reqs.map(r => `<div class="ln-bad">${esc(r)}</div>`).join('')}</div>`;
  return h;
}

// Mystic Enchant requirements: talent refs are checkable; plain-name refs (abilities, stances) are not.
const refName = r => r.talent ? T[r.talent].name + (r.rank > 1 ? ` (Rank ${r.rank})` : '') : r.name;
const refMet = r => talentPts(r.talent) >= (r.rank || 1);
const talentReqs = e => (e.requires || []).filter(r => r.talent);
const unmetReqs = e => talentReqs(e).filter(r => !refMet(r));
const metReqs = e => talentReqs(e).filter(refMet);
const specAccent = s => treeOf(s)?.accent || 'var(--brass)';
function enchInfo(e, taken, withName) {
  const specs = e.specs.length ? e.specs : ['General'];
  let h = (withName ? `<div class="info-name">${esc(e.name)}</div>` : '') +
    `<div class="spec-line"><span style="color:var(--q-${e.rarity})">${RARITY[e.rarity]}</span> · ` +
    specs.map(s => `<span style="color:${specAccent(s)}">${esc(s)}</span>`).join(', ') + '</div>' +
    `<div class="info-body">${esc(e.tooltip)}</div>`;
  const lines = [];
  if (taken) lines.push(['ln-note', 'Socketed in another slot']);
  const un = unmetReqs(e), met = metReqs(e);
  if (un.length) lines.push(['ln-bad', `Requires ${un.map(refName).join(', ')}`]);
  if (met.length) lines.push(['ln-ok', `Requirements met: ${met.map(refName).join(', ')}`]);
  if (lines.length) h += `<div class="info-lines">${lines.map(([c, s]) => `<div class="${c}">${esc(s)}</div>`).join('')}</div>`;
  return h;
}

// Magnitude bar (rule A-magnitude-bars): value as a share of the largest value of the same field among the shown
// entries. One helper for every bar in the app.
const treeMax = () => Math.max(0, ...TREES.map(t => treePts(t.name)));
const magBar = (v, max) => `<span class="mag"><i style="width:${max > 0 ? Math.round(v / max * 100) : 0}%"></i></span>`;

// ─── TREE GEOMETRY (unit space shared with styles.css: cell 100, column gap 15, row gap 24) ──
const U = 100, CG = 15, RG = 24, ROWS = 11;
const GW = 4 * U + 3 * CG, GH = ROWS * U + (ROWS - 1) * RG;
const gx = c => c * (U + CG) + U / 2;
const gy = r => r * (U + RG) + U / 2;
const gTop = r => r * (U + RG);
const gBot = r => r * (U + RG) + U;

function arrowsSVG(tree) {
  const id = tree.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const paths = [];
  LAYOUT[tree].forEach((row, r) => row.forEach((key, c) => {
    const pre = key && T[key].prereq;
    if (!pre || pos[pre]?.tree !== tree || pos[pre].row === r) return;   // same-row prereqs: the tooltip says it
    const { row: pr, col: pc } = pos[pre];
    const end = gTop(r) - 12;   // the 16-unit head lands just inside the target icon's border
    const d = pc === c ? `M${gx(c)},${gBot(pr) - 6} L${gx(c)},${end}`
      : `M${gx(pc) + (c < pc ? -34 : 34)},${gy(pr)} L${gx(c)},${gy(pr)} L${gx(c)},${end}`;
    paths.push(`<path class="shaft" data-pre="${pre}" data-mid="${id}" d="${d}"/>`);
  }));
  const marker = (n, v) => `<marker id="${id}-${n}" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="22" refX="0" refY="11" orient="auto"><path d="M0,0 L0,22 L16,11 z" style="fill:var(${v})"/></marker>`;
  return `<svg class="arrows" viewBox="0 0 ${GW} ${GH}" preserveAspectRatio="none"><defs>${marker('on', '--arrow-on')}${marker('off', '--arrow-off')}</defs>${paths.join('')}</svg>`;
}

// ─── STATIC UI (built once per class; refresh() only updates it) ─────────────
function buildPlanner() {
  document.title = `${D.class} — Talent Calculator | Ascension Bronzebeard`;
  $('topbar').innerHTML =
    `<button class="cls-btn" data-action="classes" style="--cls:${CLS.accent}">${esc(D.class)}<span class="caret">▾</span></button>` +
    `<span class="pts"><b id="pts-spent">0</b><small>/${POINT_CAP}</small></span>` +
    `<button class="tb-btn" data-action="summary">Summary</button>` +
    `<button class="tb-btn" data-action="menu" aria-label="Menu">⋯</button>`;

  $('switcher').innerHTML = TREES.map(t =>
    `<button class="seg" data-tab="${esc(t.name)}" style="--sacc:${t.accent}"><span class="seg-name">${esc(t.name)}</span>` +
    `<span class="seg-val"><b data-tree-pts="${esc(t.name)}">0</b><span data-tree-bar="${esc(t.name)}"></span></span></button>`).join('') +
    `<button class="seg" data-tab="enchants"><span class="seg-name">Enchants</span><span class="seg-val"><span><b id="ench-count">0</b>/${SLOT_RARITIES.length}</span></span></button>`;

  const trees = TREES.map(t => {
    const cells = [];
    LAYOUT[t.name].forEach((row, r) => row.forEach((key, c) => {
      if (key) cells.push(`<button class="tal" data-tal="${key}" style="grid-row:${r + 1};grid-column:${c + 1}">` +
        `<img src="${T[key].icon}" alt="${esc(T[key].name)}" draggable="false"><span class="cnt"></span></button>`);
    }));
    return `<section class="tree-panel" data-panel="${esc(t.name)}" style="--tree-bg:url('${t.background}');--sacc:${t.accent}">` +
      `<div class="tree-wrap">${arrowsSVG(t.name)}<div class="tree-grid">${cells.join('')}</div></div></section>`;
  }).join('');

  // Board geometry on a 336-unit square: Legendary centre, 3 Epic on the inner ring, Artifact at the bottom and
  // 6 Rare on the outer ring (360/7 degrees apart), as percentages so the board scales.
  const C = 168, DEG = Math.PI / 180, geo = [{ s: 56, x: C, y: C }];
  [-90, 30, 150].forEach(a => geo.push({ s: 48, x: C + 68 * Math.cos(a * DEG), y: C + 68 * Math.sin(a * DEG) }));
  geo.push({ s: 48, x: C, y: C + 132 });
  for (let k = 1; k < 7; k++) { const a = (90 + k * 360 / 7) * DEG; geo.push({ s: 40, x: C + 132 * Math.cos(a), y: C + 132 * Math.sin(a) }); }
  const pc = v => `${(v / 336 * 100).toFixed(3)}%`;
  const slots = geo.map((g, i) => `<button class="slot q-${SLOT_RARITIES[i]}" data-slot="${i}" aria-label="${RARITY[SLOT_RARITIES[i]]} slot" ` +
    `style="left:${pc(g.x - g.s / 2)};top:${pc(g.y - g.s / 2)};width:${pc(g.s)};height:${pc(g.s)}"></button>`).join('');
  $('planner').innerHTML = trees +
    `<section class="ench-panel" data-panel="enchants"><div class="board"><div class="ring outer"></div><div class="ring inner"></div>${slots}</div></section>`;
}

function setTab(name) {
  tab = name;
  document.querySelectorAll('#switcher .seg').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('#planner > section').forEach(el => el.classList.toggle('active', el.dataset.panel === tab));
  const acc = treeOf(tab)?.accent;
  if (acc) document.documentElement.style.setProperty('--acc', acc);
  else document.documentElement.style.removeProperty('--acc');
}

// ─── REFRESH ─────────────────────────────────────────────────────────────────
function refresh() {
  $('pts-spent').textContent = totalPts();
  const max = treeMax();
  TREES.forEach(t => {
    const n = treePts(t.name);
    document.querySelector(`[data-tree-pts="${CSS.escape(t.name)}"]`).textContent = n;
    document.querySelector(`[data-tree-bar="${CSS.escape(t.name)}"]`).innerHTML = magBar(n, max);
  });
  document.querySelectorAll('.tal').forEach(el => {
    const k = el.dataset.tal, st = talentState(k);
    el.className = `tal ${st}` + (focusKey() === k ? ' focus' : '');
    el.querySelector('.cnt').textContent = `${talentPts(k)}/${T[k].maxPts}`;
  });
  document.querySelectorAll('.arrows .shaft').forEach(p => {
    const on = talentPts(p.dataset.pre) >= T[p.dataset.pre].maxPts;
    p.classList.toggle('on', on);
    p.setAttribute('marker-end', `url(#${p.dataset.mid}-${on ? 'on' : 'off'})`);
  });
  document.querySelectorAll('.slot').forEach(el => {
    const e = enchByKey[enchPicks[+el.dataset.slot]];
    el.classList.toggle('filled', !!e);
    el.classList.toggle('invalid', !!(e && unmetReqs(e).length));
    el.innerHTML = e ? `<img src="${e.icon}" alt="${esc(e.name)}" draggable="false">` : '';
  });
  $('ench-count').textContent = enchPicks.filter(Boolean).length;
  syncUrl();
  Ovl.refresh();
  Tip.refresh();
}

// ─── URL STATE ───────────────────────────────────────────────────────────────
// ?class=<slug>&build=<one digit per talent, layout order, trailing zeros trimmed>&ench=<keys in slot order>
const buildOrder = () => TREES.flatMap(t => treeKeys(t.name));
function encodeBuild() {
  const s = buildOrder().map(talentPts).join('');
  return /[^0]/.test(s) ? s.replace(/0+$/, '') : '';
}
function applyBuildString(s) {
  const order = buildOrder();
  [...s].forEach((ch, i) => { if (i < order.length) { const n = Math.min(+ch || 0, T[order[i]].maxPts); if (n) pts[order[i]] = n; } });
}
function applyEnchants(list) {
  SLOT_RARITIES.forEach((r, i) => { const k = list[i]; enchPicks[i] = k && enchByKey[k]?.rarity === r ? k : null; });
}
function syncUrl() {
  if (!D) return;
  const url = new URL(location);
  const b = encodeBuild();
  if (b) url.searchParams.set('build', b); else url.searchParams.delete('build');
  const e = enchPicks.map(k => k || '').join(',').replace(/,+$/, '');
  if (e) url.searchParams.set('ench', e); else url.searchParams.delete('ench');
  history.replaceState(history.state, '', url);
}

// ─── OVERLAYS ────────────────────────────────────────────────────────────────
// A stack of at most two layers: layer 0 in #overlay-root (selectors, Summary, menu), layer 1 in
// #detail-overlay-root (a detail opened from inside layer 0). Frames have fixed sizes; each kind renders named
// regions, and refresh() re-renders the dynamic regions while keeping every scroller's scrollTop.
const KINDS = {};
const Ovl = {
  stack: [],
  open(kind, args = {}) {
    Tip.hide();
    const depth = Math.min(this.stack.length, 1);
    if (this.stack.length > depth) this.stack.length = depth;
    const root = depth ? $('detail-overlay-root') : $('overlay-root');
    const K = KINDS[kind];
    root.innerHTML = `<div class="ovl-backdrop" data-action="dismiss"></div>` +
      `<div class="ovl-panel ovl-${K.size} ovl-${kind}" role="dialog"><header class="ovl-head"></header>` +
      `<div class="ovl-body"></div>${K.foot ? '<footer class="ovl-foot"></footer>' : ''}</div>`;
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    const layer = { kind, args, root };
    this.stack[depth] = layer;
    K.mount?.(layer);
    this.render(layer, true);
    History.reconcile();
    refreshFocus();
  },
  close() {
    const layer = this.stack.pop();
    if (!layer) return;
    layer.root.classList.add('hidden');
    layer.root.setAttribute('aria-hidden', 'true');
    layer.root.innerHTML = '';
    History.reconcile();
    refreshFocus();
  },
  top() { return this.stack[this.stack.length - 1]; },
  render(layer, first) {
    const K = KINDS[layer.kind], q = s => layer.root.querySelector(s);
    const keep = [...layer.root.querySelectorAll('.ovl-body, [data-scroll]')].map(el => [el.dataset.scroll || 'body', el.scrollTop]);
    q('.ovl-head').innerHTML = K.head(layer.args) + `<button class="ovl-x" data-action="dismiss" aria-label="Close">✕</button>`;
    if (K.regions) {
      if (first) q('.ovl-body').innerHTML = K.body(layer.args);
      for (const [sel, fn] of Object.entries(K.regions)) { const el = q(sel); if (el) el.innerHTML = fn(layer.args); }
    } else {
      q('.ovl-body').innerHTML = K.body(layer.args);
    }
    if (K.foot) q('.ovl-foot').innerHTML = K.foot(layer.args);
    keep.forEach(([name, top]) => {
      const el = name === 'body' ? q('.ovl-body') : q(`[data-scroll="${name}"]`);
      if (el) el.scrollTop = top;
    });
  },
  refresh() { this.stack.forEach(l => this.render(l, false)); },
};

// Talent sheet: the talent's tooltip plus − / + / Max (phones have no hover or right-click).
KINDS.talent = {
  size: 'sheet',
  head: a => `<img class="head-icon" src="${T[a.key].icon}" alt=""><h2>${esc(T[a.key].name)}</h2>`,
  body: a => talentInfo(a.key, false),
  foot: a => {
    const k = a.key;
    return `<button class="btn" data-action="tal-sub" data-key="${k}" ${canRemove(k) ? '' : 'disabled'}>−</button>` +
      `<button class="btn primary" data-action="tal-add" data-key="${k}" ${canAdd(k) ? '' : 'disabled'}>+</button>` +
      `<button class="btn" data-action="tal-max" data-key="${k}" ${canAdd(k) ? '' : 'disabled'}>Max</button>`;
  },
};

// Enchant selector: search + spec chips, grid of the slot's rarity, detail of the pending pick; Confirm commits.
function enchPool(a) {
  const q = (a.q || '').trim().toLowerCase();
  const order = s => s.length ? TREES.findIndex(t => t.name === s[0]) : -1;
  return D.enchants.filter(e => e.rarity === SLOT_RARITIES[a.slot])
    .filter(e => a.spec === 'all' || (a.spec === 'general' ? !e.specs.length : e.specs.includes(a.spec)))
    .filter(e => !q || e.name.toLowerCase().includes(q) || e.tooltip.toLowerCase().includes(q))
    .sort((x, y) => order(x.specs) - order(y.specs) || x.name.localeCompare(y.name));
}
const takenElsewhere = (a, k) => enchPicks.some((p, i) => p === k && i !== a.slot);
KINDS.enchant = {
  size: 'full',
  mount(layer) { layer.args.spec ??= 'all'; layer.args.q ??= ''; },
  head: a => `<h2>${RARITY[SLOT_RARITIES[a.slot]]} enchant</h2>`,
  body: () => `<div class="sel-filters"><input class="sel-search" type="search" data-input="ench-q" placeholder="Search" autocomplete="off">` +
    `<div class="chips" data-scroll="chips"></div></div><div class="sel-grid" data-scroll="grid"></div><div class="sel-info" data-scroll="info"></div>`,
  regions: {
    '.chips': a => {
      const pool = D.enchants.filter(e => e.rarity === SLOT_RARITIES[a.slot]);
      const chips = [['all', 'All', null]];
      if (pool.some(e => !e.specs.length)) chips.push(['general', 'General', null]);
      TREES.forEach(t => { if (pool.some(e => e.specs.includes(t.name))) chips.push([t.name, t.name, t.accent]); });
      return chips.map(([v, label, acc]) => `<button class="chip${a.spec === v ? ' on' : ''}" data-action="ench-spec" data-v="${esc(v)}"` +
        (acc ? ` style="--sacc:${acc}"` : '') + `>${esc(label)}</button>`).join('');
    },
    '.sel-grid': a => {
      const list = enchPool(a);
      if (!list.length) return '<div class="empty">No match</div>';
      return list.map(e => {
        const cls = ['choice', `q-${e.rarity}`];
        if (takenElsewhere(a, e.key) || unmetReqs(e).length) cls.push('dim');
        else if (metReqs(e).length) cls.push('reqmet');
        if (a.pick === e.key) cls.push('sel');
        return `<button class="${cls.join(' ')}" data-action="ench-pick" data-key="${e.key}"><span class="ic"><img src="${e.icon}" alt="" loading="lazy" draggable="false"></span>` +
          `<span class="nm">${esc(e.name)}</span></button>`;
      }).join('');
    },
    '.sel-info': a => {
      const e = enchByKey[a.pick];
      return e ? enchInfo(e, takenElsewhere(a, e.key), true) : '';
    },
  },
  foot: a => {
    const cur = enchPicks[a.slot], ok = a.pick !== cur && !(a.pick && takenElsewhere(a, a.pick));
    return `<button class="btn" data-action="ench-clear" ${cur ? '' : 'disabled'}>Clear</button>` +
      `<button class="btn primary" data-action="ench-confirm" ${ok ? '' : 'disabled'}>Confirm</button>`;
  },
};

// Summary: notes, the talents spent per tree, socketed enchants, pinned abilities.
function abilityTags(a) {
  const tags = [];
  if (a.school) tags.push([a.school, 'school-' + a.school.toLowerCase().split('/')[0]]);
  if (a.castTime === 'Channeled') tags.push(['Channeled']); else if (a.castTime === 0) tags.push(['Instant']); else if (a.castTime) tags.push([`${a.castTime}s cast`]);
  if (a.costValue) tags.push([a.costUnit === 'percent' ? `${Math.round(parseFloat(a.costValue) * 100)}% ${a.costPower}` : `${a.costValue} ${a.costPower}`]);
  if (a.cooldown) tags.push([`${a.cooldown} cd`]);
  if (a.duration) tags.push([a.duration]);
  if (a.source !== 'Core') tags.push([a.source]);
  return `<div class="tags">${tags.map(([s, c]) => `<span class="tag ${c || ''}">${esc(s)}</span>`).join('')}</div>`;
}
function summaryAbilities() {
  const byKey = Object.fromEntries(D.abilities.map(a => [a.key, a]));
  const pins = loadPins().filter(k => byKey[k]);
  const opts = TREES.map(t => `<optgroup label="${esc(t.name)}">` + D.abilities.filter(a => a.spec === t.name && !pins.includes(a.key))
    .map(a => `<option value="${a.key}">${esc(a.name)}${a.source !== 'Core' ? ` (${esc(a.source)})` : ''}</option>`).join('') + '</optgroup>').join('');
  const cards = pins.map((k, i) => {
    const a = byKey[k], acc = treeOf(a.spec)?.accent || 'var(--brass)';
    const note = FEATURES.notes ? `<div class="notes" contenteditable="true" data-note="${k}">${esc(lsGet(ablNoteKey(k), `abl-note-${D.slug}-${k}`) || '')}</div>` : '';
    return `<div class="abl-card" data-pin="${k}" draggable="true"><div class="abl-head">` +
      `<img class="row-ic" src="${a.icon}" alt="" style="--sacc:${acc}" draggable="false">` +
      `<div class="row-main"><div class="row-name">${esc(a.name)}</div>${abilityTags(a)}</div>` +
      `<div class="abl-ctl"><button class="grip" aria-label="Drag">⠿</button>` +
      `<button data-action="pin-up" data-key="${k}" aria-label="Move up" ${i ? '' : 'disabled'}>↑</button>` +
      `<button data-action="pin-down" data-key="${k}" aria-label="Move down" ${i < pins.length - 1 ? '' : 'disabled'}>↓</button>` +
      `<button class="rm${armed === 'rm:' + k ? ' armed' : ''}" data-action="pin-rm" data-key="${k}" aria-label="Remove">✕</button></div></div>` +
      `<div class="row-body">${esc(a.tooltipTemplate)}</div>${note}</div>`;
  }).join('');
  return `<div class="sec"><div class="sec-h">Abilities</div><div class="abl-add"><select data-input="pin-sel"><option value="">Add an ability</option>${opts}</select>` +
    `<button class="btn" data-action="pin-add" aria-label="Add">+</button></div>${cards}</div>`;
}
KINDS.summary = {
  size: 'full',
  head: () => `<h2>${esc(D.class)} · ${totalPts()}/${POINT_CAP}</h2>`,
  body: () => {
    let h = '';
    if (FEATURES.notes) {
      h += `<div class="sec"><div class="sec-h">Notes</div><div class="notes" contenteditable="true" data-note="">${esc(lsGet(notesKey(), `build-desc-${D.slug}`) || '')}</div></div>`;
    }
    const max = treeMax();
    h += '<div class="sec"><div class="sec-h">Talents</div>' + TREES.map(t => {
      const n = treePts(t.name);
      const rows = treeKeys(t.name).filter(k => talentPts(k) > 0).map(k => {
        const tl = T[k], p = talentPts(k);
        return `<button class="row" data-action="open-talent" data-key="${k}"><img class="row-ic" src="${tl.icon}" alt="">` +
          `<span class="row-main"><span class="row-name">${esc(tl.name)}</span><span class="row-rank${p >= tl.maxPts ? ' maxed' : ''}">${p}/${tl.maxPts}</span>` +
          `<span class="row-body">${esc(talentText(tl, p))}</span></span></button>`;
      }).join('');
      return `<div class="tree-sum" style="--sacc:${t.accent}"><button class="tree-sum-head" data-action="goto-tree" data-tab="${esc(t.name)}">` +
        `<span class="nm">${esc(t.name)}</span><span class="val">${n}</span>${magBar(n, max)}</button>${rows}</div>`;
    }).join('') + '</div>';
    const socketed = enchPicks.map((k, i) => [enchByKey[k], i]).filter(([e]) => e);
    if (socketed.length) {
      h += '<div class="sec"><div class="sec-h">Mystic Enchants</div>' + socketed.map(([e, i]) =>
        `<button class="row q-${e.rarity}" data-action="slot" data-slot="${i}"><img class="row-ic round" src="${e.icon}" alt="">` +
        `<span class="row-main"><span class="row-name">${esc(e.name)}</span><span class="row-body">${esc(e.tooltip)}</span>` +
        (unmetReqs(e).length ? `<span class="info-lines ln-bad">Requires ${esc(unmetReqs(e).map(refName).join(', '))}</span>` : '') +
        `</span></button>`).join('') + '</div>';
    }
    if (FEATURES.abilities && D.abilities?.length) h += summaryAbilities();
    return h;
  },
};

// Class picker: shared grid, used by the landing screen and the class overlay.
const classGrid = current => `<div class="class-grid">${CLASSES.map(c =>
  `<button class="class-card${c.slug === current ? ' current' : ''}" data-action="pick-class" data-slug="${c.slug}" style="--cls:${c.accent}">${esc(c.name)}</button>`).join('')}</div>`;
KINDS.classes = { size: 'sheet', head: () => '<h2>Class</h2>', body: () => classGrid(D?.slug) };

// Menu: saved builds for this class, copy link, reset (two taps).
KINDS.menu = {
  size: 'sheet',
  head: () => '<h2>Menu</h2>',
  body: () => {
    const mine = BUILDS.filter(b => b.class === D.slug);
    return (mine.length ? `<div class="sec-h">Saved builds</div><div class="menu-list">${mine.map((b, i) =>
      `<button class="menu-item" data-action="load-build" data-i="${BUILDS.indexOf(b)}"><span class="nm">${esc(b.name)}</span>` +
      `<span class="sub">${esc([b.focus, `${b.total} pts`].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>` : '') +
      `<div class="menu-actions"><button class="btn" data-action="copy-link">Copy link</button>` +
      `<button class="btn${armed === 'reset' ? ' armed' : ''}" data-action="reset">${armed === 'reset' ? 'Tap again' : 'Reset'}</button></div>`;
  },
};

// ─── TOOLTIP (fine pointers only) ────────────────────────────────────────────
const Tip = {
  el: null, target: null, x: 0, y: 0,
  show(target) { this.target = target; this.refresh(); },
  hide() { this.target = null; this.el?.classList.remove('visible'); },
  refresh() {
    if (!this.target) return;
    if (!document.body.contains(this.target)) { this.hide(); return; }
    let h = '';
    if (this.target.dataset.tal) h = talentInfo(this.target.dataset.tal, true);
    else if (this.target.dataset.slot !== undefined) { const e = enchByKey[enchPicks[+this.target.dataset.slot]]; if (e) h = enchInfo(e, false, true); }
    if (!h) { this.hide(); return; }
    this.el.innerHTML = h;
    this.el.classList.add('visible');
    this.move(this.x, this.y);
  },
  move(x, y) {
    this.x = x; this.y = y;
    if (!this.target) return;
    const w = this.el.offsetWidth, h = this.el.offsetHeight, g = 14;
    this.el.style.left = `${Math.max(0, x + g + w > innerWidth ? x - w - g : x + g)}px`;
    this.el.style.top = `${Math.max(0, y + g + h > innerHeight ? y - h - g : y + g)}px`;
  },
};

// ─── BACK BUTTON — layer-aware (skeleton pattern: one history entry per open layer) ──
const History = (() => {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let depth = 0, pending = 0, ignore = false, queued = false, armExit = false, exitTimer = null, toast = null;
  const target = () => Ovl.stack.length + (standalone ? 1 : 0);
  const drain = () => { if (pending > 0 && !ignore) { ignore = true; history.back(); } };
  function reconcile() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => {
      queued = false;
      const t = target();
      while (depth < t) { history.pushState({ syn: 1 }, ''); depth++; }
      if (depth > t) { pending += depth - t; depth = t; drain(); }
    });
  }
  addEventListener('popstate', () => {
    if (ignore) { ignore = false; if (pending > 0) pending--; if (pending > 0) drain(); syncUrl(); return; }
    if (depth > 0) depth--;
    syncUrl();   // a synthetic entry may hold an older URL: re-write the current build into this one
    if (Ovl.stack.length) { Ovl.close(); return; }
    if (!standalone) return;
    if (armExit) { clearTimeout(exitTimer); armExit = false; history.back(); return; }
    armExit = true;
    if (!toast) { toast = document.createElement('div'); toast.className = 'exit-toast'; toast.textContent = 'Press back again to exit'; document.body.append(toast); }
    toast.classList.add('show');
    reconcile();
    exitTimer = setTimeout(() => { armExit = false; toast.classList.remove('show'); }, 2000);
  });
  return { reconcile };
})();

// ─── EVENTS (delegated, bound once) ──────────────────────────────────────────
const focusKey = () => Ovl.stack.find(l => l.kind === 'talent')?.args.key;
function refreshFocus() { document.querySelectorAll('.tal').forEach(el => el.classList.toggle('focus', el.dataset.tal === focusKey())); }
function arm(what) {
  clearTimeout(armTimer);
  armed = what;
  if (what) armTimer = setTimeout(() => { armed = null; Ovl.refresh(); }, 3000);
}
function openSlot(i) { Ovl.open('enchant', { slot: i, pick: enchPicks[i] }); }

const ACTIONS = {
  dismiss: () => Ovl.close(),
  classes: () => Ovl.open('classes'),
  summary: () => Ovl.open('summary'),
  menu: () => Ovl.open('menu'),
  'pick-class': el => { if (el.dataset.slug === D?.slug) Ovl.close(); else location.href = `?class=${el.dataset.slug}`; },
  'tal-add': el => { if (addPoint(el.dataset.key)) refresh(); },
  'tal-sub': el => { if (removePoint(el.dataset.key)) refresh(); },
  'tal-max': el => { let n = 0; while (addPoint(el.dataset.key)) n++; if (n) refresh(); },
  'open-talent': el => Ovl.open('talent', { key: el.dataset.key }),
  'goto-tree': el => { Ovl.close(); setTab(el.dataset.tab); },
  slot: el => openSlot(+el.dataset.slot),
  'ench-spec': (el, layer) => { layer.args.spec = el.dataset.v; Ovl.render(layer); },
  'ench-pick': (el, layer) => { const k = el.dataset.key; layer.args.pick = layer.args.pick === k ? null : k; Ovl.render(layer); },
  'ench-clear': (el, layer) => { enchPicks[layer.args.slot] = null; Ovl.close(); refresh(); },
  'ench-confirm': (el, layer) => { enchPicks[layer.args.slot] = layer.args.pick || null; Ovl.close(); refresh(); },
  'pin-add': (el, layer) => {
    const sel = layer.root.querySelector('[data-input="pin-sel"]');
    if (!sel.value) return;
    savePins([...loadPins(), sel.value]);
    Ovl.render(layer);
  },
  'pin-up': (el, layer) => movePin(el.dataset.key, -1, layer),
  'pin-down': (el, layer) => movePin(el.dataset.key, 1, layer),
  'pin-rm': (el, layer) => {
    const k = el.dataset.key;
    if (armed === 'rm:' + k) { arm(null); savePins(loadPins().filter(p => p !== k)); } else arm('rm:' + k);
    Ovl.render(layer);
  },
  'load-build': el => {
    const b = BUILDS[+el.dataset.i];
    Object.keys(pts).forEach(k => delete pts[k]);
    Object.entries(b.points).forEach(([k, n]) => { if (T[k]) pts[k] = Math.min(n, T[k].maxPts); });
    applyEnchants(b.enchants);
    if (b.notes && !lsGet(notesKey())) lsSet(notesKey(), b.notes);
    Ovl.close();
    refresh();
  },
  'copy-link': el => {
    navigator.clipboard?.writeText(location.href).then(() => { el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy link'; }, 1500); });
  },
  reset: (el, layer) => {
    if (armed !== 'reset') { arm('reset'); Ovl.render(layer); return; }
    arm(null);
    Object.keys(pts).forEach(k => delete pts[k]);
    enchPicks.fill(null);
    Ovl.close();
    refresh();
  },
};
function movePin(k, dir, layer) {
  const p = loadPins(), i = p.indexOf(k), j = i + dir;
  if (i < 0 || j < 0 || j >= p.length) return;
  [p[i], p[j]] = [p[j], p[i]];
  savePins(p);
  Ovl.render(layer);
}

function layerOf(el) { return Ovl.stack.find(l => l.root.contains(el)); }

document.addEventListener('click', e => {
  const act = e.target.closest('[data-action]');
  if (armed && !(act && /^(reset|pin-rm)$/.test(act.dataset.action))) { arm(null); Ovl.refresh(); }
  if (act) { ACTIONS[act.dataset.action]?.(act, layerOf(act)); return; }
  const tal = e.target.closest('[data-tal]');
  if (tal) {
    if (FINE.matches) { if (addPoint(tal.dataset.tal)) refresh(); }   // desktop: click adds, right-click removes
    else Ovl.open('talent', { key: tal.dataset.tal });
    return;
  }
  const slot = e.target.closest('[data-slot]');
  if (slot) { openSlot(+slot.dataset.slot); return; }
  const seg = e.target.closest('[data-tab]');
  if (seg) setTab(seg.dataset.tab);
});
document.addEventListener('contextmenu', e => {
  const tal = e.target.closest('[data-tal]'), slot = e.target.closest('[data-slot]');
  if (!tal && !slot) return;
  e.preventDefault();
  if (!FINE.matches) return;   // a long press on touch must not remove anything
  if (tal && removePoint(tal.dataset.tal)) refresh();
  if (slot && enchPicks[+slot.dataset.slot]) { enchPicks[+slot.dataset.slot] = null; refresh(); }
});
document.addEventListener('mouseover', e => {
  if (!FINE.matches || Ovl.stack.length) return;
  const t = e.target.closest('[data-tal], .slot');
  if (t && t !== Tip.target) Tip.show(t);
  else if (!t && Tip.target) Tip.hide();
});
document.addEventListener('mousemove', e => Tip.move(e.clientX, e.clientY));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && Ovl.stack.length) Ovl.close(); });
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.input === 'ench-q') {
    const layer = layerOf(el);
    layer.args.q = el.value;
    layer.root.querySelector('.sel-grid').innerHTML = KINDS.enchant.regions['.sel-grid'](layer.args);
  } else if (el.dataset.note !== undefined) {
    const k = el.dataset.note;
    lsSet(k ? ablNoteKey(k) : notesKey(), el.textContent.trim() ? el.textContent : '');
  }
});
document.addEventListener('change', e => { if (e.target.dataset.input === 'pin-sel') ACTIONS['pin-add'](e.target, layerOf(e.target)); });

// Ability card drag (fine pointers; touch uses ↑ / ↓). Only a drag that starts on the grip moves a card.
let dragKey = null, gripDown = false;
document.addEventListener('pointerdown', e => { gripDown = !!e.target.closest('.abl-ctl .grip'); });
document.addEventListener('dragstart', e => {
  const card = e.target.closest?.('[data-pin]');
  if (!card) return;
  if (!gripDown) { e.preventDefault(); return; }
  dragKey = card.dataset.pin;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', e => {
  const card = dragKey && e.target.closest('[data-pin]');
  if (!card) return;
  e.preventDefault();
  document.querySelectorAll('.drop-before').forEach(el => el.classList.remove('drop-before'));
  if (card.dataset.pin !== dragKey) card.classList.add('drop-before');
});
document.addEventListener('drop', e => {
  const card = dragKey && e.target.closest('[data-pin]');
  if (!card) return;
  e.preventDefault();
  const p = loadPins().filter(k => k !== dragKey);
  p.splice(p.indexOf(card.dataset.pin), 0, dragKey);
  savePins(p);
});
document.addEventListener('dragend', () => {
  if (!dragKey) return;
  dragKey = null;
  const layer = Ovl.stack.find(l => l.kind === 'summary');
  if (layer) Ovl.render(layer);
});

// Broken-image alert (rule A-provenance-guards): never hide a failed image. Console always; banner on local
// previews or with ?debug404.
const DEBUG404 = /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) || new URLSearchParams(location.search).has('debug404');
document.addEventListener('error', e => {
  const el = e.target;
  if (el?.tagName !== 'IMG') return;
  console.error('[404] image failed to load:', el.getAttribute('src'));
  if (!DEBUG404) return;
  let b = document.querySelector('.err-banner');
  if (!b) { b = document.createElement('div'); b.className = 'err-banner'; document.body.append(b); }
  b.textContent = `404: ${el.getAttribute('src')}`;
}, true);

// ─── BOOT ────────────────────────────────────────────────────────────────────
(async function boot() {
  Tip.el = $('tooltip');
  const params = new URLSearchParams(location.search);
  CLS = CLASSES.find(c => c.slug === params.get('class'));
  if (!CLS) {
    $('topbar').innerHTML = '<span class="tb-title">Talent Calculator</span>';
    $('switcher').classList.add('hidden');
    $('planner').innerHTML = `<div class="landing">${classGrid(null)}</div>`;
    History.reconcile();
    return;
  }
  try {
    const r = await fetch(`data/${CLS.slug}.json?v=${CLS.v}`);
    if (!r.ok) throw new Error(r.status);
    D = await r.json();
  } catch (err) {
    $('planner').innerHTML = `<div class="load-error">Could not load data/${esc(CLS.slug)}.json (${esc(err.message)})</div>`;
    return;
  }
  T = D.talents;
  LAYOUT = D.layout;
  TREES = D.trees;
  POINT_CAP = D.pointCap;
  enchByKey = Object.fromEntries(D.enchants.map(e => [e.key, e]));
  Object.entries(LAYOUT).forEach(([tree, rows]) => rows.forEach((row, r) => row.forEach((k, c) => { if (k) pos[k] = { tree, row: r, col: c }; })));

  buildPlanner();
  if (params.get('build')) applyBuildString(params.get('build'));
  if (params.get('ench')) applyEnchants(params.get('ench').split(','));
  setTab(TREES[0].name);
  refresh();
  History.reconcile();
})();
