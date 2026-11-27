// IPE Builder — mise à jour depuis GitHub
//
// Une extension ne peut pas réécrire ses propres fichiers. On passe donc par l'accès aux dossiers
// du navigateur (File System Access) : l'utilisateur désigne une fois le dossier de l'extension,
// on y écrit les fichiers modifiés de la dernière version publiée sur GitHub, puis l'extension se recharge.
// Le chemin du dossier ne change pas : les IPE enregistrés (stockage local de Chrome) sont conservés.
(() => {
  'use strict';
  const REPO = 'lucashajiro/OutilSuiviIPE';
  const BRANCH = 'main';
  const DIR = 'Outil suivi des IPEs'; // dossier de l'extension dans le dépôt
  const API = `https://api.github.com/repos/${REPO}`;
  const RAW = `https://raw.githubusercontent.com/${REPO}`;
  const enc = p => p.split('/').map(encodeURIComponent).join('/');

  const $ = id => document.getElementById(id);
  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  const localVersion = () => (hasChrome ? chrome.runtime.getManifest().version : '0');

  function setStatus(text, kind = '') {
    const el = $('update-status');
    el.textContent = text;
    el.className = 'update-status' + (kind ? ' ' + kind : '');
  }

  // Compare deux numéros de version "a.b.c" (> 0 si a est plus récent)
  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // Identifiant git d'un fichier : SHA-1 de "blob <taille>\0<contenu>"
  async function gitSha(bytes) {
    const head = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const buf = new Uint8Array(head.length + bytes.byteLength);
    buf.set(head); buf.set(new Uint8Array(bytes), head.length);
    const h = await crypto.subtle.digest('SHA-1', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Un clone git sous Windows (core.autocrlf) a des fins de ligne CRLF alors que GitHub stocke LF :
  // on retire les \r avant de comparer, pour ne pas voir tous les fichiers texte comme modifiés.
  function toLF(bytes) {
    const a = new Uint8Array(bytes), out = new Uint8Array(a.length);
    let n = 0;
    for (let i = 0; i < a.length; i++) if (!(a[i] === 13 && a[i + 1] === 10)) out[n++] = a[i];
    return out.slice(0, n).buffer;
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 404) throw new Error('dépôt introuvable (est-il bien public ?)');
    if (r.status === 403) throw new Error('limite de requêtes GitHub atteinte, réessayer dans une heure');
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
    return r.json();
  }

  // ---------- Mémorisation du dossier choisi (IndexedDB : seul stockage qui garde un handle) ----------
  const idb = (mode, fn) => new Promise((resolve, reject) => {
    const open = indexedDB.open('ipe-update', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
  const loadHandle = () => idb('readonly', s => s.get('dir')).catch(() => null);
  const saveHandle = h => idb('readwrite', s => s.put(h, 'dir'));

  async function readFile(dir, path) {
    try {
      const parts = path.split('/');
      let d = dir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      const f = await (await d.getFileHandle(parts.at(-1))).getFile();
      return await f.arrayBuffer();
    } catch { return null; }
  }

  async function writeFile(dir, path, bytes) {
    const parts = path.split('/');
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
  }

  // Vérifie que le dossier est bien celui de cette extension
  async function isExtensionDir(dir) {
    const m = await readFile(dir, 'manifest.json');
    if (!m) return false;
    try { return JSON.parse(new TextDecoder().decode(m)).name === chrome.runtime.getManifest().name; } catch { return false; }
  }

  async function getDir() {
    let dir = await loadHandle();
    if (dir && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
        (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') dir = null;
    if (dir && !(await isExtensionDir(dir))) dir = null;
    if (!dir) {
      // Pas d'alert() ici : la boîte de dialogue consomme le clic et Chrome refuse ensuite le sélecteur
      setStatus(`Sélectionne le dossier « ${DIR} » (celui qui contient manifest.json), puis autorise la modification. Ce choix est mémorisé.`);
      dir = await window.showDirectoryPicker({ id: 'ipe-extension', mode: 'readwrite' });
      if (!(await isExtensionDir(dir))) throw new Error("ce dossier n'est pas celui de l'extension (manifest.json absent ou différent)");
      await saveHandle(dir);
    }
    return dir;
  }

  // ---------- Mise à jour ----------
  let busy = false;
  async function update() {
    if (busy) return;
    busy = true; $('btn-update').disabled = true;
    try {
      // En premier : le sélecteur de dossier et la demande d'autorisation exigent un clic récent
      const dir = await getDir();

      setStatus('Recherche de la dernière version…');
      const commit = await getJSON(`${API}/commits/${BRANCH}`);
      const tree = await getJSON(`${API}/git/trees/${commit.sha}?recursive=1`);
      if (tree.truncated) throw new Error('liste de fichiers GitHub incomplète');
      const prefix = DIR + '/';
      const remote = tree.tree
        .filter(e => e.type === 'blob' && e.path.startsWith(prefix))
        .map(e => ({ path: e.path.slice(prefix.length), repoPath: e.path, sha: e.sha }));
      if (!remote.some(f => f.path === 'manifest.json')) throw new Error(`manifest.json introuvable dans « ${DIR} » sur GitHub`);

      setStatus('Comparaison des fichiers…');
      const changed = [];
      for (const f of remote) {
        const local = await readFile(dir, f.path);
        if (!local || ((await gitSha(local)) !== f.sha && (await gitSha(toLF(local))) !== f.sha)) changed.push(f);
      }
      if (!changed.length) { setStatus(`À jour (version ${localVersion()})`, 'ok'); return; }

      // Téléchargement complet et vérifié avant toute écriture : en cas d'échec, rien n'est modifié
      setStatus(`Téléchargement de ${changed.length} fichier(s)…`);
      const files = await Promise.all(changed.map(async f => {
        const r = await fetch(`${RAW}/${commit.sha}/${enc(f.repoPath)}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`téléchargement de ${f.path} impossible (${r.status})`);
        const bytes = await r.arrayBuffer();
        if ((await gitSha(bytes)) !== f.sha) throw new Error(`fichier ${f.path} corrompu au téléchargement`);
        return { ...f, bytes };
      }));
      const mf = files.find(f => f.path === 'manifest.json');
      const newVersion = mf ? JSON.parse(new TextDecoder().decode(mf.bytes)).version : localVersion();

      const list = changed.map(f => '• ' + f.path).slice(0, 15).join('\n') + (changed.length > 15 ? '\n…' : '');
      // Garde-fou : la synchronisation écrase tout fichier local différent de GitHub, y compris des
      // modifications pas encore publiées (ex. dans un clone git où l'on développe).
      const cmp = cmpVersion(localVersion(), newVersion);
      const warning = cmp > 0
        ? `⚠ ATTENTION : la version installée (${localVersion()}) est PLUS RÉCENTE que celle de GitHub (${newVersion}).\n` +
          'Si ce dossier contient des modifications pas encore publiées sur GitHub, elles seront DÉFINITIVEMENT PERDUES.\n\n'
        : cmp === 0
          ? `⚠ Même numéro de version (${newVersion}) mais des fichiers diffèrent de GitHub.\n` +
            "S'il s'agit de modifications locales pas encore publiées, elles seront perdues.\n\n"
          : '';
      if (!confirm(warning + `Version installée : ${localVersion()}\nVersion GitHub : ${newVersion}\n\n` +
                   `${changed.length} fichier(s) à remplacer par la version GitHub :\n${list}\n\n` +
                   "L'extension se rechargera ensuite (les IPE enregistrés sont conservés). Continuer ?")) {
        setStatus('Mise à jour annulée'); return;
      }
      // Version locale plus récente : seconde confirmation, la perte de travail étant irréversible
      if (cmp > 0 && !confirm(`Confirmer le retour à la version ${newVersion} de GitHub ? Les fichiers locaux listés seront écrasés.`)) {
        setStatus('Mise à jour annulée'); return;
      }

      setStatus('Installation…');
      files.sort((a, b) => (a.path === 'manifest.json') - (b.path === 'manifest.json')); // manifest en dernier
      for (const f of files) await writeFile(dir, f.path, f.bytes);

      setStatus(`Version ${newVersion} installée, redémarrage…`, 'ok');
      await chrome.storage.local.set({ reopenAfterUpdate: true }); // background.js rouvre l'application
      setTimeout(() => chrome.runtime.reload(), 800);
    } catch (e) {
      if (e && e.name === 'AbortError') setStatus('Mise à jour annulée');
      else if (e && (e.name === 'SecurityError' || e.name === 'NotAllowedError')) setStatus('Chrome a bloqué le choix du dossier : clique à nouveau sur « Mettre à jour ».', 'err');
      else setStatus('Échec : ' + (e && e.message ? e.message : e), 'err');
    } finally {
      busy = false; $('btn-update').disabled = false;
    }
  }

  // Vérification légère à l'ouverture (fichier brut, hors quota API) : signale une nouvelle version
  async function checkSilently() {
    try {
      const r = await fetch(`${RAW}/${BRANCH}/${enc(DIR)}/manifest.json`, { cache: 'no-store' });
      if (!r.ok) return;
      const v = (await r.json()).version;
      if (cmpVersion(v, localVersion()) > 0) {
        $('btn-update').classList.add('has-update');
        setStatus(`Version ${v} disponible`);
      }
    } catch { /* hors ligne : rien à signaler */ }
  }

  function initUpdate() {
    const btn = $('btn-update');
    if (!btn) return;
    if (!hasChrome || !window.showDirectoryPicker) { btn.hidden = true; return; }
    btn.addEventListener('click', update);
    checkSilently();
  }
  initUpdate();
})();
