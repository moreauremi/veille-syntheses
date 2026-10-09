// Statistiques de visites (stats.js), contre une fausse API GoatCounter : `npm test`

import assert from 'node:assert/strict';
import test from 'node:test';
import { byWeek, chartGeometry, createStatsClient, lastDays, niceMax } from '../stats.js';

const TODAY = new Date('2026-10-09T15:30:00Z');

function fakeGoatCounter({ status = 200 } = {}) {
  const calls = [];
  const json = (data, code = 200) => new Response(JSON.stringify(data), { status: code, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, { headers }) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: headers.Authorization });
    if (status !== 200) return json({ error: 'non' }, status);
    if (u.pathname === '/api/v0/stats/total') {
      return json({ total: 11, total_events: 2, stats: [{ day: '2026-10-07', daily: 4 }, { day: '2026-10-09', daily: 5 }, { day: '2026-10-10', daily: 0 }] });
    }
    if (u.pathname === '/api/v0/stats/toprefs') return json({ stats: [{ name: 'linkedin.com', count: 3 }, { name: '', count: 2 }] });
    return json({ hits: [{ path: '/veille', count: 6 }, { path: 'clic', count: 2, event: true }, { path: '/', count: 3 }] });
  };
  return { fetch, calls };
}

test('jours : les 30 derniers, aujourd’hui compris, du plus ancien au plus récent', () => {
  const days = lastDays(TODAY, 30);
  assert.equal(days.length, 30);
  assert.equal(days[0], '2026-09-10');
  assert.equal(days.at(-1), '2026-10-09');
});

test('graduation ronde au-dessus du maximum', () => {
  assert.deepEqual([0, 1, 3, 12, 50, 51, 180].map(niceMax), [1, 1, 5, 20, 50, 100, 200]);
});

test('graphique : colonnes de 24 px au plus, 2 px d’écart, hauteur proportionnelle', () => {
  const days = [{ day: 'a', count: 0 }, { day: 'b', count: 5 }, { day: 'c', count: 10 }];
  const { max, bars } = chartGeometry(days, { width: 328, height: 100, left: 28 });
  assert.equal(max, 10);
  assert.ok(bars.every((b) => b.width <= 24));
  assert.deepEqual(bars.map((b) => b.height), [0, 50, 100]);
  for (let i = 1; i < bars.length; i++) assert.ok(bars[i].x - (bars[i - 1].x + bars[i - 1].width) >= 2, 'écart entre deux colonnes');
  const many = chartGeometry(lastDays(TODAY, 30).map((day) => ({ day, count: 1 })), { width: 328, height: 100, left: 28 });
  assert.ok(many.bars.every((b, i, all) => i === 0 || b.x - (all[i - 1].x + all[i - 1].width) >= 1.99));
});

test('chargement : bonne période, clé envoyée, jours sans visite à 0, pages sans les événements', async () => {
  const gc = fakeGoatCounter();
  const stats = await createStatsClient('cle', { fetch: gc.fetch, today: TODAY, gap: 0, retryDelay: 0 }).load(30);
  assert.deepEqual(gc.calls.map((c) => c.path).sort(), ['/api/v0/stats/hits', '/api/v0/stats/toprefs', '/api/v0/stats/total']);
  assert.ok(gc.calls.every((c) => c.auth === 'Bearer cle'));
  assert.deepEqual([gc.calls[0].params.start, gc.calls[0].params.end], ['2026-09-10T00:00:00Z', '2026-10-10T00:00:00Z']);
  assert.equal(stats.days.length, 30);
  assert.equal(stats.days.find((d) => d.day === '2026-10-08').count, 0);
  assert.equal(stats.total, 9);
  assert.equal(stats.today, 5);
  assert.deepEqual(stats.pages, [{ path: '/veille', count: 6 }, { path: '/', count: 3 }]);
  assert.deepEqual(stats.refs, [{ name: 'linkedin.com', count: 3 }, { name: '', count: 2 }]);
  assert.equal(stats.bars, stats.days, '30 jours : une colonne par jour');
});

test('clé refusée ou sans permission : message qui dit quoi faire', async () => {
  for (const [status, pattern] of [[401, /refusée/], [403, /permission/]]) {
    const gc = fakeGoatCounter({ status });
    await assert.rejects(createStatsClient('cle', { fetch: gc.fetch, today: TODAY, gap: 0, retryDelay: 0 }).load(), (error) => error.status === status && pattern.test(error.message));
  }
});

test('90 jours : une colonne par semaine, la dernière finissant aujourd’hui', () => {
  const series = lastDays(TODAY, 90).map((day) => ({ day, count: 1 }));
  const weeks = byWeek(series);
  assert.equal(weeks.length, 13);
  assert.deepEqual(weeks.at(-1), { day: '2026-10-03', end: '2026-10-09', count: 7 });
  assert.equal(weeks[0].count, 6, 'la plus ancienne est incomplète');
  assert.equal(weeks.reduce((sum, w) => sum + w.count, 0), 90);
});

test('limite de GoatCounter : requêtes espacées, nouvel essai après un refus ou une erreur réseau', async () => {
  const times = [];
  let calls = 0;
  const fetch = async (url) => {
    times.push(Date.now());
    calls += 1;
    if (calls === 1) throw new TypeError('NetworkError when attempting to fetch resource.');
    if (calls === 2) return new Response('{}', { status: 429 });
    const u = new URL(url);
    const body = u.pathname.endsWith('/total') ? { total: 1, stats: [] } : u.pathname.endsWith('/toprefs') ? { stats: [] } : { hits: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const stats = await createStatsClient('cle', { fetch, today: TODAY, gap: 40, retryDelay: 0 }).load(7);
  assert.equal(stats.total, 1, 'chargé malgré une erreur réseau puis un 429');
  assert.equal(calls, 5, '3 requêtes + 2 nouveaux essais');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 35, 'requêtes espacées');
});
