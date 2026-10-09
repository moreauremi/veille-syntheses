// =============================================================================
// Tableau de bord des synthèses : comportement de la page
// -----------------------------------------------------------------------------
// Les textes saisis sont toujours affichés avec textContent ; seul l'aperçu,
// fabriqué par apercu.js (HTML du texte neutralisé), est inséré en HTML.
// =============================================================================

import { SITE } from './config.js';
import { createClient } from './github.js';
import { checkSynthese, parseSyntheses, serializeSyntheses } from './syntheses.js';
import { renderPreview } from './apercu.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'syntheses-jeton';
const CONFLICT =
  "Le fichier des synthèses a changé entre-temps (depuis VS Code ou un autre onglet). La liste vient d'être rechargée : vérifiez-la, votre texte est conservé, puis enregistrez à nouveau.";

const state = {
  client: null,
  version: null, // empreinte (sha) du fichier sur GitHub, à jour après chaque enregistrement
  syntheses: [],
  editing: null, // synthèse en cours de modification : { index, titre } ; null = nouvelle
  saved: { titre: '', texte: '' }, // contenu au dernier chargement ou enregistrement
  busy: false,
  suggestion: null, // proposition de l'IA en attente : { start, end, texte }
};

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

// Le jeton est vérifié en lisant le fichier des synthèses
async function connect(token) {
  const client = createClient(token);
  const data = await client.readFile();
  state.client = client;
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('bar-links').hidden = false;
  $('site-link').href = SITE;
  applyFile(data);
  if (!state.editing && !$('texte').value) startNew();
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
  applyFile(await state.client.readFile());
}

function renderList() {
  $('list').replaceChildren(
    ...state.syntheses.map((synthese, index) => {
      const item = document.createElement('li');
      item.className = state.editing?.index === index ? 'item current' : 'item';

      const title = document.createElement('p');
      title.className = 'item-title';
      title.textContent = synthese.titre;

      const excerpt = document.createElement('p');
      excerpt.className = 'item-excerpt';
      excerpt.textContent = plainText(synthese.texte).slice(0, 160);

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.append(
        button('Modifier', () => edit(index), `Modifier « ${synthese.titre} »`),
        button('Supprimer', () => remove(index), `Supprimer « ${synthese.titre} »`, 'danger'),
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

function currentMonthTitle() {
  const month = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date());
  return `${month[0].toUpperCase()}${month.slice(1)} : `;
}

function fillEditor(titre, texte) {
  hideSuggestion();
  $('titre').value = titre;
  $('texte').value = texte;
  state.saved = { titre, texte };
  setStatus('');
  refreshPreview();
}

function startNew() {
  state.editing = null;
  fillEditor('', '');
  $('titre').value = currentMonthTitle(); // pré-rempli, pas une modification
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
  $('save').textContent = state.editing ? 'Enregistrer et publier' : 'Publier';
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
  const current = await state.client.readFile();
  if (current.version !== state.version) throw Object.assign(new Error(CONFLICT), { status: 409 });
  const doc = parseSyntheses(current.source);
  const message = edit(doc.syntheses);
  const saved = await state.client.writeFile(serializeSyntheses(doc), current.version, message);
  return { version: saved.version, commit: saved.commit, syntheses: doc.syntheses };
}

function checkIndex(syntheses, index) {
  if (index >= syntheses.length) throw Object.assign(new Error(CONFLICT), { status: 409 });
}

async function save() {
  if (state.busy) return;
  if (state.suggestion) return setStatus("Choisissez d'abord : remplacer par la proposition de l'IA, ou garder votre texte.", 'err');
  if ($('titre').value.trim() === currentMonthTitle().trim()) return setStatus('Complétez le titre de la synthèse.', 'err', $('titre'));
  const checked = checkSynthese({ titre: $('titre').value, texte: $('texte').value });
  if (checked.errors) return setStatus(`Impossible d'enregistrer : ${checked.errors.join(' ; ')}.`, 'err');
  const synthese = checked.synthese;

  await run('Publication en cours…', async () => {
    const index = state.editing?.index;
    const data = await commit((syntheses) => {
      if (index === undefined) {
        syntheses.unshift(synthese);
        return `veille: nouvelle synthèse « ${synthese.titre} »`;
      }
      checkIndex(syntheses, index);
      syntheses[index] = synthese;
      return `veille: synthèse « ${synthese.titre} » modifiée`;
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
      return `veille: synthèse « ${removed.titre} » supprimée`;
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
  const waiting = "GitHub prépare une machine pour l'IA, environ une minute";
  await run(`Reformulation en cours… (${waiting})`, async () => {
    const texte = await state.client.rephrase(passage.trim(), (seconds) => {
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
  $('preview-toggle').textContent = open ? "Masquer l'aperçu" : 'Aperçu';
  refreshPreview();
});

for (const field of ['titre', 'texte']) {
  $(field).addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 200);
  });
}

function refreshPreview() {
  if (!$('preview').hidden) $('preview-content').innerHTML = renderPreview($('titre').value, $('texte').value);
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
