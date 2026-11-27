// Jeu de données exemple : bureau tertiaire fictif, données mensuelles 2023-2025.
// Référence 2023-2024 ; en 2025 relamping LED (éclairage -20 % dès mars)
// et réglage des consignes de chauffage (-8 % dès octobre).
const SampleData = (() => {
  // Couleurs du dashboard Smart Impulse
  const SAMPLE_COLORS = {
    'Général (kWh)': '#8f8d96', 'Chauffage (kWh)': '#FB9A99', 'Climatisation (kWh)': '#5731AC',
    'Éclairage (kWh)': '#FDAE61', 'Prises & IT (kWh)': '#B2DF8A', 'DJU chauffage': '#990033', 'DJU climatisation': '#6BAED6',
  };
  function make() {
    let seed = 42;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const djuCh = [380, 330, 280, 180, 90, 20, 5, 5, 40, 150, 290, 360];
    const djuCl = [0, 0, 0, 2, 10, 35, 75, 65, 18, 2, 0, 0];
    const rows = [];
    for (let y = 2023; y <= 2025; y++) {
      for (let m = 0; m < 12; m++) {
        const date = `${y}-${String(m + 1).padStart(2, '0')}-01`;
        const { jo, jno } = Stats.calendarCounts(date, 'mois');
        const ch = Math.max(0, Math.round(djuCh[m] * (1 + rnd() * 0.25)));
        const cl = Math.max(0, Math.round(djuCl[m] * (1 + rnd() * 0.5)));
        let chauffage = 4200 + 52 * ch + rnd() * 1500;
        const clim = 1800 + 115 * cl + rnd() * 700;
        let eclairage = 860 * jo + 210 * jno + rnd() * 900;
        const prises = 640 * jo + 330 * jno + rnd() * 700;
        if (y === 2025 && m >= 2) eclairage *= 0.80;
        if (y === 2025 && m >= 9) chauffage *= 0.92;
        const r = v => Math.round(v);
        rows.push({
          date,
          values: {
            'Général (kWh)': r(chauffage + clim + eclairage + prises),
            'Chauffage (kWh)': r(chauffage), 'Climatisation (kWh)': r(clim),
            'Éclairage (kWh)': r(eclairage), 'Prises & IT (kWh)': r(prises),
            'DJU chauffage': ch, 'DJU climatisation': cl,
          },
        });
      }
    }
    const columns = [
      ['Général (kWh)', 'conso'], ['Chauffage (kWh)', 'conso'], ['Climatisation (kWh)', 'conso'],
      ['Éclairage (kWh)', 'conso'], ['Prises & IT (kWh)', 'conso'],
      ['DJU chauffage', 'facteur'], ['DJU climatisation', 'facteur'],
    ].map(([key, type]) => ({ key, type, color: SAMPLE_COLORS[key] }));
    return { name: 'Site exemple – Bureaux Paris', siteUuid: 'exemple', granularity: 'mois', columns, rows };
  }
  return { make };
})();
