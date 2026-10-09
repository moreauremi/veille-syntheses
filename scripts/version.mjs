// =============================================================================
// Numéro de version des fichiers de la page : `npm run version`
// -----------------------------------------------------------------------------
// GitHub Pages demande aux navigateurs de garder chaque fichier 10 minutes en
// cache. Juste après une mise à jour, un navigateur pourrait donc mélanger la
// nouvelle page et d'anciens fichiers (style, scripts). Chaque fichier est
// appelé avec un numéro de version (style.css?v=3) : une page ne charge que
// les fichiers de sa propre version.
//
// À lancer après chaque modification de la page, avant de l'envoyer : le
// numéro augmente de 1 partout à la fois. Le test test/version.test.js vérifie
// qu'aucun fichier n'a été oublié.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILES = ['index.html', ...fs.readdirSync(ROOT).filter((file) => file.endsWith('.js'))];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = Math.max(...FILES.flatMap((file) => [...read(file).matchAll(/\?v=(\d+)/g)].map((m) => Number(m[1]))));
  const next = current + 1;
  for (const file of FILES) fs.writeFileSync(path.join(ROOT, file), read(file).replace(/\?v=\d+/g, `?v=${next}`));
  console.log(`Version des fichiers : ${current} → ${next}`);
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}
