// Moteur statistique : corrélations, régression linéaire multiple (moindres carrés),
// indicateurs de qualité IPMVP / ASHRAE Guideline 14, jours ouvrés France.
// Aucune dépendance : fonctions pures, testables hors navigateur.

const Stats = (() => {
  const sum = a => a.reduce((s, v) => s + v, 0);
  const mean = a => sum(a) / a.length;

  function pearson(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) return NaN;
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return NaN;
    return sxy / Math.sqrt(sxx * syy);
  }

  // Inversion de matrice carrée (Gauss-Jordan avec pivot partiel)
  function invert(M) {
    const n = M.length;
    const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null; // matrice singulière (facteurs colinéaires)
      [A[c], A[p]] = [A[p], A[c]];
      const piv = A[c][c];
      for (let j = 0; j < 2 * n; j++) A[c][j] /= piv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c];
        if (f !== 0) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
      }
    }
    return A.map(row => row.slice(n));
  }

  // Fonction bêta incomplète régularisée (Numerical Recipes) -> p-value du test t
  function lnGamma(z) {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let x = z, y = z, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const c of g) ser += c / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function betacf(a, b, x) {
    const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d; let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function ibeta(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  // p-value bilatérale d'une statistique t à df degrés de liberté
  const tPValue = (t, df) => (df > 0 && isFinite(t)) ? ibeta(df / 2, 0.5, df / (df + t * t)) : NaN;

  /**
   * Régression linéaire multiple.
   * y : tableau des consommations ; X : { nomFacteur: tableau } ; intercept : bool
   */
  // extra : paramètres estimés hors régression (ex. seuil d'un modèle à point de changement),
  // retirés des degrés de liberté pour ne pas surestimer la qualité du modèle
  function ols(y, X, intercept = true, extra = 0) {
    const names = Object.keys(X);
    const n = y.length;
    const cols = (intercept ? [Array(n).fill(1)] : []).concat(names.map(k => X[k]));
    const terms = (intercept ? ['Constante'] : []).concat(names);
    const p = cols.length;
    if (n <= p + extra) return { error: `Pas assez de points (${n}) pour ${p + extra} paramètres.` };

    const XtX = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => {
      let s = 0; for (let r = 0; r < n; r++) s += cols[i][r] * cols[j][r]; return s;
    }));
    const Xty = cols.map(c => { let s = 0; for (let r = 0; r < n; r++) s += c[r] * y[r]; return s; });
    const inv = invert(XtX);
    if (!inv) return { error: 'Facteurs colinéaires (ou constants) : impossible de calculer le modèle. Retirez un facteur.' };

    const beta = inv.map(row => sum(row.map((v, j) => v * Xty[j])));
    const predicted = Array.from({ length: n }, (_, r) => sum(cols.map((c, i) => beta[i] * c[r])));
    const residuals = y.map((v, r) => v - predicted[r]);
    const ybar = mean(y);
    const sse = sum(residuals.map(e => e * e));
    const sst = intercept ? sum(y.map(v => (v - ybar) ** 2)) : sum(y.map(v => v * v));
    const df = n - p - extra;
    const s2 = sse / df;
    const r2 = sst > 0 ? 1 - sse / sst : NaN;
    const k = names.length;
    const adjR2 = 1 - (1 - r2) * (n - 1) / (n - k - extra - 1);
    const se = inv.map((row, i) => Math.sqrt(Math.max(0, s2 * row[i])));
    const tStat = beta.map((b, i) => (se[i] > 0 ? b / se[i] : NaN));
    const pValues = tStat.map(t => tPValue(t, df));

    // Test F global (le modèle explique-t-il mieux que la moyenne ?)
    const fStat = intercept && k > 0 ? ((sst - sse) / (k + extra)) / s2 : NaN;
    const fP = isFinite(fStat) ? ibeta(df / 2, (k + extra) / 2, df / (df + (k + extra) * fStat)) : NaN;
    return {
      terms, coefs: beta, se, tStat, pValues, n, p, df, inv, fStat, fP,
      r2, adjR2,
      rmse: Math.sqrt(s2),
      cvrmse: Math.sqrt(s2) / ybar,                 // ASHRAE G14 : sqrt(SSE/(n-p)) / moyenne
      nmbe: sum(residuals) / ((n - p) * ybar),      // ASHRAE G14
      predicted, residuals, intercept, factors: names, extra, sse,
    };
  }

  /**
   * Erreur type de la somme des consommations prédites sur m périodes de suivi
   * (incertitude de la consommation de référence ajustée) :
   * SE = RMSE × racine(m + vᵀ (XᵀX)⁻¹ v), v = somme des vecteurs de facteurs des périodes.
   * Hypothèse : résidus indépendants (une autocorrélation la sous-estime).
   */
  function totalPredictionSE(model, factorRows) {
    if (!model.inv || !isFinite(model.rmse)) return NaN;
    const v = (model.intercept ? [factorRows.length] : []).concat(model.factors.map(f => sum(factorRows.map(r => r[f]))));
    let q = 0;
    for (let i = 0; i < v.length; i++) for (let j = 0; j < v.length; j++) q += v[i] * model.inv[i][j] * v[j];
    return model.rmse * Math.sqrt(factorRows.length + q);
  }

  // Applique une équation enregistrée à un jeu de facteurs
  function predict(model, factorValues) {
    let v = model.intercept ? model.coefs[0] : 0;
    model.factors.forEach((f, i) => { v += model.coefs[i + (model.intercept ? 1 : 0)] * factorValues[f]; });
    return v;
  }

  // Toutes les combinaisons non vides d'une liste
  function subsets(list) {
    const out = [];
    for (let m = 1; m < (1 << list.length); m++) out.push(list.filter((_, i) => m & (1 << i)));
    return out;
  }

  // ---------- Calendrier France ----------
  function easter(y) { // algorithme de Meeus/Butcher
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  }
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const holidayCache = {};
  function frenchHolidays(y) {
    if (holidayCache[y]) return holidayCache[y];
    const e = easter(y);
    const s = new Set(['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].map(md => `${y}-${md}`));
    [1, 39, 50].forEach(o => s.add(iso(addDays(e, o)))); // lundi de Pâques, Ascension, lundi de Pentecôte
    return (holidayCache[y] = s);
  }
  const parseISO = s => new Date(s + 'T00:00:00Z');

  // Fin de période (inclusive) selon la granularité
  function periodEnd(startIso, gran) {
    const d = parseISO(startIso);
    if (gran === 'mois') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    if (gran === 'semaine') return addDays(d, 6);
    return d;
  }

  /**
   * Décompte calendaire d'une période.
   * opts.open  : 7 booléens, jour ouvert ou non (index 0 = dimanche, comme Date.getUTCDay)
   * opts.hours : 7 nombres, heures d'ouverture prévues ce jour-là
   * opts.isHoliday(iso) : vrai si jour férié (un jour férié compte comme fermé)
   * Par défaut : lundi-vendredi, 11 h/jour, jours fériés français.
   */
  const DEFAULT_OPEN = [false, true, true, true, true, true, false];
  function calendarCounts(startIso, gran, opts = {}) {
    const open = opts.open || DEFAULT_OPEN;
    const hours = opts.hours || open.map(o => (o ? 11 : 0));
    const isHoliday = opts.isHoliday || (iso => frenchHolidays(+iso.slice(0, 4)).has(iso));
    const start = parseISO(startIso), end = periodEnd(startIso, gran);
    let jo = 0, total = 0, h = 0, hol = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      total++;
      const wd = d.getUTCDay(), di = iso(d);
      if (!open[wd]) continue;
      if (isHoliday(di)) { hol++; continue; }
      jo++; h += hours[wd];
    }
    return { jo, jno: total - jo, total, hours: h, holidaysOnOpenDays: hol };
  }

  // Valeur critique bilatérale du t de Student (ex. alpha = 0,05 -> 95 %)
  function tCrit(df, alpha = 0.05) {
    if (!(df > 0)) return NaN;
    let lo = 0, hi = 1000;
    for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (tPValue(mid, df) > alpha) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  return { mean, sum, pearson, ols, predict, totalPredictionSE, subsets, tPValue, tCrit, calendarCounts, periodEnd, iso };
})();

if (typeof module !== 'undefined') module.exports = Stats;
