// =============================================================================
// Boîte « Visites du site » : période (7, 30 ou 90 jours), chiffres clés,
// graphique, tableau des chiffres, pages les plus vues et provenance des
// visiteurs (données : stats.js)
// -----------------------------------------------------------------------------
// Le graphique est un SVG construit élément par élément : les textes (dates,
// adresses des pages) passent par textContent, jamais par du HTML. Chaque jour
// a sa zone de survol (toute la hauteur) et se lit aussi au clavier ; tous les
// chiffres restent lisibles sans survol, dans le tableau « Voir les chiffres ».
// =============================================================================

import { GOATCOUNTER } from './config.js?v=16';
import { chartGeometry, createStatsClient } from './stats.js?v=16';

const $ = (id) => document.getElementById(id);
const KEY_STORAGE = 'syntheses-goatcounter';
const PERIOD_STORAGE = 'syntheses-visites-periode';
const PERIODS = [7, 30, 90]; // 90 jours : une colonne par semaine
const PLOT_HEIGHT = 120; // hauteur des colonnes ; la bande des dates s'ajoute en dessous
const TOP = 16; // marge au-dessus des colonnes, pour l'étiquette du jour le plus fort
const AXIS_HEIGHT = 22;
const LEFT = 28; // place des graduations de l'axe vertical
const SVG_NS = 'http://www.w3.org/2000/svg';

const dayLabel = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const shortLabel = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const number = new Intl.NumberFormat('fr-FR');
const asDate = (day) => new Date(`${day}T00:00:00Z`);

let data = null; // dernières statistiques chargées, pour redessiner à la bonne largeur
let period = storedPeriod();
let loading = null; // chargement en cours (AbortController), abandonné si on en lance un autre

function storedPeriod() {
  try {
    const value = Number(localStorage.getItem(PERIOD_STORAGE));
    return PERIODS.includes(value) ? value : 30;
  } catch {
    return 30;
  }
}

const weekly = () => period > 31;

// Libellé d'une colonne : un jour, ou une semaine (« du 3 au 9 oct. »)
function barLabel(bar) {
  if (!bar.end) return dayLabel.format(asDate(bar.day));
  return `du ${shortLabel.format(asDate(bar.day))} au ${shortLabel.format(asDate(bar.end))}`;
}

function storedKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

// À l'ouverture du tableau de bord
export function showVisits() {
  if (storedKey()) loadVisits();
  else showKeyForm();
}

// « Se déconnecter » efface aussi la clé GoatCounter
export function forgetVisitsKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    // rien à effacer
  }
  data = null;
}

function showKeyForm(message = '') {
  $('visits-form').hidden = false;
  $('visits-content').hidden = true;
  $('visits-actions').hidden = true;
  $('visits-status').textContent = message;
}

$('visits-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const key = $('visits-key').value.trim();
  if (!key) return;
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // stockage indisponible : la clé vaut jusqu'au rechargement
  }
  $('visits-key').value = '';
  loadVisits(key);
});

$('visits-refresh').addEventListener('click', () => loadVisits());

// Choix de la période : boutons à bascule, un seul enfoncé
function renderPeriods() {
  for (const button of $('visits-periods').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.period) === period));
  }
}

$('visits-periods').addEventListener('click', (event) => {
  const value = Number(event.target.closest('button')?.dataset.period);
  if (!PERIODS.includes(value) || value === period) return;
  period = value;
  try {
    localStorage.setItem(PERIOD_STORAGE, String(value));
  } catch {
    // stockage indisponible : le choix vaut jusqu'au rechargement
  }
  renderPeriods();
  loadVisits();
});

$('visits-forget').addEventListener('click', () => {
  forgetVisitsKey();
  showKeyForm();
});

async function loadVisits(key = storedKey()) {
  $('visits-form').hidden = true;
  $('visits-content').hidden = false;
  $('visits-actions').hidden = false;
  $('visits-error').textContent = '';
  $('visits-error').className = 'status';
  // Pendant le chargement, l'ancien graphique reste affiché, atténué
  $('visits-content').classList.add('loading');
  loading?.abort();
  const controller = new AbortController();
  loading = controller;
  try {
    renderPeriods();
    renderLabels();
    const loaded = await createStatsClient(key).load(period, { signal: controller.signal });
    if (controller.signal.aborted) return;
    data = loaded;
    render();
    $('visits-updated').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`;
  } catch (error) {
    if (error.name === 'AbortError') return; // remplacé par un chargement plus récent
    // Clé refusée : on la redemande ; autre erreur (réseau, GoatCounter…) :
    // message bien visible, la clé est gardée
    if (error.status === 401 || error.status === 403) {
      forgetVisitsKey();
      showKeyForm(error.message);
    } else {
      $('visits-error').className = 'status err';
      $('visits-error').textContent = `Visites indisponibles : ${error.message}`;
    }
  } finally {
    // Seul le chargement le plus récent retire l'indication « en cours »
    if (loading === controller) {
      loading = null;
      $('visits-content').classList.remove('loading');
    }
  }
}

// Titres qui dépendent de la période : mis à jour dès qu'elle change, avant
// même l'arrivée des chiffres
function renderLabels() {
  $('visits-total-label').textContent = `Visiteurs, ${period} derniers jours`;
  $('visits-pages-title').textContent = `Pages les plus vues (${period} jours)`;
  $('visits-refs-title').textContent = `Provenance (${period} jours)`;
  $('visits-table-head').textContent = weekly() ? 'Semaine' : 'Jour';
}

function render() {
  renderLabels();
  $('visits-total').textContent = number.format(data.total);
  $('visits-today').textContent = number.format(data.today);
  renderChart();
  renderTable();
  renderPages();
  renderRefs();
}

// --- Graphique ---------------------------------------------------------------------

function svg(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

// Colonne aux angles du haut arrondis (4 px), carrée sur la ligne de base
function columnPath({ x, y, width, height }) {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function renderChart() {
  const chart = $('visits-chart');
  const width = Math.max(200, Math.floor(chart.clientWidth));
  const { max, bars } = chartGeometry(data.bars, { width, height: PLOT_HEIGHT, left: LEFT });
  const total = TOP + PLOT_HEIGHT + AXIS_HEIGHT;
  const root = svg('svg', { width, height: total, viewBox: `0 0 ${width} ${total}`, role: 'group' });
  root.setAttribute('aria-label', `Visiteurs par ${weekly() ? 'semaine' : 'jour'}, ${period} derniers jours`);
  // Zone du graphique, sous une marge qui laisse la place à l'étiquette du
  // jour le plus fort, même quand sa colonne atteint la graduation du haut
  const plot = svg('g', { transform: `translate(0,${TOP})` });
  root.append(plot);

  // Graduations : 0 et le maximum « rond », en lignes fines discrètes
  for (const value of [0, max]) {
    const y = PLOT_HEIGHT - (value / max) * PLOT_HEIGHT + 0.5;
    plot.append(svg('line', { x1: LEFT, x2: width, y1: y, y2: y, class: 'grid' }));
    const label = svg('text', { x: LEFT - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' });
    label.textContent = number.format(value);
    plot.append(label);
  }

  // Dates : début, milieu, aujourd'hui (ou cette semaine)
  for (const [index, anchor] of [[0, 'start'], [Math.floor(bars.length / 2), 'middle'], [bars.length - 1, 'end']]) {
    const bar = bars[index];
    const x = anchor === 'start' ? bar.slot.x : anchor === 'end' ? bar.slot.x + bar.slot.width : bar.x + bar.width / 2;
    const label = svg('text', { x, y: PLOT_HEIGHT + 16, 'text-anchor': anchor, class: 'tick' });
    label.textContent = index === bars.length - 1 ? (weekly() ? 'cette semaine' : "aujourd'hui") : shortLabel.format(asDate(bar.day));
    plot.append(label);
  }

  // Colonnes, et une zone de survol (et de focus clavier) par jour
  const peak = bars.reduce((best, bar) => (bar.count > best.count ? bar : best), bars[0]);
  for (const bar of bars) {
    const group = svg('g', { class: 'day', tabindex: 0, role: 'img' });
    group.setAttribute('aria-label', `${barLabel(bar)} : ${bar.count} visiteur${bar.count > 1 ? 's' : ''}`);
    group.append(svg('rect', { x: bar.slot.x, y: 0, width: bar.slot.width, height: PLOT_HEIGHT, class: 'hit' }));
    if (bar.count > 0) group.append(svg('path', { d: columnPath(bar), class: 'column' }));
    for (const type of ['pointerenter', 'focus']) group.addEventListener(type, () => showTooltip(bar));
    for (const type of ['pointerleave', 'blur']) group.addEventListener(type, hideTooltip);
    plot.append(group);
  }

  // Étiquette directe, une seule : la valeur du jour le plus fort
  if (peak.count > 0) {
    const label = svg('text', { x: peak.x + peak.width / 2, y: peak.y - 5, 'text-anchor': 'middle', class: 'peak' });
    label.textContent = number.format(peak.count);
    plot.append(label);
  }

  chart.replaceChildren(root, $('visits-tooltip'));
}

function showTooltip(bar) {
  const tooltip = $('visits-tooltip');
  const value = document.createElement('strong');
  value.textContent = `${number.format(bar.count)} visiteur${bar.count > 1 ? 's' : ''}`;
  const day = document.createElement('span');
  day.textContent = barLabel(bar);
  tooltip.replaceChildren(value, day);
  tooltip.hidden = false;
  // Au-dessus de la colonne, sans sortir du graphique
  const chartWidth = $('visits-chart').clientWidth;
  const center = bar.slot.x + bar.slot.width / 2;
  const left = Math.min(Math.max(center - tooltip.offsetWidth / 2, 0), chartWidth - tooltip.offsetWidth);
  tooltip.style.left = `${left}px`;
}

function hideTooltip() {
  $('visits-tooltip').hidden = true;
}

// --- Tableau des chiffres et pages les plus vues -------------------------------------

function renderTable() {
  $('visits-table-body').replaceChildren(
    ...[...data.bars].reverse().map((d) => {
      const row = document.createElement('tr');
      const day = document.createElement('td');
      day.textContent = barLabel(d);
      const count = document.createElement('td');
      count.textContent = number.format(d.count);
      row.append(day, count);
      return row;
    }),
  );
}

function renderPages() {
  $('visits-pages-empty').hidden = data.pages.length > 0;
  $('visits-pages').replaceChildren(
    ...data.pages.map((page) => {
      const item = document.createElement('li');
      const path = document.createElement('span');
      path.className = 'page-path';
      path.textContent = page.path;
      const count = document.createElement('span');
      count.className = 'page-count';
      count.textContent = number.format(page.count);
      item.append(path, count);
      return item;
    }),
  );
  $('visits-link').href = GOATCOUNTER;
}

// Provenance : moteur de recherche, réseau social, site… ; nom vide = arrivée
// directe (adresse tapée, favori, lien dans un e-mail ou un document)
function renderRefs() {
  $('visits-refs-empty').hidden = data.refs.length > 0 && !data.refsError;
  $('visits-refs-empty').textContent = data.refsError ? `Provenance indisponible : ${data.refsError}` : 'Aucune visite pour l\'instant.';
  $('visits-refs').replaceChildren(
    ...data.refs.map((ref) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'page-path';
      name.textContent = ref.name || 'Accès direct';
      const count = document.createElement('span');
      count.className = 'page-count';
      count.textContent = number.format(ref.count);
      item.append(name, count);
      return item;
    }),
  );
}

// Largeur du graphique changée (fenêtre, téléphone tourné, vue d'ensemble
// affichée après avoir été masquée) : graphique redessiné à la bonne largeur
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const width = Math.floor(entry.contentRect.width);
  if (!data || width === 0 || width === lastWidth) return;
  lastWidth = width;
  renderChart();
}).observe($('visits-chart'));
