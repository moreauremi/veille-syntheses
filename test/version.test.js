// Numéro de version des fichiers (voir scripts/version.mjs) : `npm test`

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FILES } from '../scripts/version.mjs';

test('chaque fichier de la page est appelé avec le même numéro de version', () => {
  const references = FILES.flatMap((file) => {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const pattern = file.endsWith('.html') ? /(?:href|src)="(?!https?:|data:|#)([^"]+\.(?:css|js)[^"]*)"/g : /from '(\.[^']+)'/g;
    return [...text.matchAll(pattern)].map((match) => ({ file, url: match[1] }));
  });
  assert.ok(references.length >= 8, 'références trouvées');
  const versions = new Set();
  for (const { file, url } of references) {
    const version = url.match(/\?v=(\d+)$/)?.[1];
    assert.ok(version, `${file} : « ${url} » sans numéro de version (lancer npm run version)`);
    versions.add(version);
  }
  assert.equal(versions.size, 1, `numéros différents : ${[...versions].join(', ')} (lancer npm run version)`);
});
