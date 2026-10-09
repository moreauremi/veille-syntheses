// =============================================================================
// Tableau de bord des synthèses : comportement de la page
// -----------------------------------------------------------------------------
// Les textes saisis sont toujours affichés avec textContent ; seul l'aperçu,
// fabriqué par apercu.js (HTML du texte neutralisé), est inséré en HTML.
// =============================================================================

import { SUJETS, pageDuSujet } from './config.js?v=10';
import { createClient } from './github.js?v=10';
import { checkSynthese, citedUrls, lastSynthesisDate, parseSyntheses, serializeSyntheses, setSources } from './syntheses.js?v=10';
import { renderPreview } from './apercu.js?v=10';
import { forgetVisitsKey, showVisits } from './visites.js?v=10';

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
  newsShown: 8, // nombre d'actualités affichées (« Voir les plus anciennes » en ajoute)
  lastDates: {}, // date de la dernière synthèse de chaque sujet (AAAA-MM-JJ ou null)
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
  $('dashboard').hidden = true;
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
  $('dashboard').hidden = false;
  $('bar-links').hidden = false;
  renderSujets();
  applyFile(data);
  if (!state.editing && !$('texte').value) startNew();
  loadNews();
  refreshRegularity();
  showVisits();
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

// Lit les synthèses de tous les sujets (en arrière-plan, sans bloquer la page)
async function refreshRegularity() {
  const client = state.client;
  await Promise.all(
    SUJETS.map(async ({ id }) => {
      try {
        state.lastDates[id] = lastSynthesisDate(parseSyntheses((await client.readFile(id)).source).syntheses);
      } catch {
        // sujet illisible : pas d'indication, sans gêner le reste
      }
    }),
  );
  renderAges();
}

// Au clavier : ← et → passent d'un sujet à l'autre
$('sujets').addEventListener('keydown', (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const index = SUJETS.findIndex((s) => s.id === state.sujet);
  openSujet(SUJETS[(index + step + SUJETS.length) % SUJETS.length].id, { focus: true });
});

async function openSujet(id, { focus = false } = {}) {
  if (id === state.sujet || state.busy) return;
  if (isDirty() && !confirm('Des modifications ne sont pas enregistrées. Changer de sujet quand même ?')) return;
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
      excerpt.textContent = plainText(synthese.texte).slice(0, 160);

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
  syncNewsChecks();
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
  if ((event.metaKey || event.ctrlKey) && event.key === 's' && !$('dashboard').hidden) {
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

// --- Actualités du sujet : sources de la synthèse, et « Hors sujet » ----------------------

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
  // Les plus récentes d'abord, comme sur le site
  const items = [...data.actualites].sort((a, b) => b.date.localeCompare(a.date) || a.titre.localeCompare(b.titre, 'fr'));
  state.news = { data, version, items };
  renderNews();
}

function renderNews() {
  const { items } = state.news;
  const cited = citedUrls($('texte').value);
  $('news-empty').hidden = items.length > 0;
  $('news-list').replaceChildren(
    ...items.slice(0, state.newsShown).map((item) => {
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

      const meta = document.createElement('p');
      meta.className = 'news-meta';
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'lire ↗';
      meta.append(`${formatDay(item.date)} · ${item.source} · `, link);

      li.append(label, meta, button('Hors sujet', () => discardNews(item), `Retirer « ${item.titre} » de la veille`, 'tui-btn tui-btn--small danger'));
      return li;
    }),
  );
  const rest = items.length - state.newsShown;
  $('news-more').hidden = rest <= 0;
  $('news-more').textContent = `Voir les ${rest} plus ancienne${rest > 1 ? 's' : ''}`;
}

$('news-more').addEventListener('click', () => {
  state.newsShown = state.news.items.length;
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

// « Hors sujet » : l'actualité est retirée du fichier du sujet (un commit, le
// site se republie) et son adresse est notée dans « ecartees » : la collecte
// du lundi ne la reproposera pas.
async function discardNews(item) {
  if (state.busy) return;
  const nom = SUJETS.find((s) => s.id === state.sujet).nom;
  if (!confirm(`Retirer « ${item.titre} » de la veille ${nom} ? Elle disparaîtra du site et ne sera plus proposée.`)) return;
  await run("Retrait de l'actualité…", async () => {
    const { data, version } = await state.client.readNews(state.sujet);
    const actualites = data.actualites.filter((a) => a.url !== item.url);
    const next = { ...data, actualites, ecartees: [...new Set([...(data.ecartees ?? []), item.url])] };
    let saved;
    try {
      saved = await state.client.writeNews(state.sujet, next, version, `veille(${state.sujet}): actualité « ${item.titre} » retirée (hors sujet)`);
    } catch (error) {
      if (error.status !== 409) throw error;
      await loadNews();
      throw new Error("Le fichier des actualités a changé entre-temps (collecte du lundi ?) : la liste vient d'être rechargée, recommencez.");
    }
    setNews(next, saved.version);
    // Si elle était citée, son lien quitte aussi le bloc « Sources »
    const area = $('texte');
    if (citedUrls(area.value).has(item.url)) {
      const cited = citedUrls(area.value);
      cited.delete(item.url);
      area.value = setSources(area.value, state.news.items.filter((a) => cited.has(a.url)), formatDay);
      refreshPreview();
    }
    setStatus('Actualité retirée. Le site sera à jour dans 2 à 3 minutes.', 'ok', null, saved.commit);
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
