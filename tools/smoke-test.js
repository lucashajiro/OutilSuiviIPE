// Charge les scripts de app.html dans Node avec un DOM factice pour détecter les erreurs au chargement
// (ReferenceError, TDZ, etc.) que `node --check` ne voit pas. Usage : node tools/smoke-test.js "Outil suivi des IPEs"
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = process.argv[2];

const stub = () => {
  const f = function () {};
  return new Proxy(f, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'length') return 0;
      if (k in t && typeof k === 'symbol') return t[k];
      return stub();
    },
    set() { return true; },
    apply() { return stub(); },
    construct() { return stub(); },
  });
};

const errors = [];
const ctx = {
  console, setTimeout, clearTimeout, Promise, Math, JSON, Date, Intl, Set, Map, Number, String, Array, Object, Symbol, Error, RegExp, isFinite, isNaN, parseFloat, parseInt, URL, TextEncoder, TextDecoder,
  document: stub(), localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  Chart: stub(), requestAnimationFrame: () => 0, getComputedStyle: () => ({ fontFamily: 'x' }),
  indexedDB: stub(), crypto: stub(), fetch: async () => ({ ok: false, status: 0 }), alert() {}, confirm: () => false,
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
process.on('unhandledRejection', e => errors.push('rejet async : ' + (e && e.stack || e)));

const html = fs.readFileSync(path.join(dir, 'app.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !s.startsWith('lib/'));
for (const s of scripts) {
  try { vm.runInContext(fs.readFileSync(path.join(dir, s), 'utf8'), ctx, { filename: s }); console.log('chargé', s); }
  catch (e) { errors.push(`${s} : ${e.stack.split('\n').slice(0, 2).join(' | ')}`); }
}
setTimeout(() => {
  if (errors.length) { console.log('ERREURS :\n' + errors.join('\n')); process.exit(1); }
  console.log('Aucune erreur au chargement');
}, 300);
