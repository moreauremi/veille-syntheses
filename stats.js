// =============================================================================
// Statistiques de visites du site, lues dans GoatCounter
// -----------------------------------------------------------------------------
// Le site compte chaque écran consulté (src/utils/audience.js, dans le dépôt
// du site). Cette page lit les totaux avec l'API de GoatCounter, directement
// depuis le navigateur (elle l'autorise), avec une clé d'API en lecture seule
// saisie dans la page. Aucune donnée personnelle : seulement des totaux.
//
// Ce module ne touche pas à la page : il récupère les chiffres et calcule la
// géométrie du graphique (testée sans navigateur, voir test/stats.test.js).
// =============================================================================

import { GOATCOUNTER } from './config.js?v=16';

const DAY = 24 * 60 * 60 * 1000;

// GoatCounter accepte 4 requêtes par seconde, et chaque requête du navigateur
// compte double : elle est précédée d'une vérification CORS (en-tête
// Authorization). Au-delà, il répond « 429 », que le navigateur présente comme
// une erreur réseau. Les requêtes passent donc par une file unique pour toute
// la page : l'une après l'autre, espacées, et retentées après 1 s en cas de
// refus. Une requête d'un chargement abandonné (période changée entre-temps)
// sort de la file sans être envoyée ni retarder les suivantes.
const GAP = 700;
const RETRY_DELAY = 1100;
let queue = Promise.resolve();
let lastSent = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abortError = () => new DOMException('Chargement abandonné', 'AbortError');

function inQueue(task, gap, signal) {
  const run = queue.then(async () => {
    if (signal?.aborted) throw abortError();
    const wait = lastSent + gap - Date.now();
    if (wait > 0) await sleep(wait);
    if (signal?.aborted) throw abortError();
    lastSent = Date.now();
    return task();
  });
  queue = run.catch(() => {});
  return run;
}

export class StatsError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.status = status;
  }
}

//   key   : clé d'API GoatCounter (permission « lire les statistiques »)
//   today : date du jour (remplaçable dans les tests)
//   gap, retryDelay : espacement des requêtes et attente avant un nouvel essai (ms)
export function createStatsClient(key, { fetch = globalThis.fetch.bind(globalThis), today = new Date(), gap = GAP, retryDelay = RETRY_DELAY } = {}) {
  async function request(path, params, signal, attempt = 1) {
    let response;
    try {
      response = await inQueue(
        () => fetch(`${GOATCOUNTER}/api/v0/${path}?${new URLSearchParams(params)}`, {
          headers: { Authorization: `Bearer ${key}` },
          cache: 'no-store',
        }),
        gap,
        signal,
      );
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      // Erreur réseau : le plus souvent la limite de requêtes de GoatCounter
      if (attempt < 3) {
        await sleep(retryDelay);
        return request(path, params, signal, attempt + 1);
      }
      throw new StatsError(0, 'GoatCounter ne répond pas (réseau, ou trop de requêtes) : réessayez dans un instant.', { cause: error });
    }
    if (response.status === 429 && attempt < 3) {
      await sleep(retryDelay);
      return request(path, params, signal, attempt + 1);
    }
    if (!response.ok) throw await toError(response);
    return response.json();
  }

  return {
    // Les `days` derniers jours, aujourd'hui compris → { days: [{ day, count }],
    // bars (par jour, ou par semaine au-delà de 31 jours), total, today,
    // pages: [{ path, count }], refs: [{ name, count }] (provenance des
    // visiteurs ; nom vide = sans site d'origine), refsError (message si la
    // provenance n'a pas pu être lue : le reste s'affiche quand même).
    // Les jours sans visite valent 0.
    // `signal` : AbortSignal, pour abandonner le chargement (période changée)
    async load(days = 30, { signal } = {}) {
      const list = lastDays(today, days);
      // Heures pleines, en UTC : du premier jour 0 h au lendemain du dernier 0 h
      const range = {
        start: `${list[0]}T00:00:00Z`,
        end: `${isoDay(new Date(Date.parse(`${list.at(-1)}T00:00:00Z`) + DAY))}T00:00:00Z`,
      };
      const [totals, hits, refs] = await Promise.all([
        request('stats/total', range, signal),
        request('stats/hits', { ...range, limit: '5' }, signal),
        request('stats/toprefs', { ...range, limit: '6' }, signal).catch((error) => {
          if (error.name === 'AbortError') throw error;
          return { error };
        }),
      ]);
      const byDay = new Map((totals.stats ?? []).map((s) => [s.day, s.daily ?? 0]));
      const series = list.map((day) => ({ day, count: byDay.get(day) ?? 0 }));
      return {
        days: series,
        bars: days > 31 ? byWeek(series) : series,
        // Le total de GoatCounter (le même que sur son site), sans les événements
        total: Number.isInteger(totals.total)
          ? totals.total - (totals.total_events ?? 0)
          : series.reduce((sum, d) => sum + d.count, 0),
        today: series.at(-1).count,
        pages: (hits.hits ?? []).filter((h) => !h.event).map((h) => ({ path: h.path, count: h.count ?? 0 })),
        refs: (refs.stats ?? []).map((r) => ({ name: r.name ?? '', count: r.count ?? 0 })),
        refsError: refs.error?.message ?? null,
      };
    },
  };
}

async function toError(response) {
  const detail = await response
    .json()
    .then((data) => data.error ?? data.errors ?? '')
    .catch(() => '');
  const messages = {
    401: 'Clé GoatCounter refusée : vérifiez-la, ou créez-en une nouvelle.',
    403: 'Cette clé GoatCounter ne peut pas lire les statistiques : cochez la permission correspondante en la créant.',
    429: 'Trop de requêtes vers GoatCounter : réessayez dans quelques secondes.',
  };
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return new StatsError(response.status, messages[response.status] ?? `GoatCounter a répondu ${response.status}${text ? ` : ${text}` : ''}.`);
}

// Les `count` derniers jours (AAAA-MM-JJ, en UTC), du plus ancien à aujourd'hui
export function lastDays(today, count) {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: count }, (_, i) => isoDay(new Date(end - (count - 1 - i) * DAY)));
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// Jours → semaines, en partant d'aujourd'hui : chaque semaine finit le jour de
// la semaine d'aujourd'hui (la plus ancienne peut être incomplète).
// { day: premier jour, end: dernier jour, count: total }
export function byWeek(series) {
  const weeks = [];
  for (let end = series.length; end > 0; end -= 7) {
    const chunk = series.slice(Math.max(0, end - 7), end);
    weeks.unshift({ day: chunk[0].day, end: chunk.at(-1).day, count: chunk.reduce((sum, d) => sum + d.count, 0) });
  }
  return weeks;
}

// Graduation « ronde » au-dessus du maximum : 1, 2, 5, 10, 20, 50…
export function niceMax(max) {
  if (max <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((step) => step * power).find((value) => value >= max);
}

// Géométrie du graphique en colonnes, en pixels, pour une largeur donnée :
// une colonne par jour, 24 px au plus, 2 px d'écart entre deux colonnes, qui
// partent toutes de la ligne de base. `slot` : zone de survol de chaque jour
// (toute la hauteur, toute la largeur de la case : plus grande que la colonne).
export function chartGeometry(days, { width, height, left = 0 }) {
  const max = niceMax(Math.max(0, ...days.map((d) => d.count)));
  const plot = width - left;
  const step = plot / days.length;
  const barWidth = Math.max(1, Math.min(24, step - 2));
  return {
    max,
    bars: days.map((d, i) => {
      const h = (d.count / max) * height;
      const x = left + i * step + (step - barWidth) / 2;
      return { ...d, x, y: height - h, width: barWidth, height: h, slot: { x: left + i * step, width: step } };
    }),
  };
}
