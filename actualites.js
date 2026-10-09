// =============================================================================
// Actualités d'un sujet (content/veille/<sujet>/actualites.json, dépôt du site)
// -----------------------------------------------------------------------------
//   actualites  affichées sur le site, et dans l'onglet « Dernières actualités »
//   horsSujet   écartées avec « Hors sujet » : absentes du site, jamais
//               reproposées par la collecte, retrouvées dans l'onglet
//               « Hors sujet » du tableau de bord, d'où on peut les remettre
//
// Fonctions sans effet de bord : elles renvoient un nouvel objet, que la page
// enregistre (un commit). Testées dans test/actualites.test.js.
// =============================================================================

import { citedUrls } from './syntheses.js?v=16';

// Les plus récentes d'abord, comme sur le site
export const byDate = (a, b) => b.date.localeCompare(a.date) || a.titre.localeCompare(b.titre, 'fr');

// « Hors sujet » : de actualites vers horsSujet, avec la date du jour ; null
// si l'actualité n'y est plus
export function discard(data, url, day) {
  const item = data.actualites.find((a) => a.url === url);
  if (!item) return null;
  return {
    ...data,
    actualites: data.actualites.filter((a) => a.url !== url),
    horsSujet: [{ ...item, ecarteLe: day }, ...(data.horsSujet ?? []).filter((a) => a.url !== url)],
  };
}

// « Remettre » : de horsSujet vers actualites, réinsérée à sa date (les autres
// ne bougent pas : le fichier ne change qu'à cet endroit) ; null si elle n'y est plus
export function restore(data, url) {
  const item = (data.horsSujet ?? []).find((a) => a.url === url);
  if (!item) return null;
  const actualite = { ...item };
  delete actualite.ecarteLe;
  const horsSujet = data.horsSujet.filter((a) => a.url !== url);
  const actualites = [...data.actualites];
  const index = actualites.findIndex((a) => a.date < actualite.date);
  actualites.splice(index === -1 ? actualites.length : index, 0, actualite);
  const next = { ...data, actualites, horsSujet };
  if (horsSujet.length === 0) delete next.horsSujet;
  return next;
}

// Actualités citées dans des synthèses publiées : adresse → titres des synthèses
export function usage(syntheses) {
  const used = new Map();
  for (const { titre, texte } of syntheses) {
    for (const url of citedUrls(texte)) used.set(url, [...(used.get(url) ?? []), titre]);
  }
  return used;
}
