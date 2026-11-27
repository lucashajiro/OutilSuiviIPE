// IPE Builder — logique de l'interface
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const DERIVED = ['Jours ouvrés', 'Jours non ouvrés', "Heures d'ouverture", 'Jours calendaires'];
  const COLORS = ['#00B4B7', '#5731AC', '#FDAE61', '#B2DF8A', '#FB9A99', '#6BAED6', '#990033', '#8f8d96'];
  const HILITE = '#FDAE61', EXCL = '#c9d2d9', INCOMPLETE = '#eef1f4', IGNORED = '#e4e8eb';
  const SAVE = '#7BC622', OVER = '#DF5327', EXPECTED_LINE = '#5731AC';
  // Seuils ASHRAE Guideline 14 (mensuel) ; pour jour/semaine on applique les seuils horaires, plus tolérants
  const THRESH = { mois: { cv: 0.15, nmbe: 0.05 }, semaine: { cv: 0.30, nmbe: 0.10 }, jour: { cv: 0.30, nmbe: 0.10 } };
  const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const UNITS = {
    kWh: { label: 'kWh', need: [] },
    kWh_m2: { label: 'kWh/m²', need: ['surface'] },
    eur: { label: '€', need: ['cost'] },
    eur_m2: { label: '€/m²', need: ['cost', 'surface'] },
    co2: { label: 'kgCO₂e', need: ['co2'] },
    co2_m2: { label: 'kgCO₂e/m²', need: ['co2', 'surface'] },
  };

  const state = { ds: null, models: [], activeModelId: null, fit: null, corrPts: null, settings: { crit: 'ipmvp' } };
  const charts = {};

  // ---------- Stockage (chrome.storage si extension, sinon localStorage pour les tests) ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    get: k => hasChrome
      ? new Promise(r => chrome.storage.local.get(k, o => r(o[k])))
      : Promise.resolve((() => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } })()),
    set: (k, v) => hasChrome
      ? new Promise(r => chrome.storage.local.set({ [k]: v }, r))
      : Promise.resolve((() => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } })()),
  };
  const saveDs = () => store.set('ds', state.ds);
  const saveModels = () => Promise.all([store.set('models', state.models), store.set('activeModelId', state.activeModelId)]);

  // ---------- Formatage ----------
  const nf = d => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt = (v, d = 0) => (v == null || !isFinite(v)) ? '–' : nf(d).format(v);
  const pct = (v, d = 1) => (v == null || !isFinite(v)) ? '–' : nf(d).format(v * 100) + ' %';
  const smartFmt = v => { const a = Math.abs(v); return fmt(v, a >= 100 ? 1 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7); };
  const autoFmt = v => { if (Number.isInteger(v)) return fmt(v, 0); const a = Math.abs(v); return fmt(v, a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3); };
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  function periodLabel(iso, gran = state.ds?.granularity) {
    const [y, m, d] = iso.split('-');
    if (gran === 'mois') return `${MONTHS[+m - 1]} ${y}`;
    if (gran === 'semaine') return `sem. ${d}/${m}/${y}`;
    return `${d}/${m}/${y}`;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function msg(el, text, kind = '') { const e = $(el); e.textContent = text; e.className = 'msg ' + kind; }

  // ---------- Site : horaires, jours fériés, facteurs de conversion ----------
  function defaultSite() {
    return {
      country: 'FR', holidays: true, surface: null, cost: [], co2: [], address: '',
      schedule: [0, 1, 2, 3, 4, 5, 6].map(d => (d >= 1 && d <= 5 ? { open: true, from: '08:00', to: '19:00' } : { open: false, from: '', to: '' })),
    };
  }
  const toH = t => { const [h, m] = (t || '0:0').split(':').map(Number); return h + (m || 0) / 60; };
  const slotHours = s => { if (!s.open || !s.from || !s.to) return 0; let h = toH(s.to) - toH(s.from); if (h <= 0) h += 24; return h; };

  const holidayCache = {};
  function holidayChecker(site) {
    if (!site.holidays) return () => false;
    if (typeof Holidays === 'undefined' || !site.country) return undefined; // repli : jours fériés français (stats.js)
    const key = site.country;
    let hd;
    try { hd = new Holidays(key); } catch { return () => false; }
    return iso => {
      const y = iso.slice(0, 4), ck = key + y;
      if (!holidayCache[ck]) holidayCache[ck] = new Set((hd.getHolidays(+y) || []).filter(h => h.type === 'public').map(h => h.date.slice(0, 10)));
      return holidayCache[ck].has(iso);
    };
  }
  const valueAt = (list, date) => { let v = null; (list || []).forEach(e => { if (e.startDate <= date) v = e.number; }); return v; };
  function unitAvailable(u, site = state.ds?.site) {
    if (!site) return u === 'kWh';
    return UNITS[u].need.every(n => (n === 'surface' ? site.surface > 0 : (site[n] || []).length > 0));
  }
  function unitFactor(unit, date) {
    const s = state.ds.site; let f = 1;
    if (unit.endsWith('_m2')) f /= s.surface;
    if (unit.startsWith('eur')) f *= valueAt(s.cost, date) ?? NaN;
    if (unit.startsWith('co2')) f *= (valueAt(s.co2, date) ?? NaN) / 1000;
    return f;
  }

  // ---------- Données ----------
  const cols = type => state.ds ? state.ds.columns.filter(c => (type ? c.type === type : c.type !== 'ignore')).map(c => c.key) : [];
  const colType = k => state.ds.columns.find(c => c.key === k)?.type;
  const curUnit = () => state.ds?.unit || 'kWh';
  // Valeur d'une cellule, convertie dans l'unité choisie si c'est une consommation
  function val(r, k, unit = curUnit()) {
    const v = r.values[k];
    if (v == null || !isFinite(v)) return NaN;
    return colType(k) === 'conso' && unit !== 'kWh' ? v * unitFactor(unit, r.date) : v;
  }
  function label(k, unit = curUnit()) {
    if (colType(k) !== 'conso' || unit === 'kWh') return k;
    const u = UNITS[unit].label;
    return /\(kWh\)/.test(k) ? k.replace('(kWh)', `(${u})`) : `${k} (${u})`;
  }
  const exclFor = y => new Set((state.ds.excl && state.ds.excl[y]) || []);
  const colOf = k => state.ds.columns.find(c => c.key === k);
  // Couleurs : celles du dashboard Smart Impulse quand elles sont connues
  function colorOf(k) {
    const c = colOf(k);
    if (c && c.color) return c.color;
    const i = state.ds.columns.findIndex(x => x.key === k);
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  }
  function rgba(c, a) {
    let r, g, b, m;
    if ((m = /^#([0-9a-f]{6})$/i.exec(c))) { const n = parseInt(m[1], 16); r = n >> 16; g = (n >> 8) & 255; b = n & 255; }
    else if ((m = /rgba?\(([^)]+)\)/i.exec(c))) [r, g, b] = m[1].split(',').map(Number);
    else return c;
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
  }

  function enrich() {
    const ds = state.ds;
    if (!ds.site) ds.site = defaultSite();
    if (ds.holidays === false) { ds.site.holidays = false; delete ds.holidays; } // ancien format
    if (!ds.site.schedule) ds.site.schedule = defaultSite().schedule;
    if (!ds.excl) ds.excl = {};
    if (!ds.unit || !unitAvailable(ds.unit)) ds.unit = 'kWh';
    // Consommations combinées (somme de plusieurs usages)
    if (!ds.combos) ds.combos = [];
    ds.columns = ds.columns.filter(c => !c.combo);
    ds.combos.forEach(cb => {
      const parts = cb.parts.filter(k => ds.columns.some(c => c.key === k));
      if (!parts.length) return;
      ds.columns.push({ key: cb.key, type: cb.type || 'conso', combo: true, color: cb.color, sid: 'combo:' + cb.key, parts });
      ds.rows.forEach(r => {
        const vs = parts.map(k => r.values[k]);
        r.values[cb.key] = vs.every(v => v != null && isFinite(v)) ? vs.reduce((a, b) => a + b, 0) : null;
      });
    });
    const userKeys = new Set(ds.columns.filter(c => !c.derived && !c.combo).map(c => c.key));
    ds.columns = ds.columns.filter(c => !c.derived || (!userKeys.has(c.key) && DERIVED.includes(c.key)));
    DERIVED.forEach(k => {
      if (!userKeys.has(k) && !ds.columns.some(c => c.key === k)) ds.columns.push({ key: k, type: k === 'Jours calendaires' ? 'ignore' : 'facteur', derived: true });
    });
    applyTransforms(ds);
    const opts = {
      open: ds.site.schedule.map(s => !!s.open),
      hours: ds.site.schedule.map(slotHours),
      isHoliday: holidayChecker(ds.site),
    };
    ds.rows.forEach(r => {
      const c = Stats.calendarCounts(r.date, ds.granularity, opts);
      const set = (k, v) => { if (!userKeys.has(k)) r.values[k] = v; };
      set('Jours ouvrés', c.jo); set('Jours non ouvrés', c.jno); set("Heures d'ouverture", c.hours); set('Jours calendaires', c.total);
    });
    applyTransforms(ds);
    ds.rows.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Lignes utilisables pour un calcul : période complète, non exclue pour cette consommation, valeurs présentes
  // ---------- Facteurs non linéaires ----------
  // seuil : max(0, X − s) (modèle à point de changement, « 3P ») ; carre : X²
  const tfVal = (t, x, sv = t.s) => (x == null || !isFinite(x)) ? null : t.kind === 'seuil' ? Math.max(0, x - sv) : x * x;
  const tfKey = (base, kind) => (kind === 'seuil' ? `${base} au-delà du seuil` : `${base}²`);
  const transformOf = k => (state.ds && (state.ds.transforms || []).find(t => t.key === k)) || null;
  function shade(c, f) { // f > 0 : vers le blanc, f < 0 : vers le noir
    const m = /^#([0-9a-f]{6})$/i.exec(c); if (!m) return c;
    const n = parseInt(m[1], 16), ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f)));
    return '#' + ch.map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function applyTransforms(ds) {
    if (!ds.transforms) ds.transforms = [];
    const prevTypes = Object.fromEntries(ds.columns.filter(c => c.transform).map(c => [c.key, c.type]));
    ds.columns = ds.columns.filter(c => !c.transform);
    ds.transforms.forEach(t => {
      const bc = ds.columns.find(c => c.key === t.base);
      if (!bc) return;
      const base = bc.color || '#00B4B7';
      ds.columns.push({ key: t.key, type: prevTypes[t.key] || 'facteur', transform: true, sid: t.key, color: t.kind === 'carre' ? shade(base, -0.35) : shade(base, 0.25) });
      ds.rows.forEach(r => { r.values[t.key] = tfVal(t, r.values[t.base]); });
    });
  }
  const isSeuil = k => transformOf(k)?.kind === 'seuil';
  // Libellé mathématique d'un terme (le seuil peut être remplacé par une valeur testée)
  function termLabel(k, ov = {}) {
    const t = transformOf(k); if (!t) return k;
    return t.kind === 'seuil' ? `max(0, ${t.base} − ${fmt(ov[k] ?? t.s, 1)})` : `${t.base}²`;
  }
  // Valeur d'un facteur, avec éventuellement un seuil testé à la place du seuil enregistré
  function fval(r, k, unit, ov) {
    if (ov && ov[k] != null) { const t = transformOf(k); if (t) return tfVal(t, val(r, t.base, unit), ov[k]); }
    return val(r, k, unit);
  }

  // nz : facteur dont les périodes nulles sont ignorées (ex. DJU climatisation hors saison)
  function rowsIn(from, to, keys, y = null, unit = curUnit(), nz = null) {
    const ex = y ? exclFor(y) : new Set();
    return state.ds.rows.filter(r => !r.excluded && !ex.has(r.date) && r.date >= from && r.date <= to &&
      keys.every(k => isFinite(val(r, k, unit))) && (!nz || val(r, nz, unit) !== 0));
  }

  // ---------- Import CSV ----------
  function parseNumber(s) {
    if (s == null) return NaN;
    let t = String(s).replace(/["\s  ]/g, '').replace(/kwh/i, '');
    if (t === '') return NaN;
    if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
    else if (t.includes(',')) t = t.replace(',', '.');
    const v = Number(t);
    return isFinite(v) ? v : NaN;
  }
  function parseDate(s) {
    const t = String(s).trim().replace(/"/g, '').split(/[ T]/)[0];
    let m;
    if ((m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if ((m = t.match(/^(\d{1,2})[-/.](\d{4})$/))) return `${m[2]}-${m[1].padStart(2, '0')}-01`;
    if ((m = t.match(/^(\d{4})[-/](\d{1,2})$/))) return `${m[1]}-${m[2].padStart(2, '0')}-01`;
    return null;
  }
  function guessGranularity(dates) {
    if (dates.length < 2) return 'mois';
    const diffs = [];
    for (let i = 1; i < dates.length; i++) diffs.push((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
    diffs.sort((a, b) => a - b);
    const med = diffs[Math.floor(diffs.length / 2)];
    return med >= 27 ? 'mois' : med >= 6 ? 'semaine' : 'jour';
  }
  const guessType = name => /dju|degr|temp|°|occup|effectif|surface|production|ouvr|ensoleil|irrad/i.test(name) ? 'facteur' : 'conso';

  function parseCSV(text, name) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) throw new Error("Il faut au moins une ligne d'en-tête et une ligne de données.");
    const h = lines[0];
    const sep = h.includes('\t') ? '\t' : h.includes(';') ? ';' : ',';
    const header = h.split(sep).map(s => s.trim().replace(/^"|"$/g, ''));
    const rows = [], bad = [];
    lines.slice(1).forEach((l, i) => {
      const cells = l.split(sep);
      const date = parseDate(cells[0]);
      if (!date) { bad.push(i + 2); return; }
      const values = {};
      header.slice(1).forEach((k, j) => { const v = parseNumber(cells[j + 1]); values[k] = isFinite(v) ? v : null; });
      rows.push({ date, values });
    });
    if (!rows.length) throw new Error('Aucune date reconnue dans la première colonne.');
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const columns = header.slice(1).filter(k => k).map(k => ({ key: k, type: guessType(k) }));
    return {
      ds: { name: name || 'Site importé', granularity: guessGranularity(rows.map(r => r.date)), columns, rows, site: defaultSite() },
      warning: bad.length ? `Lignes ignorées (date non reconnue) : ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? '…' : ''}` : '',
    };
  }

  async function loadDataset(ds, note = '') {
    if (!ds.granularity) ds.granularity = guessGranularity(ds.rows.map(r => r.date));
    if (!ds.site) ds.site = defaultSite();
    else ds.site = { ...defaultSite(), ...Object.fromEntries(Object.entries(ds.site).filter(([, v]) => v != null)) };
    // Périodes non entièrement couvertes par les mesures (début d'instrumentation, période en cours) : exclues
    let nExcl = 0;
    if (ds.coverage) {
      ds.rows.forEach(r => {
        const end = Stats.iso(Stats.periodEnd(r.date, ds.granularity));
        r.excluded = r.date < ds.coverage.from || end > ds.coverage.to;
        if (r.excluded) nExcl++;
      });
    }
    // Exclusions conservées d'un import à l'autre pour le même site (correspondance par identifiant d'usage)
    ds.excl = {};
    const prev = state.ds;
    if (prev && prev.excl && ((ds.siteUuid && ds.siteUuid === prev.siteUuid) || ds.name === prev.name)) {
      Object.entries(prev.excl).forEach(([k, dates]) => {
        const pc = prev.columns.find(c => c.key === k);
        const nc = ds.columns.find(c => c.key === k) || (pc && pc.sid && ds.columns.find(c => c.sid === pc.sid));
        if (nc && dates.length) ds.excl[nc.key] = dates;
      });
    }
    if (prev && prev.transforms && prev.transforms.length && ((ds.siteUuid && ds.siteUuid === prev.siteUuid) || ds.name === prev.name)) {
      ds.transforms = prev.transforms.filter(t => ds.columns.some(c => c.key === t.base) || DERIVED.includes(t.base));
    }
    if (prev && prev.combos && prev.combos.length && ((ds.siteUuid && ds.siteUuid === prev.siteUuid) || ds.name === prev.name)) {
      ds.combos = prev.combos.map(cb => {
        const parts = cb.parts.map(k => {
          const pc = prev.columns.find(c => c.key === k);
          const nc = ds.columns.find(c => c.key === k) || (pc && pc.sid && ds.columns.find(c => c.sid === pc.sid));
          return nc && nc.key;
        }).filter(Boolean);
        return parts.length ? { ...cb, parts } : null;
      }).filter(Boolean);
    }
    state.ds = ds;
    ['corr-from', 'corr-to', 'ref-from', 'ref-to', 'suivi-from', 'suivi-to'].forEach(id => { $(id).innerHTML = ''; });
    state.fit = null;
    enrich();
    await saveDs();
    renderAll();
    switchTab('donnees');
    const excl = nExcl ? ` ${nExcl} période(s) incomplète(s) exclue(s) des calculs (décochées dans le tableau).` : '';
    msg('import-msg', `${ds.rows.length} périodes chargées (${periodLabel(ds.rows[0].date)} → ${periodLabel(ds.rows.at(-1).date)}).${excl} ${note}`, note ? 'err' : 'ok');
  }

  // Données envoyées par le bouton de l'extension depuis le dashboard Smart Impulse
  async function consumePending() {
    const p = await store.get('pendingImport');
    if (!p) return;
    await store.set('pendingImport', null);
    if (Date.now() - (p.at || 0) > 5 * 60 * 1000) return; // import ancien : ignoré
    if (p.error) { switchTab('donnees'); msg('import-msg', p.error, 'err'); return; }
    if (!p.ds.rows.length) { msg('import-msg', 'Le graphique du dashboard ne contient aucune donnée.', 'err'); return; }
    await loadDataset(p.ds, p.ds.site ? '' : '(Informations du site non récupérées : valeurs par défaut.)');
  }

  // ---------- Unité ----------
  function renderUnit() {
    const sel = $('unit');
    sel.innerHTML = Object.entries(UNITS).map(([k, u]) =>
      `<option value="${k}" ${unitAvailable(k) ? '' : 'disabled'}>${u.label}${unitAvailable(k) ? '' : ' (info site manquante)'}</option>`).join('');
    sel.value = curUnit();
  }

  // ---------- Rendu : onglet Données ----------
  function renderSite() {
    const s = state.ds.site;
    $('site-address').textContent = [s.address, s.timezone, s.activity].filter(Boolean).join(' · ');
    const sel = $('site-country');
    if (!sel.options.length) {
      let list = [['FR', 'France']];
      if (typeof Holidays !== 'undefined') list = Object.entries(new Holidays().getCountries('fr')).sort((a, b) => a[1].localeCompare(b[1], 'fr'));
      sel.innerHTML = list.map(([c, n]) => `<option value="${c}">${esc(n)} (${c})</option>`).join('');
    }
    sel.value = s.country || 'FR';
    $('site-holidays').checked = !!s.holidays;
    $('site-surface').value = s.surface ?? '';
    const last = l => (l && l.length ? l.at(-1).number : '');
    $('site-cost').value = last(s.cost);
    $('site-co2').value = last(s.co2);
    const multi = ['cost', 'co2'].filter(k => (s[k] || []).length > 1);
    $('site-kpi-note').textContent = multi.length
      ? `Valeurs datées issues du dashboard : ${multi.map(k => (k === 'cost' ? 'coût' : 'CO₂') + ' ' + s[k].map(e => `${fmt(e.number, 3)} dès ${e.startDate}`).join(', ')).join(' ; ')}. Chaque période utilise la valeur en vigueur. Modifier le champ remplace l'historique par une valeur unique.`
      : '';
    $('site-schedule').innerHTML = '<tr><th>Jour</th><th>Ouvert</th><th>De</th><th>À</th><th>Heures</th></tr>' + DAY_ORDER.map(d => {
      const x = s.schedule[d];
      return `<tr><td>${DAY_NAMES[d]}</td><td><input type="checkbox" data-d="${d}" data-f="open" ${x.open ? 'checked' : ''}></td>
        <td><input type="time" data-d="${d}" data-f="from" value="${x.from || ''}" ${x.open ? '' : 'disabled'}></td>
        <td><input type="time" data-d="${d}" data-f="to" value="${x.to || ''}" ${x.open ? '' : 'disabled'}></td>
        <td>${fmt(slotHours(x), 1)}</td></tr>`;
    }).join('');
    $('site-schedule').querySelectorAll('input').forEach(inp => inp.addEventListener('change', async () => {
      const x = s.schedule[+inp.dataset.d];
      if (inp.dataset.f === 'open') { x.open = inp.checked; if (x.open && !x.from) { x.from = '08:00'; x.to = '19:00'; } }
      else x[inp.dataset.f] = inp.value;
      await siteChanged();
    }));
  }
  async function siteChanged() { enrich(); await saveDs(); renderAll(false); }

  function renderDataTab() {
    const ds = state.ds;
    $('dataset-label').textContent = ds ? `${ds.name} · ${ds.rows.length} ${ds.granularity === 'mois' ? 'mois' : ds.granularity === 'semaine' ? 'semaines' : 'jours'}` : 'Aucune donnée chargée';
    if (!ds) return;
    renderUnit();
    renderSite();
    $('ds-name').value = ds.name;
    $('ds-gran').value = ds.granularity;

    $('col-table').innerHTML = '<tr><th>Colonne</th><th>Rôle</th></tr>' + ds.columns.map((c, i) => `
      <tr><td>${esc(c.key)}${c.derived ? ' <span class="muted">(calculé)</span>' : c.combo ? ' <span class="muted">(combinée)</span>' : c.transform ? ` <span class="muted">(${esc(termLabel(c.key))})</span>` : ''}</td><td>
        <select data-col="${i}">
          <option value="conso" ${c.type === 'conso' ? 'selected' : ''}>Consommation</option>
          <option value="facteur" ${c.type === 'facteur' ? 'selected' : ''}>Facteur d'influence</option>
          <option value="ignore" ${c.type === 'ignore' ? 'selected' : ''}>Ignorer</option>
        </select></td></tr>`).join('');
    $('col-table').querySelectorAll('select').forEach(s => s.addEventListener('change', async () => {
      const c = ds.columns[+s.dataset.col]; c.type = s.value;
      if (c.combo) { const cb = ds.combos.find(x => x.key === c.key); if (cb) cb.type = s.value; }
      await saveDs(); renderAll(false);
    }));
    renderCombos();

    const keys = cols();
    const sel = $('overview-series');
    const prev = [...sel.selectedOptions].map(o => o.value).filter(k => keys.includes(k));
    const chosen = prev.length ? prev : cols('conso').slice(0, 1);
    sel.innerHTML = keys.map(k => `<option value="${esc(k)}" ${chosen.includes(k) ? 'selected' : ''}>${esc(label(k))}</option>`).join('');
    sel.size = Math.min(6, keys.length);
    renderOverview();

    $('data-table').innerHTML = `<tr><th>Période</th><th title="Décocher pour exclure la période de tous les calculs (période incomplète, travaux, fermeture…)">Inclure</th>${keys.map(k => `<th>${esc(label(k))}</th>`).join('')}</tr>` +
      ds.rows.map((r, i) => `<tr class="${r.excluded ? 'excluded' : ''}"><td>${periodLabel(r.date)}</td><td><input type="checkbox" data-row="${i}" ${r.excluded ? '' : 'checked'}></td>${keys.map(k => `<td>${autoFmt(val(r, k))}</td>`).join('')}</tr>`).join('');
    $('data-table').querySelectorAll('input[data-row]').forEach(cb => cb.addEventListener('change', async () => {
      ds.rows[+cb.dataset.row].excluded = !cb.checked;
      cb.closest('tr').classList.toggle('excluded', !cb.checked);
      await saveDs(); renderCorrelations(); renderSuivi();
    }));
  }

  // ---------- Consommations combinées ----------
  function renderCombos() {
    const ds = state.ds;
    const base = ds.columns.filter(c => c.type === 'conso' && !c.combo && !c.derived);
    const checked = new Set([...$('combo-parts').querySelectorAll('input:checked')].map(i => i.value));
    $('combo-parts').innerHTML = base.map(c => `<label class="check"><input type="checkbox" value="${esc(c.key)}" ${checked.has(c.key) ? 'checked' : ''}> ${esc(c.key)}</label>`).join('')
      || '<span class="muted">Aucune consommation disponible.</span>';
    $('combo-list').innerHTML = (ds.combos || []).length
      ? '<tr><th>Consommation combinée</th><th>Composée de</th><th></th></tr>' + ds.combos.map((cb, i) =>
        `<tr><td><span class="swatch" style="background:${esc(cb.color || '#00b4b7')}"></span>${esc(cb.key)}</td><td>${esc(cb.parts.join(' + '))}</td><td><button class="link" data-del="${i}" title="Supprimer">✕</button></td></tr>`).join('')
      : '';
    $('combo-list').querySelectorAll('button[data-del]').forEach(b => b.addEventListener('click', async () => {
      const cb = ds.combos[+b.dataset.del];
      if (!confirm(`Supprimer « ${cb.key} » ?`)) return;
      ds.combos.splice(+b.dataset.del, 1);
      if (ds.excl) delete ds.excl[cb.key];
      enrich(); await saveDs(); renderAll(false);
    }));
  }
  async function createCombo() {
    const ds = state.ds; if (!ds) return;
    const parts = [...$('combo-parts').querySelectorAll('input:checked')].map(i => i.value);
    let name = $('combo-name').value.trim();
    if (parts.length < 2) { msg('combo-msg', 'Coche au moins deux consommations.', 'err'); return; }
    if (!name) { msg('combo-msg', 'Donne un nom à la nouvelle consommation.', 'err'); return; }
    if (!/\(kWh\)\s*$/.test(name)) name += ' (kWh)';
    if (ds.columns.some(c => c.key === name)) { msg('combo-msg', 'Ce nom existe déjà.', 'err'); return; }
    ds.combos = ds.combos || [];
    ds.combos.push({ key: name, parts, color: $('combo-color').value, type: 'conso' });
    enrich(); await saveDs();
    $('combo-name').value = '';
    $('combo-parts').querySelectorAll('input').forEach(i => { i.checked = false; });
    renderAll(false);
    msg('combo-msg', `« ${name} » créée (${parts.join(' + ')}).`, 'ok');
  }

  function renderOverview() {
    const ds = state.ds, chosen = [...$('overview-series').selectedOptions].map(o => o.value);
    const conso = chosen.filter(k => colType(k) === 'conso');
    makeChart('overview', $('chart-overview'), {
      type: 'line',
      data: {
        labels: ds.rows.map(r => periodLabel(r.date)),
        datasets: chosen.map((k, i) => ({
          label: label(k), data: ds.rows.map(r => val(r, k)), borderColor: colorOf(k),
          backgroundColor: colorOf(k), tension: 0.2, pointRadius: 2,
          yAxisID: conso.length && !conso.includes(k) ? 'y2' : 'y',
        })),
      },
      options: baseOptions({ y2: chosen.length > conso.length && conso.length > 0 }),
    });
  }

  function baseOptions({ y2 = false, yTitle = '' } = {}) {
    const o = {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label} : ${autoFmt(c.parsed.y)}` } } },
      scales: { y: { title: { display: !!yTitle, text: yTitle }, ticks: { callback: v => autoFmt(v) } } },
    };
    if (y2) o.scales.y2 = { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: v => autoFmt(v) } };
    return o;
  }
  function makeChart(id, canvas, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(canvas, cfg);
  }

  // ---------- Périodes : listes déroulantes, longueur de fenêtre, raccourcis ----------
  const RANGES = { corr: ['corr-from', 'corr-to', 'corr-len'], ref: ['ref-from', 'ref-to', 'ref-len'], suivi: ['suivi-from', 'suivi-to', 'suivi-len'] };
  const DEFAULT_LEN = { mois: 12, semaine: 52, jour: 365 };
  const idxOf = date => state.ds.rows.findIndex(r => r.date === date);
  const firstAtOrAfter = d => state.ds.rows.findIndex(r => r.date >= d);
  const lastAtOrBefore = d => { const rows = state.ds.rows; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].date <= d) return i; return -1; };
  const shiftYear = (iso, n) => `${+iso.slice(0, 4) + n}${iso.slice(4)}`;
  // Période la plus proche d'une date (utile en hebdomadaire : les lundis changent d'une année à l'autre)
  function nearestIdx(d) {
    const t = Date.parse(d), rows = state.ds.rows;
    if (!rows.length || t > Date.parse(rows.at(-1).date) + 7 * 86400000 || t < Date.parse(rows[0].date) - 7 * 86400000) return -1;
    let best = -1, bd = Infinity;
    rows.forEach((r, i) => { const dd = Math.abs(Date.parse(r.date) - t); if (dd < bd) { bd = dd; best = i; } });
    return best;
  }

  function getRange(kind) {
    const [f, t] = RANGES[kind], n = state.ds.rows.length;
    let a = idxOf($(f).value), b = idxOf($(t).value);
    if (a < 0) a = 0; if (b < 0) b = n - 1;
    return a <= b ? [a, b] : [b, a];
  }
  function setRange(kind, a, b) {
    const [f, t, l] = RANGES[kind], rows = state.ds.rows;
    $(f).value = rows[a].date; $(t).value = rows[b].date; $(l).value = b - a + 1;
  }
  function fillDateSelect(id) {
    $(id).innerHTML = state.ds.rows.map(r => `<option value="${r.date}">${periodLabel(r.date)}</option>`).join('');
  }
  function defaultWindow() {
    const rows = state.ds.rows, n = rows.length;
    let a = rows.findIndex(r => !r.excluded); if (a < 0) a = 0;
    const len = Math.min(DEFAULT_LEN[state.ds.granularity] || 12, n - a);
    return [a, a + len - 1];
  }
  function initDateSelects() {
    ['corr', 'ref', 'suivi'].forEach(kind => {
      const [f, t] = RANGES[kind], keep = [$(f).value, $(t).value];
      fillDateSelect(f); fillDateSelect(t);
      if (keep[0] && idxOf(keep[0]) >= 0 && idxOf(keep[1]) >= 0) { $(f).value = keep[0]; $(t).value = keep[1]; $(RANGES[kind][2]).value = getRange(kind)[1] - getRange(kind)[0] + 1; }
      else if (kind !== 'suivi') { const [a, b] = defaultWindow(); setRange(kind, a, b); }
      else { $(f).value = ''; }
    });
  }

  // Raccourcis : années civiles, 12 derniers mois, tout ; en suivi, périodes relatives à la référence de l'IPE
  function pickOptions(kind) {
    const rows = state.ds.rows, n = rows.length, out = [];
    if (!n) return out;
    [...new Set(rows.map(r => r.date.slice(0, 4)))].forEach(y => {
      const a = firstAtOrAfter(`${y}-01-01`), b = lastAtOrBefore(`${y}-12-31`);
      if (a >= 0 && b - a >= 1) out.push({ label: y, a, b });
    });
    let last = n - 1; while (last > 0 && rows[last].excluded) last--;
    const N = DEFAULT_LEN[state.ds.granularity] || 12;
    out.push({ label: state.ds.granularity === 'semaine' ? '52 dernières semaines' : state.ds.granularity === 'jour' ? '365 derniers jours' : '12 derniers mois', a: Math.max(0, last - N + 1), b: last });
    if (kind === 'suivi') {
      const m = activeModel();
      if (m) {
        const ra = firstAtOrAfter(m.refFrom), rb = lastAtOrBefore(m.refTo), len = rb - ra + 1;
        if (rb >= 0 && rb + 1 < n) {
          out.push({ label: 'Juste après la référence (même durée)', a: rb + 1, b: Math.min(n - 1, rb + len) });
          out.push({ label: 'Depuis la fin de la référence', a: rb + 1, b: n - 1 });
        }
        if (ra > 0) out.push({ label: 'Juste avant la référence (même durée)', a: Math.max(0, ra - len), b: ra - 1 });
        const pa = nearestIdx(shiftYear(m.refFrom, -1)), pb = nearestIdx(shiftYear(m.refTo, -1));
        if (pb >= 0 && (pa >= 0 || pb > 0)) out.push({ label: 'Même période, année précédente', a: pa >= 0 ? pa : 0, b: pb });
        const sa = nearestIdx(shiftYear(m.refFrom, 1));
        let sb = nearestIdx(shiftYear(m.refTo, 1));
        if (sa >= 0 && sb < 0) sb = n - 1; // année suivante pas encore complète : jusqu'à la dernière période
        if (sa >= 0 && sb >= sa) out.push({ label: 'Même période, année suivante', a: sa, b: sb });
      }
    } else out.push({ label: "Tout l'historique", a: 0, b: n - 1 });
    return out.filter(o => o.a >= 0 && o.b >= o.a);
  }
  function renderPicks(kind) {
    const box = $(kind + '-picks'), opts = pickOptions(kind);
    box.innerHTML = opts.map((o, i) => `<button data-i="${i}" title="${periodLabel(state.ds.rows[o.a].date)} → ${periodLabel(state.ds.rows[o.b].date)}">${esc(o.label)}</button>`).join('');
    box.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      const o = opts[+btn.dataset.i]; setRange(kind, o.a, o.b); rangeChanged(kind);
    }));
  }
  function rangeChanged(kind) {
    if (kind === 'corr') { renderMatrix(); renderScatter(true); }
    if (kind === 'ref') { renderTimeline('ref'); if (state.fit) fitModel(); }
    if (kind === 'suivi') renderSuivi(true);
  }

  // ---------- Frise temporelle avec fenêtre glissable ----------
  const timelines = {
    bars: {
      canvas: 'chart-bars', kind: 'corr', label: 'Période étudiée', clickable: true,
      y: () => $('scatter-y').value,
      y2: () => ($('scatter-x').value !== $('scatter-y').value ? $('scatter-x').value : null),
      ignored: r => $('corr-nonzero').checked && val(r, $('scatter-x').value) === 0,
      changed: () => { renderMatrix(); renderScatter(false); },
      hover: date => {
        const i = date == null || !state.corrPts ? -1 : state.corrPts.findIndex(p => p.date === date);
        setActive(charts.scatter, i < 0 ? null : i);
      },
    },
    ref: {
      canvas: 'chart-ref-bars', kind: 'ref', label: 'Référence', clickable: true,
      y: () => $('model-y').value,
      y2: () => $('fit-y2').value || null,
      ignored: r => !!$('model-nonzero').value && val(r, $('model-nonzero').value) === 0,
      changed: () => { if (state.fit) fitModel(); },
      hover: () => {},
    },
    suivi: {
      canvas: 'chart-suivi', kind: 'suivi', label: 'Suivi', clickable: false, fill: 'rgba(123,198,34,0.14)', edge: '#6aae1c',
      changed: () => renderSuivi(false),
      hover: () => {},
      zoom: { zoomed: () => !!state.suiviZoom, at: zoomSuiviAt, pan: panSuivi, view: suiviView, set: setSuiviZoom },
    },
  };
  Object.values(timelines).forEach(tl => { tl.range = () => getRange(tl.kind); tl.set = (a, b) => setRange(tl.kind, a, b); });

  const windowPlugin = {
    id: 'periodWindow',
    beforeDatasetsDraw(chart) {
      const tl = timelines[chart.$tl]; if (!tl || !state.ds) return;
      const x = chart.scales.x, area = chart.chartArea, c = chart.ctx, n = state.ds.rows.length;
      const half = n > 1 ? Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0)) / 2 : 20;
      const band = ([a, b], fill, edge, text, handles) => {
        const l = Math.max(area.left, x.getPixelForValue(a) - half), r = Math.min(area.right, x.getPixelForValue(b) + half);
        if (r <= l) return; // zone hors de la partie affichée (graphique zoomé)
        c.fillStyle = fill; c.fillRect(l, area.top, r - l, area.bottom - area.top);
        c.fillStyle = edge;
        c.fillRect(l - 1, area.top, 2, area.bottom - area.top); c.fillRect(r - 1, area.top, 2, area.bottom - area.top);
        if (handles) [l, r].forEach(px => c.fillRect(px - 4, (area.top + area.bottom) / 2 - 12, 8, 24));
        c.font = '600 11px system-ui, sans-serif'; c.textBaseline = 'top';
        c.fillText(text, l + 6, area.top + 4);
      };
      c.save();
      if (chart.$fixed && chart.$fixed[0] >= 0 && chart.$fixed[1] >= chart.$fixed[0]) band(chart.$fixed, 'rgba(0,180,183,0.10)', '#00B4B7', 'Référence', false);
      band(tl.range(), tl.fill || 'rgba(0,180,183,0.12)', tl.edge || '#00B4B7', tl.label, true);
      c.restore();
    },
  };

  function y2Dataset(f, rows) {
    return { type: 'line', label: label(f), data: rows.map(r => val(r, f)), yAxisID: 'y2', borderColor: colorOf(f), backgroundColor: colorOf(f), pointRadius: 0, borderWidth: 1.5, tension: 0.2, order: 0 };
  }

  function renderTimeline(key) {
    const tl = timelines[key], y = tl.y();
    if (!state.ds || !y) return;
    const rows = state.ds.rows, f2 = tl.y2();
    const base = colorOf(y);
    const color = i => {
      const r = rows[i], [a, b] = tl.range(), inside = i >= a && i <= b;
      if (r.excluded) return INCOMPLETE;
      if (exclFor(tl.y()).has(r.date)) return EXCL;
      if (tl.ignored(r)) return IGNORED;
      return inside ? base : rgba(base, 0.35);
    };
    const datasets = [{
      type: 'bar', label: label(y), data: rows.map(r => val(r, y)), order: 1,
      backgroundColor: ctx => color(ctx.dataIndex), hoverBackgroundColor: HILITE,
      borderColor: rows.map(r => (r.excluded ? '#c9d2d9' : 'transparent')), borderWidth: 1,
    }];
    if (f2) datasets.push(y2Dataset(f2, rows));
    const opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      events: ['mousemove', 'mouseout'],
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !!f2, labels: { boxWidth: 12 } },
        tooltip: { callbacks: { label: c => {
          if (c.datasetIndex > 0) return `${c.dataset.label} : ${autoFmt(c.parsed.y)}`;
          const r = rows[c.dataIndex];
          return `${c.dataset.label} : ${autoFmt(c.parsed.y)}${r.excluded ? ' (période incomplète)' : exclFor(tl.y()).has(r.date) ? ' (exclue)' : tl.ignored(r) ? ' (facteur nul, ignorée)' : ''}`;
        } } },
      },
      scales: { y: { title: { display: true, text: label(y) }, ticks: { callback: v => autoFmt(v) } }, x: { ticks: { autoSkip: true, maxRotation: 60 } } },
    };
    if (f2) opts.scales.y2 = { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: label(f2) }, ticks: { callback: v => autoFmt(v) } };
    makeChart(key, $(tl.canvas), { data: { labels: rows.map(r => periodLabel(r.date)), datasets }, plugins: [windowPlugin], options: opts });
    charts[key].$tl = key;
    bindTimelineMouse(key);
  }

  function bindTimelineMouse(key) {
    const tl = timelines[key], cv = $(tl.canvas);
    if (cv.dataset.bound) return;
    cv.dataset.bound = '1';
    let drag = null, raf = 0;
    const geo = e => {
      const chart = charts[key], rect = cv.getBoundingClientRect(), x = e.clientX - rect.left, sx = chart.scales.x;
      const n = state.ds.rows.length;
      const idx = Math.max(0, Math.min(n - 1, Math.round(sx.getValueForPixel(x))));
      const [a, b] = tl.range();
      const half = n > 1 ? Math.abs(sx.getPixelForValue(1) - sx.getPixelForValue(0)) / 2 : 20;
      const lp = sx.getPixelForValue(a) - half, rp = sx.getPixelForValue(b) + half;
      const zone = Math.abs(x - lp) < 7 ? 'l' : Math.abs(x - rp) < 7 ? 'r' : (x > lp && x < rp ? 'm' : 'n');
      return { x, idx, a, b, zone };
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; tl.changed(); }); };
    cv.addEventListener('mousedown', e => {
      if (!charts[key] || !state.ds) return;
      const g = geo(e);
      const ca = charts[key].chartArea;
      drag = { mode: g.zone, x0: g.x, i0: g.idx, a0: g.a, b0: g.b, moved: false,
               view0: tl.zoom ? tl.zoom.view() : null, areaW: ca.right - ca.left };
      e.preventDefault();
    });
    if (tl.zoom) cv.addEventListener('wheel', e => {
      if (!charts[key] || !state.ds) return;
      const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!(e.ctrlKey || e.metaKey) && !(horiz && tl.zoom.zoomed())) return; // molette seule : défilement de la page
      e.preventDefault();
      const g = geo(e);
      if (horiz) { const [lo, hi] = tl.zoom.view(); tl.zoom.pan(Math.sign(e.deltaX) * Math.max(1, Math.round((hi - lo + 1) * 0.1))); }
      else tl.zoom.at(g.idx, e.deltaY < 0);
    }, { passive: false });
    cv.addEventListener('mousemove', e => {
      if (!charts[key] || drag || !state.ds) return;
      const g = geo(e);
      cv.style.cursor = g.zone === 'l' || g.zone === 'r' ? 'ew-resize' : g.zone === 'm' ? 'grab' : (tl.clickable ? 'pointer' : tl.zoom && tl.zoom.zoomed() ? 'move' : 'default');
      tl.hover(state.ds.rows[g.idx].date);
    });
    cv.addEventListener('mouseleave', () => { if (!drag) tl.hover(null); });
    window.addEventListener('mousemove', e => {
      if (!drag || !charts[key]) return;
      const g = geo(e), n = state.ds.rows.length;
      if (Math.abs(g.x - drag.x0) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (drag.mode === 'n') {
        // Hors de la zone : déplacement de la vue quand le graphique est zoomé
        if (tl.zoom && tl.zoom.zoomed() && drag.view0) {
          const perBar = drag.areaW / (drag.view0[1] - drag.view0[0] + 1);
          const shift = Math.round((drag.x0 - g.x) / perBar);
          cv.style.cursor = 'grabbing';
          tl.zoom.set([drag.view0[0] + shift, drag.view0[1] + shift]);
        }
        return;
      }
      cv.style.cursor = drag.mode === 'm' ? 'grabbing' : 'ew-resize';
      const d = g.idx - drag.i0, minLen = key === 'suivi' ? 0 : 2;
      let na = drag.a0, nb = drag.b0;
      if (drag.mode === 'm') { const len = drag.b0 - drag.a0; na = Math.max(0, Math.min(n - 1 - len, drag.a0 + d)); nb = na + len; }
      if (drag.mode === 'l') na = Math.max(0, Math.min(drag.b0 - minLen, drag.a0 + d));
      if (drag.mode === 'r') nb = Math.min(n - 1, Math.max(drag.a0 + minLen, drag.b0 + d));
      const [ca, cb] = tl.range();
      if (na !== ca || nb !== cb) { tl.set(na, nb); charts[key].update('none'); schedule(); }
    });
    window.addEventListener('mouseup', async () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moved && tl.clickable && charts[key]) {
        const r = state.ds.rows[d.i0];
        if (r && !r.excluded) await toggleExclusion(tl.y(), r.date);
      }
    });
  }

  function setActive(chart, idx, dsIndex = 0) {
    if (!chart) return;
    const els = idx == null ? [] : [{ datasetIndex: dsIndex, index: idx }];
    chart.setActiveElements(els);
    const meta = idx == null ? null : chart.getDatasetMeta(dsIndex).data[idx];
    chart.tooltip.setActiveElements(els, meta ? { x: meta.x, y: meta.y } : { x: 0, y: 0 });
    chart.update('none');
  }
  function highlightBar(date) {
    const idx = date == null ? -1 : idxOf(date);
    setActive(charts.bars, idx < 0 ? null : idx);
  }

  // ---------- Rendu : Corrélations ----------
  function renderCorrelations() {
    if (!state.ds) return;
    const keys = cols(), ys = cols('conso');
    const sy = $('scatter-y').value, sx = $('scatter-x').value;
    $('scatter-y').innerHTML = ys.map(k => `<option value="${esc(k)}">${esc(label(k))}</option>`).join('');
    $('scatter-x').innerHTML = keys.map(k => `<option value="${esc(k)}">${esc(label(k))}</option>`).join('');
    if (ys.includes(sy)) $('scatter-y').value = sy;
    $('scatter-x').value = keys.includes(sx) ? sx : (cols('facteur')[0] || keys[1] || keys[0]);
    renderPicks('corr');
    renderMatrix();
    renderScatter();
  }

  function renderMatrix() {
    const keys = cols(), ys = cols('conso');
    const [a, b] = getRange('corr'), from = state.ds.rows[a].date, to = state.ds.rows[b].date;
    const nz = $('corr-nonzero').checked;
    const pairR = (y, x) => {
      const pts = rowsIn(from, to, [x, y], y, curUnit(), nz && colType(x) === 'facteur' ? x : null);
      return Stats.pearson(pts.map(r => val(r, y)), pts.map(r => val(r, x)));
    };
    let html = `<tr><th></th>${keys.map(k => `<th>${esc(label(k))}</th>`).join('')}</tr>`;
    ys.forEach(y => {
      html += `<tr><th>${esc(label(y))}</th>` + keys.map(x => {
        if (x === y) return '<td class="diag">–</td>';
        const r = pairR(y, x), r2 = r * r;
        const bg = isFinite(r2) ? `rgba(0,180,183,${(r2 * 0.9).toFixed(2)})` : 'transparent';
        const fg = r2 > 0.5 ? '#fff' : 'inherit';
        const sel = $('scatter-y').value === y && $('scatter-x').value === x ? ' sel' : '';
        return `<td class="cell${sel}" data-y="${esc(y)}" data-x="${esc(x)}" style="background:${bg};color:${fg}" title="r = ${fmt(r, 3)}">${fmt(r2, 2)}${r < 0 ? ' (−)' : ''}</td>`;
      }).join('') + '</tr>';
    });
    $('corr-matrix').innerHTML = html;
    $('corr-matrix').querySelectorAll('td.cell').forEach(td => td.addEventListener('click', () => {
      $('scatter-y').value = td.dataset.y; $('scatter-x').value = td.dataset.x; renderMatrix(); renderScatter();
    }));
  }

  // Régression à une variable selon la forme choisie : linéaire, seuil (point de changement) ou quadratique
  function simpleFit(pts, form = 'lin') {
    const inc = pts.filter(p => !p.out);
    if (inc.length < 4) return null;
    const ys = inc.map(p => p.y), xs = inc.map(p => p.x);
    if (form === 'carre') {
      const m = Stats.ols(ys, { x: xs, x2: xs.map(v => v * v) });
      if (m.error) return null;
      return { ...m, form, predict: v => m.coefs[0] + m.coefs[1] * v + m.coefs[2] * v * v,
        eq: `y = ${smartFmt(m.coefs[0])} ${sgn(m.coefs[1])} ${smartFmt(Math.abs(m.coefs[1]))} × x ${sgn(m.coefs[2])} ${smartFmt(Math.abs(m.coefs[2]))} × x²` };
    }
    if (form === 'seuil') {
      const sorted = [...xs].sort((a, b) => a - b), minAbove = Math.max(3, Math.ceil(sorted.length * 0.15));
      const lo = sorted[0], hi = sorted[sorted.length - minAbove - 1];
      if (!(hi > lo)) return null;
      const fitAt = sv => Stats.ols(ys, { h: xs.map(v => Math.max(0, v - sv)) }, true, 1);
      let best = null;
      const scan = (a, b, steps) => { for (let i = 0; i <= steps; i++) { const sv = a + (b - a) * i / steps, m = fitAt(sv); if (!m.error && (!best || m.sse < best.m.sse)) best = { sv, m }; } };
      scan(lo, hi, 80);
      const step = (hi - lo) / 80; scan(Math.max(lo, best ? best.sv - step : lo), Math.min(hi, best ? best.sv + step : hi), 40);
      if (!best) return null;
      const sv = Math.round(best.sv * 10) / 10, m = fitAt(sv);
      return { ...m, form, s: sv, predict: v => m.coefs[0] + m.coefs[1] * Math.max(0, v - sv),
        eq: `y = ${smartFmt(m.coefs[0])} ${sgn(m.coefs[1])} ${smartFmt(Math.abs(m.coefs[1]))} × max(0, x − ${fmt(sv, 1)})` };
    }
    const m = Stats.ols(ys, { x: xs });
    if (m.error) return null;
    return { ...m, form: 'lin', predict: v => m.coefs[0] + m.coefs[1] * v, eq: `y = ${smartFmt(m.coefs[0])} ${sgn(m.coefs[1])} ${smartFmt(Math.abs(m.coefs[1]))} × x` };
  }
  const sgn = v => (v < 0 ? '−' : '+');
  const corrForm = () => (colType($('scatter-x').value) === 'facteur' && !transformOf($('scatter-x').value) ? $('corr-form').value : 'lin');

  function scatterPoints() {
    const y = $('scatter-y').value, x = $('scatter-x').value, ex = exclFor(y);
    const [a, b] = getRange('corr'), nz = $('corr-nonzero').checked;
    return state.ds.rows.slice(a, b + 1)
      .filter(r => !r.excluded && isFinite(val(r, x)) && isFinite(val(r, y)) && !(nz && val(r, x) === 0))
      .map(r => ({ x: val(r, x), y: val(r, y), date: r.date, out: ex.has(r.date) }));
  }

  function renderScatter(withBars = true) {
    const y = $('scatter-y').value, x = $('scatter-x').value;
    if (!y || !x) return;
    const pts = scatterPoints();
    state.corrPts = pts;
    const k = Math.max(0.1, (+$('rmse-k').value || 200) / 100);
    const m = x !== y ? simpleFit(pts, corrForm()) : null;
    $('corr-form').disabled = !(colType(x) === 'facteur' && !transformOf(x));
    const nOut = pts.filter(p => p.out).length, cy = colorOf(y);

    const sc = [{
      label: 'Périodes', type: 'scatter', data: pts.map(p => ({ x: p.x, y: p.y, date: p.date, out: p.out })),
      pointRadius: 5, pointHoverRadius: 8,
      backgroundColor: pts.map(p => (p.out ? '#fff' : rgba(cy, 0.8))),
      borderColor: pts.map(p => (p.out ? '#9aa7b1' : cy)), borderWidth: 1.5,
      hoverBackgroundColor: HILITE, hoverBorderColor: HILITE,
    }];
    let info = '';
    if (m) {
      const xs = pts.map(p => p.x), lo = Math.min(...xs), hi = Math.max(...xs);
      // Courbe échantillonnée (droite, point de changement ou parabole), coude inclus
      const xsC = Array.from({ length: 81 }, (_, i) => lo + (hi - lo) * i / 80);
      if (m.s != null && m.s > lo && m.s < hi) xsC.push(m.s);
      xsC.sort((p1, p2) => p1 - p2);
      const line = off => xsC.map(v => ({ x: v, y: m.predict(v) + off }));
      sc.push({ label: m.form === 'seuil' ? 'Régression à seuil' : m.form === 'carre' ? 'Régression quadratique' : 'Régression', type: 'line', data: line(0), borderColor: '#212b36', pointRadius: 0, borderWidth: 2 });
      sc.push({ label: `± ${fmt(k * 100)} % RMSE`, type: 'line', data: line(k * m.rmse), borderColor: '#9aa7b1', borderDash: [5, 5], pointRadius: 0, borderWidth: 1 });
      sc.push({ label: '', type: 'line', data: line(-k * m.rmse), borderColor: '#9aa7b1', borderDash: [5, 5], pointRadius: 0, borderWidth: 1 });
      info = `${m.eq} &nbsp;·&nbsp; R² = <b class="${m.r2 >= 0.75 ? 'good' : 'warn'}">${fmt(m.r2, 3)}</b> &nbsp;·&nbsp; RMSE = ${autoFmt(m.rmse)} &nbsp;·&nbsp; CV(RMSE) = <span class="${m.cvrmse < 0.2 ? 'good' : 'warn'}">${pct(m.cvrmse)}</span> &nbsp;·&nbsp; n = ${m.n}${m.form === 'seuil' ? ` &nbsp;·&nbsp; seuil = <b>${fmt(m.s, 1)}</b> (1 ddl en moins)` : ''}`;
      state.corrFit = m;
    }
    if (nOut) info += ` &nbsp;·&nbsp; <span class="warn">${nOut} période(s) exclue(s) pour cette consommation</span>`;
    $('scatter-info').innerHTML = info;

    makeChart('scatter', $('chart-scatter'), {
      type: 'scatter', data: { datasets: sc },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        onHover: (evt, els, chart) => {
          const el = els.find(e => e.datasetIndex === 0);
          chart.canvas.style.cursor = el ? 'pointer' : 'default';
          highlightBar(el ? pts[el.index].date : null);
        },
        onClick: (evt, els) => { const el = els.find(e => e.datasetIndex === 0); if (el) toggleExclusion(y, pts[el.index].date); },
        plugins: {
          legend: { labels: { filter: l => l.text !== '' } },
          tooltip: { filter: i => i.datasetIndex === 0, callbacks: { label: c => `${periodLabel(c.raw.date)} : x = ${autoFmt(c.raw.x)}, y = ${autoFmt(c.raw.y)}${c.raw.out ? ' (exclue)' : ''}` } },
        },
        scales: { x: { type: 'linear', beginAtZero: true, title: { display: true, text: label(x) } }, y: { beginAtZero: true, title: { display: true, text: label(y) }, ticks: { callback: v => autoFmt(v) } } },
      },
    });
    if (withBars) renderTimeline('bars');
    else if (charts.bars) charts.bars.update('none');
  }

  async function toggleExclusion(y, date) {
    const ds = state.ds, set = exclFor(y);
    set.has(date) ? set.delete(date) : set.add(date);
    ds.excl[y] = [...set].sort();
    await saveDs();
    // Les deux onglets partagent les exclusions
    if ($('scatter-y').value === y) { renderMatrix(); renderScatter(); }
    if ($('model-y').value === y) { if (charts.ref) charts.ref.update('none'); if (state.fit && state.fit.y === y) fitModel(); }
  }

  async function applyRmseFilter() {
    const y = $('scatter-y').value, pts = scatterPoints(), m = simpleFit(pts, corrForm());
    if (!m) return;
    const k = Math.max(0.1, (+$('rmse-k').value || 200) / 100);
    const set = exclFor(y);
    let n = 0;
    pts.filter(p => !p.out).forEach(p => { if (Math.abs(p.y - m.predict(p.x)) > k * m.rmse) { set.add(p.date); n++; } });
    state.ds.excl[y] = [...set].sort();
    await saveDs();
    renderMatrix(); renderScatter();
    if (!n) $('scatter-info').innerHTML += ' &nbsp;·&nbsp; aucun point au-delà du seuil';
  }

  async function resetExclusions() {
    delete state.ds.excl[$('scatter-y').value];
    await saveDs();
    renderMatrix(); renderScatter();
  }

  const factorIdx = res => res.terms.map((_, i) => i).filter(i => !(res.intercept && i === 0));

  // ---------- Rendu : Modèle ----------
  function renderModelTab() {
    if (!state.ds) return;
    const ys = cols('conso'), fs = cols('facteur');
    const cur = $('model-y').value;
    $('model-y').innerHTML = ys.map(k => `<option value="${esc(k)}">${esc(label(k))}</option>`).join('');
    if (ys.includes(cur)) $('model-y').value = cur;
    const checked = new Set([...$('model-factors').querySelectorAll('input:checked')].map(i => i.value));
    $('model-factors').innerHTML = fs.map(f => `<label class="check" title="${esc(termLabel(f))}"><input type="checkbox" value="${esc(f)}" ${checked.has(f) ? 'checked' : ''}> ${esc(transformOf(f) ? termLabel(f) : f)}</label>`).join('')
      || "<span class=\"muted\">Aucune colonne définie comme facteur d'influence (onglet Données).</span>";
    ['model-nonzero', 'fit-y2'].forEach(id => {
      const v = $(id).value;
      $(id).innerHTML = `<option value="">${id === 'fit-y2' ? '(aucun)' : '(aucun facteur)'}</option>` + fs.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
      if (fs.includes(v)) $(id).value = v;
    });
    renderNonLinear();
    renderPicks('ref');
    renderTimeline('ref');
  }

  // ov : seuils testés { clé du facteur à seuil : valeur } (sinon seuils enregistrés)
  function currentFit(factors, ov = {}) {
    const y = $('model-y').value, [a, b] = getRange('ref'), unit = curUnit();
    const from = state.ds.rows[a].date, to = state.ds.rows[b].date, nz = $('model-nonzero').value || null;
    const rows = rowsIn(from, to, [y, ...factors], y, unit, nz);
    const X = {}; factors.forEach(f => { X[f] = rows.map(r => fval(r, f, unit, ov)); });
    const extra = factors.filter(isSeuil).length; // chaque seuil estimé = un paramètre de plus
    const res = Stats.ols(rows.map(r => val(r, y)), X, $('model-intercept').checked, extra);
    return { res, rows, y, from, to, unit, nz, ov, nExcl: [...exclFor(y)].filter(d => d >= from && d <= to).length };
  }

  // Recherche du seuil qui minimise la somme des carrés des résidus (balayage puis affinage)
  function optimizeThreshold(key, factors, ov = {}) {
    const t = transformOf(key); if (!t) return null;
    const y = $('model-y').value, [a, b] = getRange('ref'), unit = curUnit();
    const rows = rowsIn(state.ds.rows[a].date, state.ds.rows[b].date, [y, t.base], y, unit, $('model-nonzero').value || null);
    const xs = rows.map(r => val(r, t.base, unit)).sort((p, q) => p - q);
    if (xs.length < 5) return null;
    const minAbove = Math.max(3, Math.ceil(xs.length * 0.15)); // garder assez de points au-delà du seuil
    const lo = xs[0], hi = xs[xs.length - minAbove - 1];
    if (!(hi > lo)) return null;
    const fs = factors.includes(key) ? factors : [...factors, key];
    const sse = sv => { const r = currentFit(fs, { ...ov, [key]: sv }).res; return r.error ? Infinity : r.sse; };
    let best = lo, bestE = Infinity;
    const scan = (from, to, steps) => { for (let i = 0; i <= steps; i++) { const sv = from + (to - from) * i / steps, e = sse(sv); if (e < bestE) { bestE = e; best = sv; } } };
    scan(lo, hi, 60);
    const step = (hi - lo) / 60;
    scan(Math.max(lo, best - step), Math.min(hi, best + step), 30);
    return Math.round(best * 10) / 10;
  }

  function renderNonLinear() {
    const ds = state.ds;
    const bases = ds.columns.filter(c => c.type === 'facteur' && !c.transform).map(c => c.key);
    const cur = $('nl-base').value;
    $('nl-base').innerHTML = bases.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
    if (bases.includes(cur)) $('nl-base').value = cur;
    const list = ds.transforms || [];
    $('nl-list').innerHTML = list.length ? '<tr><th>Facteur</th><th>Forme</th><th>Seuil s</th><th></th></tr>' + list.map((t, i) => `
      <tr><td>${esc(t.base)}</td><td>${t.kind === 'seuil' ? 'max(0, X − s)' : 'X²'}</td>
      <td>${t.kind === 'seuil' ? `<input type="number" step="0.1" class="num" data-s="${i}" value="${t.s}"> <button class="secondary" data-opt="${i}" title="Rechercher le seuil qui minimise l'erreur du modèle">Optimiser</button>` : '–'}</td>
      <td><button class="link" data-del="${i}" title="Supprimer">✕</button></td></tr>`).join('') : '';
    $('nl-list').querySelectorAll('input[data-s]').forEach(inp => inp.addEventListener('change', async () => {
      const v = parseFloat(inp.value); if (!isFinite(v)) return;
      list[+inp.dataset.s].s = v; await transformsChanged();
    }));
    $('nl-list').querySelectorAll('button[data-opt]').forEach(btn => btn.addEventListener('click', async () => {
      const t = list[+btn.dataset.opt];
      const others = checkedFactors().filter(f => f !== t.key && f !== t.base && transformOf(f)?.base !== t.base);
      const sv = optimizeThreshold(t.key, others);
      if (sv == null) { msg('model-msg', 'Seuil introuvable : pas assez de points sur la période de référence.', 'err'); return; }
      t.s = sv; await transformsChanged();
      msg('model-msg', `Seuil optimal pour ${t.base} : ${fmt(sv, 1)}.`, 'ok');
    }));
    $('nl-list').querySelectorAll('button[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      list.splice(+btn.dataset.del, 1); await transformsChanged();
    }));
  }
  const checkedFactors = () => [...$('model-factors').querySelectorAll('input:checked')].map(i => i.value);
  async function transformsChanged(check = [], uncheck = []) {
    const keep = new Set(checkedFactors()); check.forEach(k => keep.add(k)); uncheck.forEach(k => keep.delete(k));
    enrich(); await saveDs();
    renderAll(false);
    $('model-factors').querySelectorAll('input').forEach(i => { i.checked = keep.has(i.value); });
    if (state.fit || check.length) fitModel();
  }
  async function addTransform() {
    const ds = state.ds, base = $('nl-base').value, kind = $('nl-kind').value;
    if (!base) return;
    const key = tfKey(base, kind);
    if ((ds.transforms || []).some(t => t.key === key)) { msg('model-msg', 'Ce facteur existe déjà (voir la liste).', 'err'); return; }
    ds.transforms = ds.transforms || [];
    const t = { key, base, kind, s: 0 };
    ds.transforms.push(t);
    enrich();
    if (kind === 'seuil') {
      // Modèle à point de changement : remplace le facteur linéaire, seuil optimisé avec les autres facteurs cochés
      const others = checkedFactors().filter(f => f !== base && transformOf(f)?.base !== base);
      const sv = optimizeThreshold(key, others);
      if (sv == null) { ds.transforms.pop(); enrich(); msg('model-msg', 'Seuil introuvable : pas assez de points sur la période de référence.', 'err'); return; }
      t.s = sv;
      await transformsChanged([key], [base]);
      msg('model-msg', `Facteur « max(0, ${base} − ${fmt(sv, 1)}) » ajouté (seuil optimisé) à la place de « ${base} ». Le seuil compte comme un paramètre estimé : un degré de liberté en moins.`, 'ok');
    } else {
      await transformsChanged([key, base], []);
      msg('model-msg', `Facteur « ${base}² » ajouté avec « ${base} » (modèle quadratique). Attention à l'extrapolation hors de la plage de référence.`, 'ok');
    }
  }

  function fitModel() {
    const factors = [...$('model-factors').querySelectorAll('input:checked')].map(i => i.value);
    if (!factors.length) { msg('model-msg', "Coche au moins un facteur d'influence.", 'err'); return; }
    const fit = currentFit(factors);
    const { res } = fit;
    if (res.error) { msg('model-msg', res.error, 'err'); state.fit = null; return; }
    const notes = [];
    if (fit.nExcl) notes.push(`${fit.nExcl} période(s) exclue(s) manuellement pour cette consommation`);
    if (fit.nz) notes.push(`périodes où « ${fit.nz} » = 0 ignorées : modèle valable seulement quand ce facteur est non nul`);
    if (res.extra) notes.push(`${res.extra} seuil(s) estimé(s) compté(s) comme paramètre(s) : ${res.extra} degré(s) de liberté en moins`);
    msg('model-msg', notes.length ? notes.join(' · ') + '.' : '');
    state.fit = fit;
    const u = UNITS[fit.unit].label;
    const terms = res.terms.map((name, i) => {
      if (res.intercept && i === 0) return smartFmt(res.coefs[i]);
      const c = res.coefs[i];
      return `${(i === 0 ? (c < 0 ? '−' : '') : (c < 0 ? ' − ' : ' + '))}${smartFmt(Math.abs(c))} × ${esc(termLabel(name))}`;
    });
    $('model-eq').className = 'equation';
    $('model-eq').innerHTML = `<b>${esc(label(fit.y))}</b> = ${terms.join('').replace(/^ \+ /, '')}`;

    const kpi = (lab, v, tip = '', ok) => `<div class="kpi ${ok === undefined ? '' : ok ? 'ok' : 'bad'}" title="${tip}"><div class="v">${v}</div><div class="l">${lab}</div></div>`;
    $('model-kpis').innerHTML =
      kpi('R² (après filtres)', fmt(res.r2, 3), 'Calculé sur les périodes retenues, après exclusions et filtres. Vert si ≥ 0,75', res.r2 >= 0.75) +
      kpi(`RMSE (${u})`, autoFmt(res.rmse), 'Erreur type de la régression : racine(somme des résidus² / degrés de liberté)') +
      kpi('CV(RMSE)', pct(res.cvrmse), 'RMSE / consommation moyenne de la période. Vert si < 20 %', res.cvrmse < 0.2) +
      kpi('Degrés de liberté', res.df, 'n − nombre de paramètres estimés (constante et seuils compris)') +
      kpi('Points (n)', res.n);

    const sumY = Stats.sum(fit.rows.map(r => val(r, fit.y)));
    const contrib = res.terms.map((n, i) => (res.intercept && i === 0) ? res.coefs[i] * res.n : res.coefs[i] * Stats.sum(fit.rows.map(r => val(r, n))));
    const sumC = Stats.sum(contrib);
    $('model-coefs').innerHTML = `<tr><th>Terme</th><th>Coefficient</th><th>Erreur std</th><th title="Coefficient / erreur standard">t de Student</th><th title="Constante × n, ou coefficient × somme du facteur sur la période de référence">Contribution (${u})</th><th title="Contribution / consommation totale de la période de référence">Part de la conso.</th></tr>` +
      res.terms.map((n, i) => {
        const isConst = res.intercept && i === 0;
        return `<tr><td>${isConst ? 'Constante (talon)' : esc(termLabel(n))}</td><td>${smartFmt(res.coefs[i])}</td><td>${smartFmt(res.se[i])}</td><td class="${Math.abs(res.tStat[i]) > 2 ? 'tgood' : 'tbad'}" title="Vert si |t| > 2"><b>${fmt(res.tStat[i], 2)}</b></td><td>${autoFmt(contrib[i])}</td><td>${pct(contrib[i] / sumY)}</td></tr>`;
      }).join('') +
      `<tr class="total"><td>Total modélisé</td><td colspan="3" class="muted small">consommation réelle de la période : ${autoFmt(sumY)} ${u}</td><td>${autoFmt(sumC)}</td><td>${pct(sumC / sumY)}</td></tr>`;

    $('model-save').classList.remove('hidden');
    if (!$('model-name').value) $('model-name').value = `${fit.y.replace(/\s*\(.*\)/, '')} (${u}) – ${factors.join(' + ')}`;

    // Toute la période de référence ; périodes exclues en gris
    const ex = exclFor(fit.y), cy = colorOf(fit.y);
    const all = state.ds.rows.filter(r => !r.excluded && r.date >= fit.from && r.date <= fit.to &&
      [fit.y, ...res.factors].every(k => isFinite(val(r, k))) && (!fit.nz || val(r, fit.nz) !== 0));
    const termVal = (r, i) => (res.intercept && i === 0) ? res.coefs[0] : res.coefs[i] * val(r, res.terms[i]);
    const pred = r => Stats.sum(res.terms.map((_, i) => termVal(r, i)));
    const f2 = $('fit-y2').value;
    const fitDs = [
      { label: 'Réel', data: all.map(r => val(r, fit.y)), borderColor: cy, backgroundColor: cy,
        pointRadius: all.map(r => (ex.has(r.date) ? 5 : 3)), pointBackgroundColor: all.map(r => (ex.has(r.date) ? '#fff' : cy)),
        pointBorderColor: all.map(r => (ex.has(r.date) ? '#9aa7b1' : cy)) },
      { label: 'Modélisé', data: all.map(pred), borderColor: '#212b36', backgroundColor: '#212b36', borderDash: [6, 4], pointRadius: 2 },
    ];
    if (f2) fitDs.push({ ...y2Dataset(f2, all), borderDash: [2, 3] });
    const fitOpt = baseOptions({ yTitle: label(fit.y), y2: !!f2 });
    if (f2) fitOpt.scales.y2.title = { display: true, text: "Facteur d'influence choisi" };
    makeChart('fit', $('chart-fit'), { type: 'line', data: { labels: all.map(r => periodLabel(r.date)), datasets: fitDs }, options: fitOpt });

    // Décomposition : talon + part de chaque facteur
    const termColor = i => (res.intercept && i === 0) ? '#b8b6bd' : colorOf(res.terms[i]);
    const dec = res.terms.map((n, i) => ({
      type: 'bar', label: (res.intercept && i === 0) ? 'Talon (constante)' : `Part ${termLabel(n)}`, data: all.map(r => termVal(r, i)),
      backgroundColor: termColor(i), stack: 'modele', order: 2,
    }));
    dec.push({ type: 'line', label: 'Réel', data: all.map(r => val(r, fit.y)), borderColor: cy, backgroundColor: cy, pointRadius: 2, stack: 'reel', order: 1 });
    const decOpt = baseOptions({ yTitle: label(fit.y) });
    decOpt.scales.x = { stacked: true }; decOpt.scales.y.stacked = true;
    makeChart('decomp', $('chart-decomp'), { data: { labels: all.map(r => periodLabel(r.date)), datasets: dec }, options: decOpt });
  }

  function bestCombos() {
    try {
      let pool = [...$('model-factors').querySelectorAll('input:checked')].map(i => i.value);
      if (pool.length < 2) pool = cols('facteur');
      if (!pool.length) { msg('model-msg', "Aucun facteur d'influence disponible.", 'err'); return; }
      if (pool.length > 10) { msg('model-msg', 'Trop de facteurs (max 10) : coche ceux à tester.', 'err'); return; }
      const reopt = $('best-reopt').checked;
      const tried = Stats.subsets(pool).map(fs => {
        const ov = {};
        if (reopt) fs.filter(isSeuil).forEach(k => { const sv = optimizeThreshold(k, fs, ov); if (sv != null) ov[k] = sv; });
        return { fs, ov, res: currentFit(fs, ov).res };
      });
      const results = tried.filter(o => !o.res.error);
      results.sort((a, b) => b.res.adjR2 - a.res.adjR2);
      const card = $('best-card');
      card.classList.remove('hidden');
      $('best-table').innerHTML = '<tr><th>Facteurs</th><th>R²</th><th>R² ajusté</th><th>RMSE</th><th>CV(RMSE)</th><th>t de Student par facteur</th></tr>' +
        (results.length ? results.slice(0, 20).map((o, i) => {
          const ts = factorIdx(o.res).map(j => `${esc(termLabel(o.res.terms[j], o.ov))} : <b class="${Math.abs(o.res.tStat[j]) > 2 ? 'good' : 'warn'}">${fmt(o.res.tStat[j], 2)}</b>`).join(' · ');
          return `<tr class="clickable" data-i="${i}"><td>${esc(o.fs.map(f => termLabel(f, o.ov)).join(' + '))}</td><td class="${o.res.r2 >= 0.75 ? 'good' : 'warn'}">${fmt(o.res.r2, 3)}</td><td>${fmt(o.res.adjR2, 3)}</td><td>${autoFmt(o.res.rmse)}</td><td class="${o.res.cvrmse < 0.2 ? 'good' : 'warn'}">${pct(o.res.cvrmse)}</td><td class="tlist">${ts}</td></tr>`;
        }).join('') : '<tr><td colspan="6" class="muted">Aucune combinaison calculable (pas assez de points, ou facteurs constants / colinéaires sur la période).</td></tr>');
      $('best-table').querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', async () => {
        const { fs, ov } = results[+tr.dataset.i];
        // Combinaison avec seuils réoptimisés : on applique ces seuils
        if (Object.keys(ov).length) { Object.entries(ov).forEach(([k, sv]) => { const t = transformOf(k); if (t) t.s = sv; }); enrich(); await saveDs(); renderAll(false); }
        $('model-factors').querySelectorAll('input').forEach(inp => { inp.checked = fs.includes(inp.value); });
        $('model-name').value = '';
        fitModel();
        $('model-eq').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
      const skipped = tried.length - results.length;
      msg('model-msg', `${tried.length} combinaison(s) testée(s)${skipped ? `, ${skipped} non calculable(s)` : ''} : résultats ci-dessous.`, 'ok');
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      msg('model-msg', 'Erreur pendant le test des combinaisons : ' + e.message, 'err');
    }
  }

  async function saveModel() {
    const f = state.fit; if (!f) return;
    const r = f.res;
    const model = {
      id: Date.now().toString(36), name: $('model-name').value.trim() || 'IPE sans nom',
      site: state.ds.name, siteUuid: state.ds.siteUuid || null,
      target: f.y, targetSid: colOf(f.y)?.sid || null, color: colorOf(f.y), unit: f.unit,
      factors: r.factors, intercept: r.intercept, coefs: r.coefs, terms: r.terms, inv: r.inv, df: r.df, nonZero: f.nz, extra: r.extra,
      // Formes non linéaires figées dans l'IPE (le suivi n'en dépend plus) et plages de la référence
      transforms: Object.fromEntries(r.factors.filter(transformOf).map(k => { const t = transformOf(k); return [k, { base: t.base, kind: t.kind, s: t.s }]; })),
      factorRange: Object.fromEntries(r.factors.map(k => { const b = transformOf(k)?.base || k; const v = f.rows.map(x => val(x, b, f.unit)); return [b, [Math.min(...v), Math.max(...v)]]; })),
      refFrom: f.from, refTo: f.to, granularity: state.ds.granularity,
      excludedDates: [...exclFor(f.y)].filter(d => d >= f.from && d <= f.to),
      site_params: { country: state.ds.site.country, holidays: state.ds.site.holidays, surface: state.ds.site.surface, schedule: state.ds.site.schedule },
      stats: { r2: r.r2, adjR2: r.adjR2, cvrmse: r.cvrmse, n: r.n, rmse: r.rmse, df: r.df }, created: new Date().toISOString(),
    };
    state.models.push(model);
    state.activeModelId = model.id;
    await saveModels();
    msg('model-msg', `IPE « ${model.name} » enregistré. Va dans l'onglet Suivi pour comparer réel et attendu.`, 'ok');
    $('suivi-from').value = '';
  }

  // Corrélations -> Modèle & SER : même consommation, même facteur, même période, même filtre
  async function sendToModel() {
    const y = $('scatter-y').value, x = $('scatter-x').value, form = corrForm();
    if (colType(x) !== 'facteur') { $('scatter-info').innerHTML += ` &nbsp;·&nbsp; <span class="warn">« ${esc(x)} » n'est pas un facteur d'influence (rôle à changer dans l'onglet Données).</span>`; return; }
    // Forme non linéaire : création (ou mise à jour) du facteur dérivé correspondant
    let check = [x];
    if (form !== 'lin') {
      const ds = state.ds, key = tfKey(x, form);
      ds.transforms = ds.transforms || [];
      let t = ds.transforms.find(tt => tt.key === key);
      if (!t) { t = { key, base: x, kind: form, s: 0 }; ds.transforms.push(t); }
      if (form === 'seuil' && state.corrFit && state.corrFit.s != null) t.s = state.corrFit.s;
      enrich(); await saveDs(); renderModelTab();
      check = form === 'seuil' ? [key] : [x, key];
    }
    $('model-y').value = y;
    $('model-factors').querySelectorAll('input').forEach(inp => { inp.checked = check.includes(inp.value); });
    $('model-nonzero').value = $('corr-nonzero').checked ? x : '';
    const [a, b] = getRange('corr');
    setRange('ref', a, b);
    $('model-name').value = '';
    switchTab('modele');
    renderTimeline('ref');
    fitModel();
  }

  // ---------- Rendu : Suivi ----------
  const activeModel = () => state.models.find(x => x.id === state.activeModelId);
  // Retrouve la colonne d'un IPE même si le dashboard a changé de langue (identifiant d'usage)
  function resolveKey(key, sid) {
    if (state.ds.columns.some(c => c.key === key)) return key;
    if (sid) { const c = state.ds.columns.find(x => x.sid === sid); if (c) return c.key; }
    return null;
  }
  const sameSite = m => state.ds && ((m.siteUuid && m.siteUuid === state.ds.siteUuid) || m.site === state.ds.name);

  function renderModelsList() {
    const t = $('models-list');
    if (!state.models.length) { t.innerHTML = "<p class=\"muted\">Aucun IPE enregistré. Crée-en un dans l'onglet « Modèle &amp; SER ».</p>"; return; }
    const list = [...state.models].sort((a, b) => sameSite(b) - sameSite(a));
    // Liste compacte : nom sur une ligne (retour à la ligne si besoin), site · référence · R² en dessous
    t.innerHTML = list.map(m => `
      <div class="model-item ${m.id === state.activeModelId ? 'active-model' : ''} ${sameSite(m) ? '' : 'other-site'}" data-id="${m.id}" title="${esc(m.target)} = f(${esc(m.factors.join(', '))})">
        <div class="model-main">
          <div class="model-name">${esc(m.name)}</div>
          <div class="model-meta">
            <span>${esc(m.site)}</span>
            <span>${periodLabel(m.refFrom, m.granularity)} → ${periodLabel(m.refTo, m.granularity)}</span>
            <span>R² ${fmt(m.stats.r2, 3)}</span>
          </div>
        </div>
        <button class="link" data-del="${m.id}" title="Supprimer cet IPE">✕</button>
      </div>`).join('');
    t.querySelectorAll('.model-item').forEach(tr => tr.addEventListener('click', async e => {
      const del = e.target.dataset.del;
      if (del) {
        if (!confirm('Supprimer cet IPE ?')) return;
        state.models = state.models.filter(m => m.id !== del);
        if (state.activeModelId === del) state.activeModelId = state.models[0]?.id || null;
      } else { state.activeModelId = tr.dataset.id; $('suivi-from').value = ''; state.suiviZoom = null; }
      await saveModels(); renderSuivi(true);
    }));
  }

  // ---------- Zoom du graphique de suivi (indices de périodes affichées, null = tout l'historique) ----------
  function clampZoom(z) {
    if (!z || !state.ds) return null;
    const n = state.ds.rows.length, len = Math.min(z[1] - z[0], n - 1);
    if (len >= n - 1) return null;
    let lo = Math.round(z[0]);
    lo = Math.max(0, Math.min(n - 1 - len, lo));
    return [lo, lo + len];
  }
  function setSuiviZoom(z) {
    state.suiviZoom = clampZoom(z);
    const c = charts.suivi; if (!c) return;
    c.options.scales.x.min = state.suiviZoom ? state.suiviZoom[0] : undefined;
    c.options.scales.x.max = state.suiviZoom ? state.suiviZoom[1] : undefined;
    c.update('none');
  }
  const suiviView = () => state.suiviZoom || [0, state.ds.rows.length - 1];
  // Molette (avec Ctrl, ou pincement sur pavé tactile) : zoom centré sur le curseur
  function zoomSuiviAt(idx, zoomIn) {
    const [lo, hi] = suiviView(), len = hi - lo + 1, n = state.ds.rows.length;
    let nl = Math.round(len * (zoomIn ? 0.8 : 1.25));
    if (nl === len) nl += zoomIn ? -1 : 1;
    nl = Math.max(Math.min(8, n), Math.min(n, nl));
    const nlo = Math.round(idx - ((idx - lo) / len) * nl);
    setSuiviZoom([nlo, nlo + nl - 1]);
  }
  function panSuivi(delta) {
    const [lo, hi] = suiviView();
    if (state.suiviZoom) setSuiviZoom([lo + delta, hi + delta]);
  }
  function zoomSuiviPreset(kind) {
    if (!charts.suivi || !state.ds) return;
    const [a, b] = getRange('suivi'), ref = charts.suivi.$fixed || [-1, -1];
    if (kind === 'all') return setSuiviZoom(null);
    let lo = a, hi = b;
    if (kind === 'both' && ref[0] >= 0) { lo = Math.min(a, ref[0]); hi = Math.max(b, ref[1]); }
    const pad = Math.max(1, Math.round((hi - lo + 1) * 0.05));
    setSuiviZoom([lo - pad, hi + pad]);
  }

  function renderSuivi(full = true) {
    if (full) renderModelsList();
    const m = activeModel();
    const clear = text => {
      msg('suivi-msg', text, text ? 'err' : ''); $('suivi-kpis').innerHTML = ''; $('suivi-table').innerHTML = ''; $('suivi-picks').innerHTML = '';
      ['suivi', 'suiviDelta'].forEach(k => { if (charts[k]) { charts[k].destroy(); delete charts[k]; } });
    };
    if (!m) return clear('');
    if (!state.ds) return clear("Charge des données dans l'onglet 1.");
    const tk = resolveKey(m.target, m.targetSid);
    const tfs = m.transforms || {};
    const baseOf = f => (tfs[f] ? tfs[f].base : f);
    const missing = [tk ? null : m.target, ...m.factors.map(baseOf).filter(f => !resolveKey(f))].filter(Boolean);
    if (missing.length) return clear(`Colonnes absentes des données chargées : ${missing.join(', ')}${sameSite(m) ? '' : ' (cet IPE appartient à un autre site)'}`);
    if (m.granularity !== state.ds.granularity) return clear(`Cet IPE est au pas « ${m.granularity} », les données au pas « ${state.ds.granularity} ».`);
    const unit = m.unit || 'kWh', u = UNITS[unit].label;
    if (!unitAvailable(unit)) return clear(`Cet IPE est en ${u} : renseigne les informations du site nécessaires (onglet Données).`);

    const rows = state.ds.rows, n = rows.length;
    const refBand = [firstAtOrAfter(m.refFrom), lastAtOrBefore(m.refTo)];
    if (!$('suivi-from').value) {
      // Par défaut : tout ce qui suit la référence ; sinon la même durée juste avant
      const [ra, rb] = refBand, len = Math.max(1, rb - ra + 1);
      if (rb >= 0 && rb + 1 < n) setRange('suivi', rb + 1, n - 1);
      else if (ra > 0) setRange('suivi', Math.max(0, ra - len), ra - 1);
      else setRange('suivi', Math.max(0, n - (DEFAULT_LEN[state.ds.granularity] || 12)), n - 1);
    }
    if (full) renderPicks('suivi');
    const [a, b] = getRange('suivi');
    // Suivi entièrement avant la référence (chaînage post → ante, « backcasting ») : le modèle décrit
    // l'état le plus récent, donc une consommation passée supérieure au modèle (écart > 0) est une économie.
    const backcast = refBand[0] >= 0 && b < refBand[0];
    const isSaving = e => (backcast ? e > 0 : e < 0);
    const overlap = refBand[0] >= 0 && a <= refBand[1] && b >= refBand[0];

    // Valeur d'un facteur selon la forme enregistrée dans l'IPE (seuil figé)
    const fvOf = (r, f) => (tfs[f] ? tfVal(tfs[f], val(r, tfs[f].base, unit)) ?? NaN : val(r, f, unit));
    const inDomain = r => m.factors.every(f => isFinite(fvOf(r, f))) && (!m.nonZero || val(r, m.nonZero, unit) !== 0);
    const reelOf = r => val(r, tk, unit);
    const attOf = r => { if (!inDomain(r)) return NaN; const fv = {}; m.factors.forEach(f => { fv[f] = fvOf(r, f); }); return Stats.predict(m, fv); };
    const reel = rows.map(reelOf), att = rows.map(attOf);

    // Écart = réel − attendu
    let cum = 0, nOutDomain = 0;
    const lines = [], cumArr = rows.map(() => null);
    for (let i = a; i <= b; i++) {
      const r = rows[i];
      if (r.excluded || !isFinite(reel[i])) continue;
      if (!isFinite(att[i])) { nOutDomain++; continue; }
      const ecart = reel[i] - att[i]; cum += ecart;
      cumArr[i] = cum;
      lines.push({ i, date: r.date, reel: reel[i], att: att[i], ecart, ecartPct: ecart / att[i], ipe: reel[i] / att[i], cum, fv: Object.fromEntries(m.factors.map(f => [f, fvOf(r, f)])) });
    }
    const info = [`${label(tk, unit)} = f(${m.factors.map(f => (tfs[f] ? (tfs[f].kind === 'seuil' ? `max(0, ${tfs[f].base} − ${fmt(tfs[f].s, 1)})` : `${tfs[f].base}²`) : f)).join(', ')}) · référence ${periodLabel(m.refFrom, m.granularity)} → ${periodLabel(m.refTo, m.granularity)}`];
    if (backcast) info.push('suivi avant la référence (post → ante) : le modèle décrit l\'état le plus récent, un écart positif est donc une économie');
    if (overlap) info.push('la période de suivi recoupe la référence : sur ce recouvrement, l\'écart n\'est que le résidu du modèle');
    if (nOutDomain) info.push(`${nOutDomain} période(s) hors domaine du modèle (« ${m.nonZero} » = 0) non comptées`);
    if (m.factorRange) {
      const nOut = lines.filter(l => Object.entries(m.factorRange).some(([bk, [lo, hi]]) => { const v = val(rows[l.i], bk, unit); return v < lo - 1e-9 || v > hi + 1e-9; })).length;
      if (nOut) info.push(`${nOut} période(s) avec un facteur hors de la plage de la référence : extrapolation, à interpréter avec prudence${Object.values(tfs).some(t => t.kind === 'carre') ? ' (surtout avec un terme au carré)' : ''}`);
    }
    if (!sameSite(m)) info.push('attention : IPE créé sur un autre site');
    msg('suivi-msg', info.join(' · '), sameSite(m) ? '' : 'err');

    // Graphique principal : tout l'historique ; référence en turquoise, suivi en vert (glissable)
    const barColor = i => {
      const [sa, sb] = getRange('suivi');
      if (i >= sa && i <= sb) return SAVE;
      if (i >= refBand[0] && i <= refBand[1]) return '#00B4B7';
      return '#d3dadf';
    };
    if (full || !charts.suivi) {
      const opts = baseOptions({ y2: true, yTitle: u });
      opts.events = ['mousemove', 'mouseout'];
      opts.scales.y2.title = { display: true, text: `Écart cumulé réel − attendu (${u})` };
      const z = clampZoom(state.suiviZoom);
      state.suiviZoom = z;
      opts.scales.x = { min: z ? z[0] : undefined, max: z ? z[1] : undefined, ticks: { autoSkip: true, maxRotation: 60 } };
      // Légende : les barres « Réel » changent de couleur selon la période, on détaille donc les trois couleurs
      opts.plugins.legend = { labels: { generateLabels: chart => {
        const hidden = !chart.isDatasetVisible(0);
        const real = [['Réel · référence', '#00B4B7'], ['Réel · suivi', SAVE], ['Réel · hors périodes', '#d3dadf']]
          .map(([text, c]) => ({ text, fillStyle: c, strokeStyle: c, lineWidth: 0, pointStyle: 'rect', hidden, datasetIndex: 0 }));
        const others = Chart.defaults.plugins.legend.labels.generateLabels(chart).filter(l => l.datasetIndex > 0);
        return [...real, ...others];
      } } };
      makeChart('suivi', $('chart-suivi'), {
        data: {
          labels: rows.map(r => periodLabel(r.date)),
          datasets: [
            { type: 'bar', label: 'Réel', data: reel, order: 3, backgroundColor: ctx => barColor(ctx.dataIndex) },
            { type: 'line', label: 'Attendu (modèle)', data: att, borderColor: EXPECTED_LINE, backgroundColor: EXPECTED_LINE, borderDash: [6, 4], borderWidth: 2, pointRadius: 2, pointStyle: 'circle', tension: 0, order: 2, spanGaps: false },
            { type: 'line', label: 'Écart cumulé (réel − attendu)', data: cumArr, borderColor: '#212b36', backgroundColor: '#212b36', yAxisID: 'y2', tension: 0.2, pointRadius: 1.5, order: 1, spanGaps: false },
          ],
        },
        plugins: [windowPlugin],
        options: opts,
      });
      charts.suivi.$tl = 'suivi';
      bindTimelineMouse('suivi');
    } else {
      charts.suivi.data.datasets[2].data = cumArr;
      charts.suivi.update('none');
    }
    charts.suivi.$fixed = refBand;

    if (!lines.length) { $('suivi-kpis').innerHTML = ''; $('suivi-table').innerHTML = ''; if (charts.suiviDelta) { charts.suiviDelta.destroy(); delete charts.suiviDelta; } return; }

    const totR = Stats.sum(lines.map(l => l.reel)), totA = Stats.sum(lines.map(l => l.att)), totE = totR - totA;
    const tag = e => (isSaving(e) ? 'économie' : 'surconsommation');
    const cls = e => (isSaving(e) ? 'ok' : 'bad');
    const signed = v => (v > 0 ? '+' : '') + autoFmt(v);
    // Incertitude de la référence ajustée (IPMVP : |écart| > 2 × erreur type)
    const se = Stats.totalPredictionSE({ ...m, rmse: m.stats.rmse }, lines.map(l => l.fv));
    const tc = Stats.tCrit(m.df || (m.stats.n - m.coefs.length));
    const kpi = (lab, v, c = '', tip = '') => `<div class="kpi ${c}" title="${tip}"><div class="v">${v}</div><div class="l">${lab}</div></div>`;
    $('suivi-kpis').innerHTML =
      kpi(`Réel (${u})`, autoFmt(totR)) + kpi(`Attendu (${u})`, autoFmt(totA)) +
      kpi(`Écart réel − attendu (${u}) · ${tag(totE)}`, signed(totE), cls(totE)) +
      kpi(`Écart relatif · ${tag(totE)}`, (totE > 0 ? '+' : '') + pct(totE / totA), cls(totE)) +
      kpi('IPE moyen (réel/attendu)', fmt(totR / totA, 3), cls(totE)) +
      (isFinite(se)
        ? kpi(`Incertitude 95 % (${u})`, '± ' + autoFmt(tc * se), '', `t (${fmt(tc, 2)}) × erreur type (${autoFmt(se)}) de la consommation attendue ; suppose des résidus indépendants`) +
          kpi('|Écart| > 2 × erreur type (IPMVP)', Math.abs(totE) > 2 * se ? 'Oui' : 'Non', Math.abs(totE) > 2 * se ? 'ok' : 'bad', `|écart| = ${autoFmt(Math.abs(totE))} ; 2 × erreur type = ${autoFmt(2 * se)}`)
        : kpi('Incertitude', '–', '', "IPE enregistré avec une version antérieure : réenregistre-le pour calculer l'incertitude"));

    $('suivi-table').innerHTML = `<tr><th>Période</th><th>Réel (${u})</th><th>Attendu (${u})</th><th>Écart réel − attendu (${u})</th><th>Écart (%)</th><th>IPE réel/attendu</th><th>Écart cumulé (${u})</th></tr>` +
      lines.map(l => `<tr><td>${periodLabel(l.date)}</td><td>${autoFmt(l.reel)}</td><td>${autoFmt(l.att)}</td><td class="${isSaving(l.ecart) ? 'good' : 'warn'}">${signed(l.ecart)}</td><td>${(l.ecartPct > 0 ? '+' : '') + pct(l.ecartPct)}</td><td>${fmt(l.ipe, 3)}</td><td class="${isSaving(l.cum) ? 'good' : 'warn'}">${signed(l.cum)}</td></tr>`).join('');
    state.suiviLines = lines; state.suiviModel = m;

    // Écart par période : vert = économie, orange = surconsommation
    const delta = baseOptions({ y2: true, yTitle: `Réel − attendu (${u})` });
    delta.scales.y2.ticks.callback = v => fmt(v, 0) + ' %';
    delta.scales.y2.title = { display: true, text: "% de l'attendu" };
    delta.plugins.tooltip.callbacks.label = c => c.dataset.yAxisID === 'y2' ? `${c.dataset.label} : ${fmt(c.parsed.y, 1)} %` : `${c.dataset.label} : ${signed(c.parsed.y)} ${u} (${tag(c.parsed.y)})`;
    makeChart('suiviDelta', $('chart-suivi-delta'), {
      data: {
        labels: lines.map(l => periodLabel(l.date)),
        datasets: [
          { type: 'bar', label: 'Réel − attendu', data: lines.map(l => l.ecart), backgroundColor: lines.map(l => (isSaving(l.ecart) ? SAVE : OVER)), order: 2 },
          { type: 'line', label: 'Écart (%)', data: lines.map(l => l.ecartPct * 100), borderColor: '#7f8c8d', backgroundColor: '#7f8c8d', yAxisID: 'y2', pointRadius: 2, tension: 0.2, order: 1 },
        ],
      },
      options: delta,
    });
  }

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportSuivi() {
    const L = state.suiviLines; if (!L) return;
    const u = UNITS[state.suiviModel.unit || 'kWh'].label;
    const n = (v, d = 0) => isFinite(v) ? v.toFixed(d).replace('.', ',') : '';
    const d = Math.abs(L[0]?.reel) < 100 ? 3 : 0;
    const csv = [`Période;Réel (${u});Attendu (${u});Écart réel - attendu (${u});Écart (%);IPE réel/attendu;Écart cumulé (${u})`,
      ...L.map(l => [l.date, n(l.reel, d), n(l.att, d), n(l.ecart, d), n(l.ecartPct * 100, 2), n(l.ipe, 4), n(l.cum, d)].join(';'))].join('\r\n');
    download(`suivi_${state.suiviModel.name.replace(/[^\w-]+/g, '_')}.csv`, '﻿' + csv, 'text/csv');
  }

  // ---------- Orchestration ----------
  function renderAll(resetDates = true) {
    renderDataTab();
    if (!state.ds) return;
    if (resetDates) initDateSelects();
    renderCorrelations();
    renderModelTab();
    renderSuivi(true);
  }

  function switchTab(name) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'suivi' && state.ds) renderSuivi(true);
    Object.values(charts).forEach(c => c.resize()); // Chart.js doit être redimensionné une fois l'onglet visible
  }

  function bind() {
    document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('btn-sample').addEventListener('click', () => {
      const ds = SampleData.make();
      ds.site = { ...defaultSite(), surface: 2500, cost: [{ startDate: '1970-01-01', number: 0.18 }], co2: [{ startDate: '1970-01-01', number: 52 }], address: 'Site fictif (données exemple)' };
      loadDataset(ds);
    });
    $('file-csv').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { const { ds, warning } = parseCSV(await f.text(), f.name.replace(/\.\w+$/, '')); await loadDataset(ds, warning); }
      catch (err) { msg('import-msg', err.message, 'err'); }
      e.target.value = '';
    });
    $('btn-paste').addEventListener('click', async () => {
      try { const { ds, warning } = parseCSV($('paste-area').value, $('ds-name').value || 'Site importé'); await loadDataset(ds, warning); }
      catch (err) { msg('import-msg', err.message, 'err'); }
    });
    $('ds-name').addEventListener('change', async () => { if (state.ds) { state.ds.name = $('ds-name').value; await saveDs(); renderDataTab(); } });
    $('ds-gran').addEventListener('change', async () => { if (state.ds) { state.ds.granularity = $('ds-gran').value; enrich(); await saveDs(); renderAll(); } });
    $('unit').addEventListener('change', async () => { if (state.ds) { state.ds.unit = $('unit').value; await saveDs(); renderAll(false); if (state.fit) fitModel(); } });
    $('site-country').addEventListener('change', async () => { state.ds.site.country = $('site-country').value; await siteChanged(); });
    $('site-holidays').addEventListener('change', async () => { state.ds.site.holidays = $('site-holidays').checked; await siteChanged(); });
    $('site-surface').addEventListener('change', async () => { const v = parseFloat($('site-surface').value); state.ds.site.surface = v > 0 ? v : null; await siteChanged(); });
    [['site-cost', 'cost'], ['site-co2', 'co2']].forEach(([id, k]) => $(id).addEventListener('change', async () => {
      const v = parseFloat($(id).value);
      state.ds.site[k] = v > 0 ? [{ startDate: '1970-01-01', number: v }] : [];
      await siteChanged();
    }));
    $('overview-series').addEventListener('change', renderOverview);

    // Périodes : listes, longueur de fenêtre
    Object.keys(RANGES).forEach(kind => {
      const [f, t, l] = RANGES[kind];
      [f, t].forEach(id => $(id).addEventListener('change', () => { const [a, b] = getRange(kind); setRange(kind, a, b); rangeChanged(kind); }));
      $(l).addEventListener('change', () => {
        const n = state.ds.rows.length, len = Math.max(1, Math.min(n, Math.round(+$(l).value || 1)));
        let [a] = getRange(kind); if (a + len > n) a = n - len;
        setRange(kind, a, a + len - 1); rangeChanged(kind);
      });
    });

    ['scatter-y', 'scatter-x'].forEach(id => $(id).addEventListener('change', () => { renderMatrix(); renderScatter(); }));
    $('corr-form').addEventListener('change', () => renderScatter(false));
    $('rmse-k').addEventListener('change', () => renderScatter(false));
    $('corr-nonzero').addEventListener('change', () => { renderMatrix(); renderScatter(); });
    $('btn-rmse').addEventListener('click', applyRmseFilter);
    $('btn-reset-excl').addEventListener('click', resetExclusions);
    $('chart-scatter').addEventListener('mouseleave', () => highlightBar(null));
    $('btn-to-model').addEventListener('click', sendToModel);

    $('model-y').addEventListener('change', () => { renderTimeline('ref'); if (state.fit) fitModel(); });
    $('fit-y2').addEventListener('change', () => { renderTimeline('ref'); if (state.fit) fitModel(); });
    $('model-nonzero').addEventListener('change', () => { renderTimeline('ref'); if (state.fit) fitModel(); });
    $('model-intercept').addEventListener('change', () => { if (state.fit) fitModel(); });
    $('btn-combo').addEventListener('click', createCombo);
    $('btn-nl-add').addEventListener('click', addTransform);
    $('btn-fit').addEventListener('click', () => { $('model-name').value = ''; fitModel(); });
    $('btn-best').addEventListener('click', bestCombos);
    $('btn-save').addEventListener('click', saveModel);

    $('btn-export-suivi').addEventListener('click', exportSuivi);
    document.querySelectorAll('#suivi-zoom button').forEach(b => b.addEventListener('click', () => zoomSuiviPreset(b.dataset.zoom)));
    $('btn-export-models').addEventListener('click', () => download('ipe_modeles.json', JSON.stringify(state.models, null, 2), 'application/json'));
    $('file-models').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const list = JSON.parse(await f.text());
        const ids = new Set(state.models.map(m => m.id));
        list.filter(m => m.id && m.coefs && !ids.has(m.id)).forEach(m => state.models.push(m));
        await saveModels(); renderSuivi(true);
      } catch { alert('Fichier JSON invalide.'); }
      e.target.value = '';
    });
  }

  async function init() {
    try { $('app-version').textContent = 'Version ' + chrome.runtime.getManifest().version; } catch { $('app-version').textContent = 'Version de test'; }
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = '#637381';
    Chart.defaults.borderColor = 'rgba(145,158,171,0.2)';
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.datasets.bar.categoryPercentage = 0.94;
    Chart.defaults.datasets.bar.barPercentage = 0.94;
    bind();
    state.settings = { crit: 'ipmvp', ...((await store.get('settings')) || {}) };
    state.models = (await store.get('models')) || [];
    state.activeModelId = (await store.get('activeModelId')) || state.models[0]?.id || null;
    const ds = await store.get('ds');
    if (ds) { state.ds = ds; enrich(); }
    renderAll();
    await consumePending();
    if (hasChrome) chrome.storage.onChanged.addListener(ch => { if (ch.pendingImport && ch.pendingImport.newValue) consumePending(); });
  }
  init();
})();
