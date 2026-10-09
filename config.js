// Réglages du tableau de bord : le dépôt du site, les sujets de veille et
// le workflow qui fait reformuler un passage par l'IA.

export const DEPOT = 'moreauremi/moreauremi.github.io';
export const BRANCHE = 'main';
export const WORKFLOW = 'reformuler.yml';

// Sujets de veille, dans l'ordre des onglets du site. `id` : le dossier
// content/veille/<id>/ du dépôt du site (mêmes identifiants que veille.sujets
// dans content/site.config.js : à mettre à jour ensemble).
export const SUJETS = [
  { id: 'cybersecurite', nom: 'Cybersécurité' },
  { id: 'virtualisation', nom: 'Virtualisation' },
  { id: 'facturation-electronique', nom: 'Facturation électronique' },
];

// Fichier des synthèses d'un sujet
export const fichier = (sujet) => `content/veille/${sujet}/syntheses.md`;

// Onglet du sujet sur le site, pour le lien « Voir sur le site »
export const pageDuSujet = (sujet) => `https://remim.me/#/veille/${sujet}`;
