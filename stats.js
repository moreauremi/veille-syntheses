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

import { GOATCOUNTER } from './config.js?v=7';

const DAY = 24 * 60 * 60 * 1000;

export class StatsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

//   key   : clé d'API GoatCounter (permission « lire les statistiques »)
//   today : date du jour (remplaçable dans les tests)
export function createStatsClient(key, { fetch = globalThis.fetch.bind(globalThis), today = new Date() } = {}) {
  async function request(path, params) {
    const response = await fetch(`${GOATCOUNTER}/api/v0/${path}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw await toError(response);
    return response.json();
  }

  return {
    // Les `days` derniers jours, aujourd'hui compris → { days: [{ day, count }],
    // total, today, pages: [{ path, count }] }. Les jours sans visite valent 0.
    async load(days = 30) {
      const list = lastDays(today, days);
      // Heures pleines, en UTC : du premier jour 0 h au lendemain du dernier 0 h
      const range = {
        start: `${list[0]}T00:00:00Z`,
        end: `${isoDay(new Date(Date.parse(`${list.at(-1)}T00:00:00Z`) + DAY))}T00:00:00Z`,
      };
      const [totals, hits] = await Promise.all([
        request('stats/total', range),
        request('stats/hits', { ...range, limit: '5' }),
      ]);
      const byDay = new Map((totals.stats ?? []).map((s) => [s.day, s.daily ?? 0]));
      const series = list.map((day) => ({ day, count: byDay.get(day) ?? 0 }));
      return {
        days: series,
        // Le total de GoatCounter (le même que sur son site), sans les événements
        total: Number.isInteger(totals.total)
          ? totals.total - (totals.total_events ?? 0)
          : series.reduce((sum, d) => sum + d.count, 0),
        today: series.at(-1).count,
        pages: (hits.hits ?? []).filter((h) => !h.event).map((h) => ({ path: h.path, count: h.count ?? 0 })),
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
