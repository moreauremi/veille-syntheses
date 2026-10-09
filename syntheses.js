// =============================================================================
// Lecture et écriture de content/pages/syntheses.md (dépôt du site)
// -----------------------------------------------------------------------------
// Le fichier contient un en-tête (front matter, consignes en commentaire),
// puis une synthèse par titre de niveau 2, la plus récente en haut :
//
//   ## Octobre 2026 : NIS 2 arrive dans les PME industrielles
//
//   Texte de la synthèse…
//
// Sans aucune synthèse, le fichier se termine par « À venir. », affiché tel
// quel sur le site.
// =============================================================================

export const PLACEHOLDER = 'À venir.';

const MAX_TITLE = 200;
const MAX_TEXT = 20_000;

// Texte du fichier → { head, syntheses: [{ titre, texte }] }
// `head` : tout ce qui précède la première synthèse, sans « À venir. »
export function parseSyntheses(source) {
  const text = source.replace(/\r\n?/g, '\n');
  const starts = [...hideIgnored(text).matchAll(/^## .*$/gm)].map((match) => match.index);
  const head = text
    .slice(0, starts[0] ?? text.length)
    .split('\n')
    .filter((line) => line.trim() !== PLACEHOLDER)
    .join('\n');
  const syntheses = starts.map((start, i) => {
    const block = text.slice(start, starts[i + 1] ?? text.length);
    const newline = block.indexOf('\n');
    const titre = (newline === -1 ? block : block.slice(0, newline)).slice(3).trim();
    const texte = newline === -1 ? '' : block.slice(newline + 1).trim();
    return { titre, texte };
  });
  return { head, syntheses };
}

// { head, syntheses } → texte du fichier
export function serializeSyntheses({ head, syntheses }) {
  const body = syntheses.length
    ? syntheses.map(({ titre, texte }) => `## ${titre}\n\n${texte}`).join('\n\n')
    : PLACEHOLDER;
  return `${head.trimEnd()}\n\n${body}\n`;
}

// Synthèse saisie → { synthese } nettoyée, ou { errors }
export function checkSynthese(input) {
  const titre = String(input?.titre ?? '').replace(/\s+/g, ' ').trim();
  const texte = String(input?.texte ?? '').replace(/\r\n?/g, '\n').trim();
  const errors = [];
  if (!titre) errors.push('le titre est vide');
  if (titre.length > MAX_TITLE) errors.push(`le titre dépasse ${MAX_TITLE} caractères`);
  if (!texte) errors.push('le texte est vide');
  if (texte.length > MAX_TEXT) errors.push(`le texte dépasse ${MAX_TEXT} caractères`);
  // Un « ## » dans le texte commencerait une nouvelle synthèse
  if (/^## /m.test(hideIgnored(texte))) {
    errors.push('le texte contient un titre « ## », qui deviendrait une autre synthèse : utiliser « ### » pour un sous-titre');
  }
  return errors.length ? { errors } : { synthese: { titre, texte } };
}

// Masque (par des espaces, sans changer les positions ni les lignes) les
// commentaires <!-- … --> et les blocs de code ``` : un « ## » qui s'y trouve,
// comme l'exemple des consignes, n'est pas un titre de synthèse.
function hideIgnored(text) {
  const blank = (part) => part.replace(/[^\n]/g, ' ');
  return text.replace(/<!--[\s\S]*?-->/g, blank).replace(/^```[\s\S]*?^```/gm, blank);
}

// --- Sources : les actualités dont parle la synthèse --------------------------------
//
// Cocher une actualité dans le tableau de bord ajoute son lien dans un bloc
// « Sources », toujours en fin de synthèse :
//
//   **Sources**
//
//   - [Titre de l'article](https://…) (Source, 6 octobre 2026)
//
// Le bloc est réécrit à chaque case cochée ou décochée ; ce qui le précède
// n'est jamais touché.

const SOURCES_BLOCK = /(?:^|\n+)\*\*Sources\*\*[ \t]*(?:\n(?:[ \t]*|- .*))*$/;

// Texte + actualités citées (dans l'ordre voulu) → texte avec le bloc à jour
export function setSources(texte, items, formatDate) {
  const base = texte.replace(SOURCES_BLOCK, '').trimEnd();
  if (items.length === 0) return base;
  const lines = items.map((a) => `- [${a.titre.replace(/[[\]\\]/g, '\\$&')}](${/[\s()<>]/.test(a.url) ? `<${a.url}>` : a.url}) (${a.source}, ${formatDate(a.date)})`);
  return `${base ? `${base}\n\n` : ''}**Sources**\n\n${lines.join('\n')}`;
}

// Adresses des liens présents dans le texte (pour cocher les actualités déjà citées)
export function citedUrls(texte) {
  // [texte](adresse) ou [texte](<adresse avec parenthèses>)
  return new Set([...texte.matchAll(/\]\((?:<([^>]+)>|([^)\s]+))\)/g)].map((match) => match[1] ?? match[2]));
}

// Date de la synthèse la plus récente (AAAA-MM-JJ), lue dans les titres
// « JJ/MM/AAAA - … » ; null si aucune n'est datée
export function lastSynthesisDate(syntheses) {
  const dates = syntheses
    .map((s) => /(\d{2})\/(\d{2})\/(\d{4})/.exec(s.titre))
    .filter(Boolean)
    .map(([, d, m, y]) => `${y}-${m}-${d}`);
  return dates.sort().at(-1) ?? null;
}
