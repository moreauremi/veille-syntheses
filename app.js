// =============================================================================
// Tableau de bord des synthèses : comportement de la page
// -----------------------------------------------------------------------------
// Les textes saisis sont toujours affichés avec textContent ; seul l'aperçu,
// fabriqué par apercu.js (HTML du texte neutralisé), est inséré en HTML.
// =============================================================================

import { SUJETS, pageDuSujet } from './config.js?v=16';
import { createClient } from './github.js?v=16';
import { checkSynthese, citedUrls, lastSynthesisDate, parseSyntheses, serializeSyntheses, setSources } from './syntheses.js?v=16';
import { renderPreview } from './apercu.js?v=16';
import { forgetVisitsKey, showVisits } from './visites.js?v=16';
import { byDate, discard, restore, usage } from './actualites.js?v=16';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'syntheses-jeton';
const SUJET_KEY = 'syntheses-sujet'; // dernier sujet ouvert, retrouvé à la visite suivante
const CONFLICT =
  "Le fichier des synthèses a changé entre-temps (depuis VS Code ou un autre onglet). La liste vient d'être rechargée : vérifiez-la, votre texte est conservé, puis enregistrez à nouveau.";

const state = {
  client: null,
  sujet: storedSujet(), // sujet de veille affiché (identifiant, voir config.js)
  version: null, // empreinte (sha) du fichier sur GitHub, à jour après chaque enregistrement
  syntheses: [],
  editing: null, // synthèse en cours de modification : { index, titre } ; null = nouvelle
  saved: { titre: '', texte: '' }, // contenu au dernier chargement ou enregistrement
  busy: false,
  suggestion: null, // proposition de l'IA en attente : { start, end, texte }
  news: { data: null, version: null, items: [] }, // actualités du sujet (actualites.json)
  newsShown: 8, // nombre d'actualités affichées (« Voir les plus anciennes » montre tout)
  newsTab: 'actuelles', // onglet des actualités : « actuelles » ou « hors-sujet »
  showUsed: false, // afficher aussi les actualités déjà citées dans une autre synthèse
  lastDates: {}, // date de la dernière synthèse de chaque sujet (AAAA-MM-JJ ou null)
  overview: { topics: {}, runs: {} }, // vue d'ensemble : résumé de chaque sujet, dernières tâches GitHub
};

const MAX_DAYS = 21; // au-delà, un sujet est signalé en retard (comme le rappel du lundi)
const longDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const formatDay = (day) => longDate.format(new Date(`${day}T00:00:00Z`));

// --- Jeton : localStorage (rester connecté) ou sessionStorage (cet onglet) -------

function storedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function storeToken(token, remember) {
  try {
    forgetToken();
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    // stockage indisponible (navigation privée…) : connecté jusqu'au rechargement
  }
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // rien à effacer
  }
}

function storedSujet() {
  let id = null;
  try {
    id = localStorage.getItem(SUJET_KEY);
  } catch {
    // stockage indisponible : premier sujet
  }
  return SUJETS.some((s) => s.id === id) ? id : SUJETS[0].id;
}

// --- Connexion -------------------------------------------------------------------

function showLogin(message = '') {
  state.client = null;
  $('view-home').hidden = true;
  $('view-syntheses').hidden = true;
  $('views').hidden = true;
  $('bar-links').hidden = true;
  $('login').hidden = false;
  $('login-status').textContent = message;
  $('token').value = '';
  $('token').focus();
}

// Le jeton est vérifié en lisant le fichier des synthèses du sujet
async function connect(token) {
  const client = createClient(token);
  const data = await client.readFile(state.sujet);
  state.client = client;
  $('login').hidden = true;
  $('views').hidden = false;
  $('bar-links').hidden = false;
  renderSujets();
  applyFile(data);
  if (!state.editing && !$('texte').value) startNew();
  loadNews();
  loadOverview();
  showVisits();
  route();
}

// --- Vues : #/ (vue d'ensemble) et #/syntheses[/<sujet>] ------------------------------

const HINTS = {
  home: "1 vue d'ensemble · 2 synthèses · « Écrire » ouvre les synthèses d'un sujet",
  syntheses: '1 vue d\'ensemble · 2 synthèses · Cmd+S / Ctrl+S publier · sélection + « Reformuler » : ce passage seulement',
};

async function route() {
  if (!state.client) return;
  const [, view, sujet] = window.location.hash.replace(/^#/, '').split('/');
  const current = view === 'syntheses' ? 'syntheses' : 'home';
  $('view-home').hidden = current !== 'home';
  $('view-syntheses').hidden = current !== 'syntheses';
  for (const tab of document.querySelectorAll('.view-tab')) {
    if (tab.dataset.view === current) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('hints').textContent = HINTS[current];
  document.title = `${current === 'home' ? "Vue d'ensemble" : 'Synthèses'} · Tableau de bord · RémiOS`;
  if (current === 'syntheses' && SUJETS.some((s) => s.id === sujet) && sujet !== state.sujet) {
    // Changement refusé (modifications non enregistrées) : l'adresse revient au sujet affiché
    if (!(await openSujet(sujet))) history.replaceState(null, '', `#/syntheses/${state.sujet}`);
  }
}

window.addEventListener('hashchange', route);

// Touches 1 et 2 : changer de vue (hors des champs de saisie)
document.addEventListener('keydown', (event) => {
  if (!state.client || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  const hash = { 1: '#/', 2: `#/syntheses/${state.sujet}` }[event.key];
  if (!hash) return;
  event.preventDefault();
  window.location.hash = hash;
});

// --- Vue d'ensemble : état de chaque veille, du site et des tâches automatiques --------

async function loadOverview() {
  const client = state.client;
  $('topics-status').textContent = 'Chargement…';
  await Promise.all([
    ...SUJETS.map(async ({ id }) => {
      try {
        const [file, news] = await Promise.all([client.readFile(id), client.readNews(id)]);
        setTopicOverview(id, parseSyntheses(file.source).syntheses, news.data);
      } catch (error) {
        state.overview.topics[id] = { error: error.message };
      }
    }),
    ...['deploy.yml', 'veille.yml'].map(async (workflow) => {
      try {
        state.overview.runs[workflow] = await client.latestRun(workflow);
      } catch (error) {
        state.overview.runs[workflow] = { error: error.message };
      }
    }),
  ]);
  $('topics-status').textContent = '';
  renderOverview();
  renderAges();
}

$('overview-refresh').addEventListener('click', loadOverview);

// Résumé d'un sujet : synthèses, dernière date, actualités pas encore citées
function setTopicOverview(id, syntheses, data) {
  const used = usage(syntheses);
  state.lastDates[id] = lastSynthesisDate(syntheses);
  state.overview.topics[id] = {
    count: syntheses.length,
    last: state.lastDates[id],
    news: data.actualites.length,
    todo: data.actualites.filter((a) => !used.has(a.url)).length,
    horsSujet: (data.horsSujet ?? []).length,
    miseAJour: data.miseAJour,
  };
}

// Après une publication ou un « Hors sujet » : résumé du sujet affiché mis à jour
function updateCurrentOverview() {
  if (!state.news.data) return;
  setTopicOverview(state.sujet, state.syntheses, state.news.data);
  renderOverview();
}

function daysSince(date) {
  return Math.floor((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(date)) / 86_400_000);
}

function ageText(date) {
  if (!date) return 'aucune synthèse';
  const days = daysSince(date);
  return days <= 0 ? "synthèse aujourd'hui" : days === 1 ? 'synthèse hier' : `synthèse il y a ${days} j`;
}

// « il y a 12 min », « il y a 3 h », « il y a 2 j »
function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 48 * 60) return `il y a ${Math.round(minutes / 60)} h`;
  return `il y a ${Math.round(minutes / 1440)} j`;
}

// Prochaine collecte : chaque lundi à 5 h 17 UTC (voir veille.yml du site)
function nextCollect(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 17));
  while (next.getUTCDay() !== 1 || next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(next);
}

// Ligne façon journal de démarrage : [  OK  ], [ WARN ], [FAILED], [ .... ]
function journalLine(kind, label, detail, link = null) {
  const li = document.createElement('li');
  li.className = `line ${kind}`;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = { ok: '[  OK  ]', warn: '[ WARN ]', err: '[FAILED]', info: '[ .... ]' }[kind];
  const text = document.createElement('span');
  if (label) {
    const strong = document.createElement('strong');
    strong.textContent = label;
    text.append(strong, ' ');
  }
  text.append(detail);
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = link.text;
    text.append(' ', a);
  }
  li.append(badge, text);
  return li;
}

function renderOverview() {
  // Veille : un sujet par ligne, avec « Écrire »
  $('topics').replaceChildren(
    ...SUJETS.map((sujet, index) => {
      const info = state.overview.topics[sujet.id];
      const li = document.createElement('li');
      li.className = 'topic';
      const head = document.createElement('p');
      head.className = 'topic-head';
      const key = document.createElement('span');
      key.className = 'item-key';
      key.setAttribute('aria-hidden', 'true');
      key.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'topic-name';
      name.textContent = sujet.nom;
      head.append(key, name);

      const meta = document.createElement('p');
      meta.className = 'topic-meta';
      let status;
      if (!info) {
        status = journalLine('info', '', 'chargement…');
      } else if (info.error) {
        status = journalLine('err', '', info.error);
      } else {
        const late = !info.last || daysSince(info.last) > MAX_DAYS;
        status = journalLine(late ? 'warn' : 'ok', '', ageText(info.last));
        const parts = [
          `${info.count} synthèse${info.count > 1 ? 's' : ''}`,
          `${info.todo} actualité${info.todo > 1 ? 's' : ''} à traiter`,
        ];
        if (info.horsSujet) parts.push(`${info.horsSujet} hors sujet`);
        if (info.miseAJour) parts.push(`collecte du ${formatDay(info.miseAJour)}`);
        meta.textContent = parts.join(' · ');
      }
      status.classList.add('topic-status');

      const write = document.createElement('a');
      write.className = 'tui-btn tui-btn--small';
      write.href = `#/syntheses/${sujet.id}`;
      write.textContent = 'Écrire';
      write.setAttribute('aria-label', `Écrire une synthèse : ${sujet.nom}`);
      li.append(head, status, meta, write);
      return li;
    }),
  );
  $('next-collect').textContent = `Prochaine collecte des actualités : ${nextCollect()}.`;

  // Site : dernière publication, dernière collecte, rappel
  const runs = state.overview.runs;
  const runLine = (workflow, label, done) => {
    const run = runs[workflow];
    if (run === undefined) return journalLine('info', label, 'chargement…');
    if (run?.error) return journalLine('err', label, run.error);
    if (!run) return journalLine('info', label, 'jamais lancée');
    const link = { href: run.html_url, text: 'journal ↗' };
    if (run.status !== 'completed') return journalLine('info', label, `en cours (lancée ${ago(run.created_at)})`, link);
    if (run.conclusion === 'success') return journalLine('ok', label, `${done} ${ago(run.updated_at)}`, link);
    return journalLine('err', label, `échec ${ago(run.updated_at)}`, link);
  };
  const late = SUJETS.filter((s) => state.overview.topics[s.id] && !state.overview.topics[s.id].error && (!state.overview.topics[s.id].last || daysSince(state.overview.topics[s.id].last) > MAX_DAYS));
  $('site-status').replaceChildren(
    runLine('deploy.yml', 'Publication du site', 'réussie'),
    runLine('veille.yml', 'Collecte de la veille', 'réussie'),
    late.length
      ? journalLine('warn', 'Régularité', `à écrire : ${late.map((s) => s.nom).join(', ')} (rappel par e-mail le lundi)`)
      : journalLine('ok', 'Régularité', 'chaque sujet a une synthèse de moins de 3 semaines'),
  );
}

// --- Choix du sujet de veille -------------------------------------------------------

// Barre des sujets (onglets) : celui affiché en barre bleue, comme le menu de RémiOS
function renderSujets() {
  $('sujets').replaceChildren(
    ...SUJETS.map((sujet, index) => {
      const tab = document.createElement('button');
      const current = sujet.id === state.sujet;
      tab.type = 'button';
      tab.className = 'sujet';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(current));
      tab.tabIndex = current ? 0 : -1;
      tab.dataset.sujet = sujet.id;
      const key = document.createElement('span');
      key.className = 'item-key';
      key.setAttribute('aria-hidden', 'true');
      key.textContent = String(index + 1);
      const name = document.createElement('span');
      name.append(key, sujet.nom);
      const age = document.createElement('span');
      age.className = 'sujet-age';
      tab.append(name, age);
      tab.addEventListener('click', () => openSujet(sujet.id));
      return tab;
    }),
  );
  $('site-link').href = pageDuSujet(state.sujet);
  renderAges();
}

// --- Régularité : date de la dernière synthèse de chaque sujet -------------------------

// Sous le nom de chaque sujet : « il y a 12 j », en rouge au-delà de 21 jours
// ou sans aucune synthèse (le rappel du lundi ouvre alors une issue GitHub)
function renderAges() {
  for (const tab of $('sujets').querySelectorAll('.sujet')) {
    const date = state.lastDates[tab.dataset.sujet];
    const age = tab.querySelector('.sujet-age');
    if (date === undefined) {
      age.textContent = '';
      continue;
    }
    const days = date ? Math.floor((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(date)) / 86_400_000) : null;
    age.textContent = days === null ? 'aucune synthèse' : days <= 0 ? "synthèse aujourd'hui" : days === 1 ? 'synthèse hier' : `synthèse il y a ${days} j`;
    tab.classList.toggle('late', days === null || days > MAX_DAYS);
  }
}

// Au clavier : ← et → passent d'un sujet à l'autre
$('sujets').addEventListener('keydown', (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const index = SUJETS.findIndex((s) => s.id === state.sujet);
  openSujet(SUJETS[(index + step + SUJETS.length) % SUJETS.length].id, { focus: true });
});

// Ouvre les synthèses d'un sujet ; false si le changement est refusé
async function openSujet(id, { focus = false } = {}) {
  if (id === state.sujet) return true;
  if (state.busy) return false;
  if (isDirty() && !confirm('Des modifications ne sont pas enregistrées. Changer de sujet quand même ?')) return false;
  const previous = state.sujet;
  state.sujet = id;
  try {
    localStorage.setItem(SUJET_KEY, id);
  } catch {
    // stockage indisponible : le choix vaut jusqu'au rechargement
  }
  renderSujets();
  if (focus) $('sujets').querySelector(`[data-sujet="${id}"]`).focus();
  let loaded = false;
  await run('Chargement des synthèses…', async () => {
    const data = await state.client.readFile(id);
    state.editing = null;
    state.news = { data: null, version: null, items: [] };
    applyFile(data);
    startNew();
    loaded = true;
  });
  if (loaded) loadNews();
  // Échec du chargement : retour au sujet précédent, dont la liste est encore affichée
  if (!loaded && state.client) {
    state.sujet = previous;
    renderSujets();
  }
  if (!$('view-syntheses').hidden) history.replaceState(null, '', `#/syntheses/${state.sujet}`);
  return loaded;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('token').value.trim();
  if (!token) return;
  $('login-status').textContent = 'Vérification du jeton…';
  try {
    await connect(token);
    storeToken(token, $('remember').checked);
  } catch (error) {
    $('login-status').textContent = error.message;
    $('token').select();
  }
});

$('logout').addEventListener('click', () => {
  if (isDirty() && !confirm('Des modifications ne sont pas enregistrées. Se déconnecter quand même ?')) return;
  forgetToken();
  forgetVisitsKey();
  resetEditor();
  showLogin();
});

// --- Liste des synthèses ------------------------------------------------------------

function applyFile({ source, version }) {
  applyData({ version, syntheses: parseSyntheses(source).syntheses });
}

function applyData({ version, syntheses }) {
  state.version = version;
  state.syntheses = syntheses;
  state.lastDates[state.sujet] = lastSynthesisDate(syntheses);
  renderAges();
  renderNews();
  updateCurrentOverview();
  // La synthèse en cours de modification a pu changer de place (ajout ou
  // suppression ailleurs) : on la retrouve par son titre.
  if (state.editing) {
    const { index, titre } = state.editing;
    const found = syntheses[index]?.titre === titre ? index : syntheses.findIndex((s) => s.titre === titre);
    state.editing = found === -1 ? null : { index: found, titre };
  }
  renderList();
  renderEditorTitle();
}

async function reload() {
  applyFile(await state.client.readFile(state.sujet));
}

function renderList() {
  $('list').replaceChildren(
    ...state.syntheses.map((synthese, index) => {
      const item = document.createElement('li');
      item.className = state.editing?.index === index ? 'item current' : 'item';

      // Numéro de rubrique, comme dans le menu de RémiOS
      const key = document.createElement('span');
      key.className = 'item-key';
      key.setAttribute('aria-hidden', 'true');
      key.textContent = String(index + 1);
      const title = document.createElement('p');
      title.className = 'item-title';
      title.append(key, synthese.titre);

      const excerpt = document.createElement('p');
      excerpt.className = 'item-excerpt';
      // Extrait du texte, sans le bloc « Sources »
      excerpt.textContent = plainText(setSources(synthese.texte, [], () => '')).slice(0, 160);

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.append(
        button('Modifier', () => edit(index), `Modifier « ${synthese.titre} »`, 'tui-btn tui-btn--small'),
        button('Supprimer', () => remove(index), `Supprimer « ${synthese.titre} »`, 'tui-btn tui-btn--small danger'),
      );

      item.append(title, excerpt, actions);
      return item;
    }),
  );
  $('count').textContent = `(${state.syntheses.length})`;
  $('empty').hidden = state.syntheses.length > 0;
}

function button(label, onClick, ariaLabel, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.setAttribute('aria-label', ariaLabel);
  if (className) element.className = className;
  element.addEventListener('click', onClick);
  return element;
}

// Markdown → texte brut approximatif, pour l'extrait de la liste
function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Édition ------------------------------------------------------------------------

// Début du titre d'une nouvelle synthèse : la date du jour, « 09/10/2026 - »
function todayTitle() {
  const date = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
  return `${date} - `;
}

function fillEditor(titre, texte) {
  hideSuggestion();
  $('titre').value = titre;
  $('texte').value = texte;
  state.saved = { titre, texte };
  setStatus('');
  refreshPreview();
  renderNews();
}

function startNew() {
  state.editing = null;
  fillEditor('', '');
  $('titre').value = todayTitle(); // pré-rempli, pas une modification
  state.saved.titre = $('titre').value;
  renderList();
  renderEditorTitle();
  $('titre').focus();
}

function edit(index) {
  if (state.busy || state.editing?.index === index) return;
  if (isDirty() && !confirm('Des modifications ne sont pas enregistrées. Les abandonner ?')) return;
  const { titre, texte } = state.syntheses[index];
  state.editing = { index, titre };
  fillEditor(titre, texte);
  renderList();
  renderEditorTitle();
  $('texte').focus();
}

function resetEditor() {
  state.editing = null;
  fillEditor('', '');
}

function renderEditorTitle() {
  $('editor-title').textContent = state.editing ? 'Modifier la synthèse' : 'Nouvelle synthèse';
}

function isDirty() {
  return $('titre').value !== state.saved.titre || $('texte').value !== state.saved.texte;
}

$('new').addEventListener('click', () => {
  if (state.busy) return;
  if (isDirty() && !confirm('Des modifications ne sont pas enregistrées. Les abandonner ?')) return;
  startNew();
});

$('cancel').addEventListener('click', () => {
  if (state.busy || !isDirty()) return;
  if (!confirm('Revenir à la dernière version enregistrée ?')) return;
  fillEditor(state.saved.titre, state.saved.texte);
});

window.addEventListener('beforeunload', (event) => {
  if (isDirty() || state.busy) event.preventDefault();
});

// --- Enregistrement : chaque changement est un commit sur GitHub ---------------------

$('editor-form').addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});

// Cmd+S / Ctrl+S : enregistrer
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's' && !$('view-syntheses').hidden) {
    event.preventDefault();
    save();
  }
});

// Relit le fichier, applique la modification, puis l'enregistre. Si le fichier
// a changé depuis l'affichage de la liste, rien n'est écrit (pas d'écrasement
// d'une modification faite ailleurs).
async function commit(edit) {
  const current = await state.client.readFile(state.sujet);
  if (current.version !== state.version) throw Object.assign(new Error(CONFLICT), { status: 409 });
  const doc = parseSyntheses(current.source);
  const message = edit(doc.syntheses);
  const saved = await state.client.writeFile(state.sujet, serializeSyntheses(doc), current.version, message);
  return { version: saved.version, commit: saved.commit, syntheses: doc.syntheses };
}

function checkIndex(syntheses, index) {
  if (index >= syntheses.length) throw Object.assign(new Error(CONFLICT), { status: 409 });
}

async function save() {
  if (state.busy) return;
  if (state.suggestion) return setStatus("Choisissez d'abord : remplacer par la proposition de l'IA, ou garder votre texte.", 'err');
  if ($('titre').value.trim() === todayTitle().trim()) return setStatus('Complétez le titre de la synthèse.', 'err', $('titre'));
  const checked = checkSynthese({ titre: $('titre').value, texte: $('texte').value });
  if (checked.errors) return setStatus(`Impossible d'enregistrer : ${checked.errors.join(' ; ')}.`, 'err');
  const synthese = checked.synthese;

  await run('Publication en cours…', async () => {
    const index = state.editing?.index;
    const data = await commit((syntheses) => {
      if (index === undefined) {
        syntheses.unshift(synthese);
        return `veille(${state.sujet}): nouvelle synthèse « ${synthese.titre} »`;
      }
      checkIndex(syntheses, index);
      syntheses[index] = synthese;
      return `veille(${state.sujet}): synthèse « ${synthese.titre} » modifiée`;
    });
    state.editing = { index: index ?? 0, titre: synthese.titre };
    applyData(data);
    $('titre').value = synthese.titre;
    $('texte').value = synthese.texte;
    state.saved = { ...synthese };
    setStatus('Enregistré. Le site sera à jour dans 2 à 3 minutes.', 'ok', null, data.commit);
  });
}

async function remove(index) {
  if (state.busy) return;
  const { titre } = state.syntheses[index];
  if (!confirm(`Supprimer la synthèse « ${titre} » du site ?`)) return;
  await run('Suppression en cours…', async () => {
    const data = await commit((syntheses) => {
      checkIndex(syntheses, index);
      const [removed] = syntheses.splice(index, 1);
      return `veille(${state.sujet}): synthèse « ${removed.titre} » supprimée`;
    });
    const wasEditing = state.editing?.index === index;
    applyData(data);
    if (wasEditing) startNew();
    setStatus('Synthèse supprimée. Le site sera à jour dans 2 à 3 minutes.', 'ok', null, data.commit);
  });
}

// Action longue : boutons désactivés pendant l'attente, erreur affichée. Jeton
// refusé : retour à la connexion. Conflit : liste rechargée, texte conservé.
async function run(message, action) {
  state.busy = true;
  document.body.classList.add('busy');
  setStatus(message, 'info');
  try {
    await action();
  } catch (error) {
    if (error.status === 401) {
      forgetToken();
      return showLogin(error.message);
    }
    setStatus(error.status === 409 ? CONFLICT : error.message, 'err');
    if (error.status === 409) await reload().catch(() => {});
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
  }
}

function setStatus(message, kind = '', focus = null, link = null) {
  const status = $('status');
  status.className = kind ? `status ${kind}` : 'status';
  status.replaceChildren(message);
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = 'Voir le commit ↗';
    status.append(' ', anchor);
  }
  focus?.focus();
}

// --- Reformulation par l'IA (workflow GitHub Actions du dépôt du site) -----------------

$('rephrase').addEventListener('click', async () => {
  if (state.busy) return;
  const area = $('texte');
  const { selectionStart, selectionEnd, value } = area;
  const partial = selectionEnd > selectionStart && value.slice(selectionStart, selectionEnd).trim() !== '';
  const start = partial ? selectionStart : 0;
  const end = partial ? selectionEnd : value.length;
  const passage = value.slice(start, end);
  if (!passage.trim()) return setStatus("Écrivez d'abord un texte, ou sélectionnez le passage à reformuler.", 'err', area);

  // Le texte reste en lecture seule jusqu'au choix : la proposition remplacera
  // exactement le passage envoyé.
  area.readOnly = true;
  const waiting = "GitHub prépare une machine pour l'IA : 30 secondes à une minute";
  await run(`Reformulation en cours… (${waiting})`, async () => {
    const texte = await state.client.rephrase(passage.trim(), state.sujet, (seconds) => {
      setStatus(`Reformulation en cours… ${seconds} s (${waiting})`, 'info');
    });
    // Garder les espaces et retours à la ligne qui entouraient le passage
    const before = passage.match(/^\s*/)[0];
    const after = passage.match(/\s*$/)[0];
    state.suggestion = { start, end, texte: `${before}${texte}${after}` };
    $('suggestion-scope').textContent = partial ? 'Pour le passage sélectionné :' : 'Pour tout le texte :';
    $('suggestion-text').textContent = texte;
    $('suggestion').hidden = false;
    setStatus('');
    $('accept').focus();
  });
  if (!state.suggestion) area.readOnly = false;
});

$('accept').addEventListener('click', () => {
  const { start, end, texte } = state.suggestion;
  const area = $('texte');
  hideSuggestion();
  area.setRangeText(texte, start, end, 'select');
  area.focus();
  refreshPreview();
  setStatus('Texte remplacé : relisez-le, puis enregistrez. Cmd+Z / Ctrl+Z pour revenir en arrière.', 'ok');
});

$('reject').addEventListener('click', () => {
  const { start, end } = state.suggestion;
  hideSuggestion();
  $('texte').focus();
  $('texte').setSelectionRange(start, end);
});

function hideSuggestion() {
  state.suggestion = null;
  $('suggestion').hidden = true;
  $('texte').readOnly = false;
}

// --- Aperçu ---------------------------------------------------------------------------

let previewTimer;

$('preview-toggle').addEventListener('click', () => {
  const open = $('preview').hidden;
  $('preview').hidden = !open;
  $('preview-toggle').setAttribute('aria-expanded', String(open));
  refreshPreview();
});

for (const field of ['titre', 'texte']) {
  $(field).addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      refreshPreview();
      syncNewsChecks();
    }, 200);
  });
}

function refreshPreview() {
  if (!$('preview').hidden) $('preview-content').innerHTML = renderPreview($('titre').value, $('texte').value);
}

// --- Actualités du sujet : sources de la synthèse, « Hors sujet » ---------------------
//
// Deux onglets : « Dernières actualités » (celles du site) et « Hors sujet »
// (écartées, à remettre si besoin). Une actualité déjà citée dans une autre
// synthèse publiée est masquée, sauf avec « Afficher les utilisées », qui la
// montre avec l'étiquette « utilisé ». Celles de la synthèse en cours restent
// visibles, pour pouvoir les cocher et décocher.

async function loadNews() {
  const sujet = state.sujet;
  $('news-status').textContent = 'Chargement des actualités…';
  try {
    const { data, version } = await state.client.readNews(sujet);
    if (sujet !== state.sujet) return; // sujet changé entre-temps
    setNews(data, version);
    $('news-status').textContent = '';
  } catch (error) {
    $('news-status').textContent = `Actualités indisponibles : ${error.message}`;
  }
}

function setNews(data, version) {
  state.news = { data, version, items: [...data.actualites].sort(byDate) };
  renderNews();
  updateCurrentOverview();
}

// Synthèses publiées, sauf celle en cours de modification
function otherSyntheses() {
  return state.syntheses.filter((_, i) => i !== state.editing?.index);
}

function renderNews() {
  const horsSujet = [...(state.news.data?.horsSujet ?? [])].sort((a, b) => (b.ecarteLe ?? '').localeCompare(a.ecarteLe ?? '') || byDate(a, b));
  const onHorsSujet = state.newsTab === 'hors-sujet';
  const used = usage(otherSyntheses());
  const cited = citedUrls($('texte').value);
  const hiddenUsed = state.news.items.filter((a) => used.has(a.url) && !cited.has(a.url));
  const visible = state.news.items.filter((a) => state.showUsed || !used.has(a.url) || cited.has(a.url));
  const list = onHorsSujet ? horsSujet : visible;

  // Onglets, avec leur nombre d'actualités
  for (const [id, label, count] of [['news-tab-actuelles', 'Dernières actualités', visible.length], ['news-tab-hors-sujet', 'Hors sujet', horsSujet.length]]) {
    const tab = $(id);
    const selected = (id === 'news-tab-hors-sujet') === onHorsSujet;
    tab.textContent = `${label} (${count})`;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('news-hint').textContent = onHorsSujet
    ? 'Actualités retirées du site : la collecte ne les reproposera pas. « Remettre » les replace dans la veille.'
    : "Cochez celles dont parle la synthèse : leurs liens s'ajoutent en fin de texte, sous « Sources ». Celles déjà citées dans une autre synthèse sont masquées. « Hors sujet » les retire du site, sans les perdre.";
  $('news-empty').hidden = list.length > 0;
  $('news-empty').textContent = onHorsSujet
    ? 'Aucune actualité écartée.'
    : state.news.items.length
      ? 'Toutes les actualités sont déjà utilisées dans vos synthèses.'
      : "Aucune actualité pour l'instant : la prochaine collecte du lundi remplira cette liste.";

  $('news-list').replaceChildren(...list.slice(0, state.newsShown).map((item) => (onHorsSujet ? discardedItem(item) : newsItem(item, cited, used))));

  const rest = list.length - state.newsShown;
  $('news-more').hidden = rest <= 0;
  $('news-more').textContent = `Voir les ${rest} plus ancienne${rest > 1 ? 's' : ''}`;
  $('news-used').hidden = onHorsSujet || (hiddenUsed.length === 0 && !state.showUsed);
  $('news-used').textContent = state.showUsed ? 'Masquer les utilisées' : `Afficher les utilisées (${hiddenUsed.length})`;
  $('news-used').setAttribute('aria-pressed', String(state.showUsed));
}

// Une actualité de l'onglet « Dernières actualités » : case à cocher, titre,
// date et source, lien vers l'article, étiquette « utilisé », « Hors sujet »
function newsItem(item, cited, used) {
  const li = document.createElement('li');
  li.className = 'news-item';

  const label = document.createElement('label');
  label.className = 'news-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.url = item.url;
  box.checked = cited.has(item.url);
  box.addEventListener('change', () => toggleSource(item, box));
  const title = document.createElement('span');
  title.className = 'news-title';
  title.textContent = item.titre;
  label.append(box, title);

  li.append(label, newsMeta(item, used.get(item.url)));
  li.append(button('Hors sujet', () => discardNews(item), `Retirer « ${item.titre} » de la veille`, 'tui-btn tui-btn--small danger'));
  return li;
}

// Une actualité de l'onglet « Hors sujet » : titre, date d'écartement, « Remettre »
function discardedItem(item) {
  const li = document.createElement('li');
  li.className = 'news-item discarded';
  const title = document.createElement('p');
  title.className = 'news-title';
  title.textContent = item.titre;
  const meta = newsMeta(item);
  if (item.ecarteLe) meta.prepend(`Écartée le ${formatDay(item.ecarteLe)} · `);
  li.append(title, meta, button('Remettre', () => restoreNews(item), `Remettre « ${item.titre} » dans la veille`, 'tui-btn tui-btn--small'));
  return li;
}

// Date, source, lien vers l'article ; « utilisé » si citée dans une synthèse publiée
function newsMeta(item, usedIn = null) {
  const meta = document.createElement('p');
  meta.className = 'news-meta';
  const link = document.createElement('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'lire ↗';
  meta.append(`${formatDay(item.date)} · ${item.source} · `, link);
  if (usedIn) {
    const tag = document.createElement('span');
    tag.className = 'tag-used';
    tag.textContent = 'utilisé';
    tag.title = `Citée dans ${usedIn.map((t) => `« ${t} »`).join(', ')}`;
    meta.append(' ', tag);
  }
  return meta;
}

// Onglets « Dernières actualités » / « Hors sujet » (← et → au clavier)
function openNewsTab(tab) {
  state.newsTab = tab;
  state.newsShown = 8;
  renderNews();
}

$('news-tab-actuelles').addEventListener('click', () => openNewsTab('actuelles'));
$('news-tab-hors-sujet').addEventListener('click', () => openNewsTab('hors-sujet'));
$('news-tabs').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  openNewsTab(state.newsTab === 'hors-sujet' ? 'actuelles' : 'hors-sujet');
  $(state.newsTab === 'hors-sujet' ? 'news-tab-hors-sujet' : 'news-tab-actuelles').focus();
});

$('news-used').addEventListener('click', () => {
  state.showUsed = !state.showUsed;
  renderNews();
});

$('news-more').addEventListener('click', () => {
  state.newsShown = Number.POSITIVE_INFINITY;
  renderNews();
});

// Cases cochées = actualités dont le lien est déjà dans le texte
function syncNewsChecks() {
  const cited = citedUrls($('texte').value);
  for (const box of $('news-list').querySelectorAll('input[type="checkbox"]')) box.checked = cited.has(box.dataset.url);
}

// Case cochée ou décochée : le bloc « Sources » en fin de texte est réécrit
function toggleSource(item, box) {
  const area = $('texte');
  if (state.busy || area.readOnly) {
    box.checked = !box.checked; // pas pendant une publication ou une reformulation
    return;
  }
  const cited = citedUrls(area.value);
  if (box.checked) cited.add(item.url);
  else cited.delete(item.url);
  area.value = setSources(area.value, state.news.items.filter((a) => cited.has(a.url)), formatDay);
  refreshPreview();
}

// Écrit le fichier des actualités (un commit) ; en cas de modification faite
// ailleurs entre-temps (collecte du lundi), la liste est rechargée
async function saveNews(next, version, message) {
  try {
    return await state.client.writeNews(state.sujet, next, version, message);
  } catch (error) {
    if (error.status !== 409) throw error;
    await loadNews();
    throw new Error("Le fichier des actualités a changé entre-temps (collecte du lundi ?) : la liste vient d'être rechargée, recommencez.", { cause: error });
  }
}

// « Hors sujet » : l'actualité quitte le site pour l'onglet « Hors sujet »
async function discardNews(item) {
  if (state.busy) return;
  const nom = SUJETS.find((s) => s.id === state.sujet).nom;
  if (!confirm(`Retirer « ${item.titre} » de la veille ${nom} ? Elle disparaîtra du site ; vous la retrouverez dans l'onglet « Hors sujet ».`)) return;
  await run("Retrait de l'actualité…", async () => {
    const { data, version } = await state.client.readNews(state.sujet);
    const next = discard(data, item.url, new Date().toISOString().slice(0, 10));
    if (!next) {
      setNews(data, version);
      throw new Error("Cette actualité n'est déjà plus dans la veille : la liste vient d'être rechargée.");
    }
    const saved = await saveNews(next, version, `veille(${state.sujet}): actualité « ${item.titre} » retirée (hors sujet)`);
    setNews(next, saved.version);
    // Si elle était citée, son lien quitte aussi le bloc « Sources »
    const area = $('texte');
    const cited = citedUrls(area.value);
    if (cited.delete(item.url)) {
      area.value = setSources(area.value, state.news.items.filter((a) => cited.has(a.url)), formatDay);
      refreshPreview();
    }
    setStatus('Actualité retirée du site (onglet « Hors sujet »). Le site sera à jour dans 2 à 3 minutes.', 'ok', null, saved.commit);
  });
}

// « Remettre » : l'actualité revient dans la veille, et sur le site
async function restoreNews(item) {
  if (state.busy) return;
  await run("Remise de l'actualité…", async () => {
    const { data, version } = await state.client.readNews(state.sujet);
    const next = restore(data, item.url);
    if (!next) {
      setNews(data, version);
      throw new Error("Cette actualité n'est plus dans « Hors sujet » : la liste vient d'être rechargée.");
    }
    const saved = await saveNews(next, version, `veille(${state.sujet}): actualité « ${item.titre} » remise dans la veille`);
    setNews(next, saved.version);
    setStatus('Actualité remise dans la veille. Le site sera à jour dans 2 à 3 minutes.', 'ok', null, saved.commit);
  });
}

// --- Démarrage ------------------------------------------------------------------------

// Jamais affichée dans un cadre d'un autre site (on y ferait cliquer
// « Supprimer » à l'insu de l'utilisateur) : GitHub Pages ne permet pas
// d'envoyer l'en-tête qui l'interdit, d'où cette vérification.
if (window.top !== window.self) {
  document.body.textContent = 'Cette page ne peut pas être affichée dans un cadre.';
} else {
  const token = storedToken();
  if (!token) {
    showLogin();
  } else {
    try {
      await connect(token);
    } catch (error) {
      if (error.status === 401) forgetToken();
      showLogin(error.message);
    }
  }
}
