// =============================================================================
// Aperçu d'une synthèse, au plus près du rendu du site
// -----------------------------------------------------------------------------
// Même conversion que le site (plugins/content/markdown.js du dépôt du site) :
// Markdown « GitHub » avec marked, commentaires retirés, liens externes dans
// un nouvel onglet, espaces insécables de la typographie française.
// Différence volontaire : le HTML écrit dans le texte est affiché tel quel au
// lieu d'être interprété, et les liens ne peuvent pas lancer de script. Cette
// page garde le jeton GitHub : rien de ce qu'on y tape ne doit s'y exécuter.
// =============================================================================

import { Marked } from './vendor/marked.esm.js';

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safeHref = /^\s*(javascript|data|vbscript):/i.test(href) ? '#' : href;
      const external = /^https?:\/\//.test(safeHref);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(safeHref)}"${titleAttr}${target}>${label}</a>`;
    },
    // Les images d'une fiche sont des chemins du site : introuvables ici
    image({ text }) {
      return `<span class="image-ph">[image : ${escapeHtml(text)}]</span>`;
    },
  },
});

export function renderPreview(titre, texte) {
  const markdown = `${titre.trim() ? `## ${titre.trim()}\n\n` : ''}${texte}`.replace(/<!--[\s\S]*?-->/g, '');
  return frenchSpacing(marked.parse(markdown));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Typographie française (repris de src/utils/html.js du site) : espace
// insécable avant « ; : ! ? » et à l'intérieur des guillemets « ». Seul le
// texte est modifié, jamais l'intérieur d'une balise.
function frenchSpacing(html) {
  return html
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith('<')
        ? part
        : part
            .replace(/ ([;!?])/g, '\u202f$1')
            .replace(/ (:)/g, '\u00a0$1')
            .replace(/« /g, '«\u00a0')
            .replace(/ »/g, '\u00a0»'),
    )
    .join('');
}
