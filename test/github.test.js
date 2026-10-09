// Échanges avec GitHub (github.js), contre une fausse API GitHub en mémoire :
// `npm test`. Aucune requête ne part sur le réseau.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, fromBase64, toBase64 } from '../github.js';

const TOKEN = 'bon-jeton';

// Fausse API : le fichier des synthèses, les versions brouillons, et un
// « workflow » qui écrit sa réponse dans le brouillon au bout de `polls` lectures
function fakeGitHub({ answer = (texte) => ({ etat: 'ok', texte: `[reformulé] ${texte}` }), polls = 2 } = {}) {
  const gh = { source: 'Texte du fichier\n', sha: 'v0', commits: [], releases: new Map(), dispatches: [], deletedRuns: [] };
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const empty = () => new Response(null, { status: 204 });

  gh.fetch = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const path = new URL(url).pathname.replace('/repos/moreauremi/moreauremi.github.io', '');
    if (headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
    const data = body ? JSON.parse(body) : null;

    if (path === '/contents/content/pages/syntheses.md') {
      // GitHub renvoie le base64 coupé en lignes de 60 caractères
      if (method === 'GET') return json(200, { content: toBase64(gh.source).replace(/(.{60})/g, '$1\n'), sha: gh.sha });
      if (data.sha !== gh.sha) return json(409, { message: 'does not match' });
      gh.source = fromBase64(data.content);
      gh.sha = `v${gh.commits.push(data.message)}`;
      return json(200, { content: { sha: gh.sha }, commit: { html_url: `https://github.com/commit/${gh.sha}` } });
    }
    if (path === '/releases') {
      if (method === 'GET') return json(200, [...gh.releases.values()]);
      const release = { id: gh.releases.size + 100, ...data, created_at: new Date().toISOString(), reads: 0 };
      gh.releases.set(release.id, release);
      return json(201, release);
    }
    const release = gh.releases.get(Number(path.match(/^\/releases\/(\d+)$/)?.[1]));
    if (release && method === 'GET') {
      if (++release.reads === polls) release.body = JSON.stringify(answer(JSON.parse(release.body).texte));
      return json(200, release);
    }
    if (release && method === 'DELETE') return gh.releases.delete(release.id) && empty();
    if (path === '/actions/workflows/reformuler.yml/dispatches') return gh.dispatches.push(data) && empty();
    if (path === '/actions/workflows/reformuler.yml/runs') return json(200, { workflow_runs: [{ id: 7 }] });
    if (path === '/actions/runs/7' && method === 'DELETE') return gh.deletedRuns.push(7) && empty();
    return json(404, { message: 'Not Found' });
  };
  return gh;
}

const quick = { pollInterval: 1, rephraseTimeout: 1000 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20)); // nettoyage lancé en arrière-plan

test('base64 : accents, emoji et long texte relus à l’identique', () => {
  const text = `Synthèse « NIS 2 » : ça change tout 🔐\n${'é'.repeat(50_000)}`;
  assert.equal(fromBase64(toBase64(text)), text);
});

test('lecture puis écriture du fichier ; version périmée refusée', async () => {
  const gh = fakeGitHub();
  const client = createClient(TOKEN, { fetch: gh.fetch, ...quick });
  const file = await client.readFile();
  assert.deepEqual(file, { source: 'Texte du fichier\n', version: 'v0' });

  const saved = await client.writeFile('Nouveau texte é\n', 'v0', 'veille: test');
  assert.deepEqual(saved, { version: 'v1', commit: 'https://github.com/commit/v1' });
  assert.equal(gh.source, 'Nouveau texte é\n');

  await assert.rejects(client.writeFile('Autre', 'v0', 'veille: test'), { status: 409 });
  assert.equal(gh.commits.length, 1);
});

test('jeton refusé : erreur 401 qui dit quoi faire', async () => {
  const client = createClient('mauvais', { fetch: fakeGitHub().fetch, ...quick });
  await assert.rejects(client.readFile(), (error) => error.status === 401 && /Jeton refusé/.test(error.message));
});

test('reformulation : brouillon, workflow lancé, réponse lue, brouillon supprimé', async () => {
  const gh = fakeGitHub();
  const client = createClient(TOKEN, { fetch: gh.fetch, ...quick });
  const waits = [];
  const texte = await client.rephrase('ma phrase', (seconds) => waits.push(seconds));

  assert.equal(texte, '[reformulé] ma phrase');
  assert.equal(waits.length, 2);
  assert.deepEqual(gh.dispatches, [{ ref: 'main', inputs: { demande: '100' } }]);
  assert.equal(gh.releases.size, 0, 'brouillon supprimé');
  await settle();
  assert.deepEqual(gh.deletedRuns, [7], 'exécutions réussies supprimées');
});

test('reformulation : erreur de l’IA affichée, brouillon supprimé', async () => {
  const gh = fakeGitHub({ answer: () => ({ etat: 'erreur', message: 'quota Copilot épuisé.' }) });
  const client = createClient(TOKEN, { fetch: gh.fetch, ...quick });
  await assert.rejects(client.rephrase('ma phrase'), { status: 502, message: 'Reformulation impossible : quota Copilot épuisé.' });
  assert.equal(gh.releases.size, 0);
  await settle();
});

test('reformulation : sans réponse, abandon au bout du délai', async () => {
  const gh = fakeGitHub({ polls: Infinity });
  const client = createClient(TOKEN, { fetch: gh.fetch, pollInterval: 1, rephraseTimeout: 30 });
  await assert.rejects(client.rephrase('ma phrase'), { status: 504 });
  assert.equal(gh.releases.size, 0);
  await settle();
});
