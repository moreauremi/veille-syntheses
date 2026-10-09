// Format de content/pages/syntheses.md, et aperçu : `npm test`

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPreview } from '../apercu.js';
import { PLACEHOLDER, checkSynthese, citedUrls, lastSynthesisDate, parseSyntheses, serializeSyntheses, setSources } from '../syntheses.js';

// Copie du fichier du site, tel qu'il est sans synthèse
const SOURCE = `---
titre: Mes synthèses
---

<!--
  Onglet « Mes synthèses » de la rubrique « Veille technologique ».

  Une synthèse par titre de niveau 2, la plus récente en haut, par exemple :

  ## Octobre 2026 : NIS 2 arrive dans les PME industrielles

  Texte de la synthèse…
-->

À venir.
`;

test('relu puis réécrit à l’identique', () => {
  assert.equal(serializeSyntheses(parseSyntheses(SOURCE)), SOURCE);
  assert.deepEqual(parseSyntheses(SOURCE).syntheses, [], 'l’exemple des consignes n’est pas une synthèse');
});

test('ajout puis suppression, sans toucher à l’en-tête', () => {
  const doc = parseSyntheses(SOURCE);
  doc.syntheses.unshift({ titre: 'Octobre 2026 : un test', texte: 'Premier paragraphe.\n\n### Détail\n\nSecond.' });
  const written = serializeSyntheses(doc);
  assert.ok(!written.split('\n').includes(PLACEHOLDER), '« À venir. » disparaît');
  assert.ok(written.includes('<!--'), 'les consignes sont gardées');

  const reread = parseSyntheses(written);
  assert.deepEqual(reread.syntheses, doc.syntheses);
  reread.syntheses.splice(0, 1);
  assert.equal(serializeSyntheses(reread), SOURCE);
});

test('« ## » refusé dans le texte, « ### » et le code acceptés', () => {
  assert.ok(checkSynthese({ titre: 'Titre', texte: 'Avant\n\n## Autre\n\nAprès' }).errors);
  assert.ok(checkSynthese({ titre: 'Titre', texte: 'Avant\n\n### Sous-titre' }).synthese);
  assert.ok(checkSynthese({ titre: 'Titre', texte: '```\n## dans du code\n```' }).synthese);
  assert.ok(checkSynthese({ titre: '  ', texte: 'Texte' }).errors);
});

test('aperçu : rendu du site, sans HTML ni script interprétés', () => {
  const html = renderPreview('Titre : test', '**gras** [site](https://remim.me) [piège](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
  assert.match(html, /<h2>Titre\u00a0: test<\/h2>/);
  assert.match(html, /<strong>gras<\/strong>/);
  assert.match(html, /<a href="https:\/\/remim\.me" target="_blank" rel="noopener noreferrer">site<\/a>/);
  assert.ok(!html.includes('javascript:'), 'lien javascript: neutralisé');
  assert.ok(!html.includes('<img'), 'HTML du texte affiché, pas interprété');
});

test('sources : bloc ajouté en fin de texte, remplacé, retiré, sans toucher au reste', () => {
  const fmt = (d) => d.split('-').reverse().join('/');
  const a = { titre: 'Faille [critique] chez X', url: 'https://ex.fr/a', source: 'IT-Connect', date: '2026-10-06' };
  const b = { titre: 'Autre', url: 'https://ex.fr/b(1)', source: 'LeMagIT', date: '2026-10-07' };
  const texte = 'Mon analyse.\n\n- un point à moi';
  const one = setSources(texte, [a], fmt);
  assert.equal(one, 'Mon analyse.\n\n- un point à moi\n\n**Sources**\n\n- [Faille \\[critique\\] chez X](https://ex.fr/a) (IT-Connect, 06/10/2026)');
  const two = setSources(one, [a, b], fmt);
  assert.match(two, /\(<https:\/\/ex\.fr\/b\(1\)>\) \(LeMagIT, 07\/10\/2026\)$/);
  assert.equal(two.match(/\*\*Sources\*\*/g).length, 1, 'un seul bloc');
  assert.equal(setSources(two, [], fmt), texte, 'tout décocher retire le bloc');
  assert.deepEqual([...citedUrls(two)], ['https://ex.fr/a', 'https://ex.fr/b(1)']);
});

test('dernière synthèse : la plus récente des dates des titres', () => {
  assert.equal(lastSynthesisDate([{ titre: '05/10/2026 - A' }, { titre: '20/10/2026 : B' }, { titre: 'Octobre 2026 : C' }]), '2026-10-20');
  assert.equal(lastSynthesisDate([]), null);
});
