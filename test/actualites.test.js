// Actualités d'un sujet (actualites.js) : `npm test`

import assert from 'node:assert/strict';
import test from 'node:test';
import { discard, restore, usage } from '../actualites.js';

const A = { id: 'a', date: '2026-10-08', titre: 'A', source: 'S', url: 'https://ex.fr/a', resume: 'r', tags: ['t'] };
const B = { id: 'b', date: '2026-10-06', titre: 'B', source: 'S', url: 'https://ex.fr/b', resume: 'r', tags: ['t'] };
const C = { id: 'c', date: '2026-10-06', titre: 'C', source: 'S', url: 'https://ex.fr/c', resume: 'r', tags: ['t'] };
const DATA = { miseAJour: '2026-10-09', actualites: [A, B] };

test('hors sujet puis remettre : l’actualité revient à sa place, sans trace', () => {
  const discarded = discard(DATA, B.url, '2026-10-10');
  assert.deepEqual(discarded.actualites, [A]);
  assert.deepEqual(discarded.horsSujet, [{ ...B, ecarteLe: '2026-10-10' }]);
  assert.equal(DATA.actualites.length, 2, 'l’objet de départ n’est pas modifié');

  const restored = restore(discarded, B.url);
  assert.deepEqual(restored, DATA, 'remise à sa place, liste horsSujet vide retirée');
  assert.equal(discard(DATA, 'https://ex.fr/inconnue', '2026-10-10'), null);
  assert.equal(restore(DATA, B.url), null);
});

test('actualités utilisées : citées dans une synthèse publiée, avec ses titres', () => {
  const used = usage([
    { titre: 'S1', texte: 'Texte.\n\n**Sources**\n\n- [A](https://ex.fr/a) (S, 8 octobre 2026)' },
    { titre: 'S2', texte: 'Voir [cet article](https://ex.fr/a) et [celui-ci](https://ex.fr/b).' },
  ]);
  assert.deepEqual(used.get(A.url), ['S1', 'S2']);
  assert.deepEqual(used.get(B.url), ['S2']);
});

test('remettre : réinsérée à sa date, sans déplacer les autres actualités', () => {
  const data = { miseAJour: 'x', actualites: [A, C], horsSujet: [{ ...B, ecarteLe: '2026-10-10' }] };
  assert.deepEqual(restore(data, B.url).actualites.map((a) => a.id), ['a', 'c', 'b']);
  const late = { miseAJour: 'x', actualites: [B, C], horsSujet: [{ ...A, ecarteLe: '2026-10-10' }] };
  assert.deepEqual(restore(late, A.url).actualites.map((a) => a.id), ['a', 'b', 'c']);
});
