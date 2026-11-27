// Fonction injectée dans la page du dashboard Smart Impulse (monde "MAIN" de la page).
// Elle lit les séries du graphique ECharts affiché (usages en Wh, degrés-jours) et
// renvoie un jeu de données au format de l'application. Doit rester autonome (aucune
// référence à des variables extérieures), car Chrome la sérialise pour l'injecter.
async function extractSmartImpulseData() {
  const result = extractChart();
  if (result.ds) result.ds.site = await fetchSiteInfo();
  return result;

  // Informations du site (onglet « Site information » du dashboard), via l'API que la page utilise déjà
  async function fetchSiteInfo() {
    const uuid = location.pathname.split('/').find(p => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p));
    if (!uuid) return null;
    try {
      const r = await fetch(`/services/api/rest/site/${uuid}/v10/`, { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json(), md = j.metadata || {}, loc = j.location || {};
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const sched = md.openingSchedule || null;
      const kpi = name => (md.otherKPI || []).filter(k => k.kpi === name && isFinite(k.number))
        .map(k => ({ startDate: k.startDate, number: +k.number })).sort((a, b) => a.startDate.localeCompare(b.startDate));
      return {
        country: loc.country || null, address: loc.address || '', coordinates: loc.coordinates || null,
        timezone: j.timezone || '', activity: md.mainActivity || '',
        surface: isFinite(md.buildingSurface) && md.buildingSurface > 0 ? +md.buildingSurface : null,
        schedule: sched ? days.map(d => {
          const s = sched[d];
          return s && s.openingTime && s.closingTime ? { open: true, from: s.openingTime, to: s.closingTime } : { open: false, from: '', to: '' };
        }) : null,
        cost: kpi('averagekWhCost'),      // €/kWh
        co2: kpi('averageCO2Impact'),      // gCO2e/kWh
        holidays: true,
      };
    } catch (e) { return null; }
  }

  function extractChart() {
  const charts = [...document.querySelectorAll('.echarts-for-react')];
  if (!charts.length) return { error: 'Aucun graphique trouvé sur cette page. Ouvre une page « Analysis » du dashboard.' };

  const getOption = el => {
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    let f = fk && el[fk], d = 0;
    while (f && d < 20) {
      if (f.stateNode && typeof f.stateNode.getEchartsInstance === 'function') {
        try { return f.stateNode.getEchartsInstance().getOption(); } catch (e) { /* on continue */ }
      }
      if (f.memoizedProps && f.memoizedProps.option) return f.memoizedProps.option;
      f = f.return; d++;
    }
    return null;
  };

  // On retient le graphique temporel qui a le plus de séries
  const candidates = charts.map(getOption).filter(o => o && Array.isArray(o.series) &&
    o.series.some(s => Array.isArray(s.data) && Array.isArray(s.data[0])));
  if (!candidates.length) return { error: 'Graphique trouvé mais données illisibles (structure du dashboard modifiée ?).' };
  const opt = candidates.sort((a, b) => b.series.length - a.series.length)[0];

  const path = location.pathname.split('/');
  const granMap = { month: 'mois', week: 'semaine', day: 'jour' };
  const granularity = granMap[path.find(p => granMap[p])] || null;
  const siteName = document.title.split('|')[0].trim() || 'Site Smart Impulse';

  const isFactor = s => (s.yAxisIndex || 0) > 0 || s.type === 'line';
  const rename = n => /heat|chauff/i.test(n) ? 'DJU chauffage'
    : /cool|clim|refroid|r[ée]frig/i.test(n) ? 'DJU climatisation' : n;

  const columns = [], byDate = {};
  opt.series.forEach(s => {
    if (!Array.isArray(s.data)) return;
    const factor = isFactor(s);
    const key = factor ? rename(s.name) : `${s.name} (kWh)`;
    if (columns.some(c => c.key === key)) return;
    // Couleur du dashboard ; identifiant d'usage indépendant de la langue (ex. "5" = CVC)
    let color = (s.itemStyle && typeof s.itemStyle.color === 'string' && s.itemStyle.color) || (s.lineStyle && s.lineStyle.color) || null;
    if (s.stack === 'total') color = '#8f8d96'; // gris du total, foncé pour rester lisible
    const sid = s.id != null ? String(s.id) : (factor ? key : null);
    columns.push({ key, type: factor ? 'facteur' : 'conso', color, sid });
    s.data.forEach(pt => {
      const [t, v] = Array.isArray(pt) ? pt : (pt && pt.value) || [];
      if (t == null) return;
      const date = new Date(Math.round(t / 86400000) * 86400000).toISOString().slice(0, 10); // arrondi au jour (heure d'été/hiver)
      byDate[date] = byDate[date] || {};
      byDate[date][key] = (v == null || v === '-' || !isFinite(v)) ? null : (factor ? +v : v / 1000); // Wh -> kWh
    });
  });
  const rows = Object.keys(byDate).sort().map(date => ({ date, values: byDate[date] }));

  // Période réellement couverte, affichée par le dashboard (« From 18/05/2026 to 18/11/2026 »)
  let coverage = null;
  const m = document.body.innerText.match(/(\d{2})\/(\d{2})\/(\d{4})\D{1,12}(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) coverage = { from: `${m[3]}-${m[2]}-${m[1]}`, to: `${m[6]}-${m[5]}-${m[4]}` };

  const siteUuid = location.pathname.split('/').find(p => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)) || null;
  return { ds: { name: siteName, siteUuid, granularity, columns, rows, coverage, source: location.origin + location.pathname } };
}
}
