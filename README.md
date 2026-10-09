# Synthèses de veille — tableau de bord

Page privée pour écrire l'onglet « Mes synthèses » de chacun des trois sujets de veille de mon portfolio [remim.me](https://remim.me/#/veille) (cybersécurité, virtualisation, facturation électronique), sans ouvrir l'éditeur de code : **https://veille.remim.me**

- **Choix du sujet** en haut de la page (← et → au clavier) ; le dernier sujet ouvert est retenu.

- **Liste, ajout, modification, suppression** des synthèses. Une nouvelle synthèse se place en haut (la plus récente d'abord), avec un titre qui commence par la date du jour (`09/10/2026 - …`).
- **Reformuler avec l'IA** : sélectionner un passage (sans sélection : tout le texte). L'IA propose une version plus claire, à accepter (**Remplacer**) ou non (**Garder mon texte**) ; Cmd+Z / Ctrl+Z annule un remplacement. Consignes données à l'IA : garder le sens, les faits, les chiffres, les noms et les liens, ne rien ajouter.
- **Aperçu** avec le même rendu Markdown que le site.
- **Publier** (ou Cmd+S / Ctrl+S) : un commit sur le dépôt du site, qui se republie tout seul en 2 à 3 minutes.
- **Visites du site** : visiteurs des 30 derniers jours et d'aujourd'hui, graphique par jour (valeur et date au survol ou au clavier, tableau « Voir les chiffres »), pages les plus vues. Les chiffres viennent de GoatCounter, lus avec une clé d'API en lecture seule collée une fois dans la page.

## Principe

Une page 100 % statique, publiée par GitHub Pages : pas de serveur, rien à héberger. Tout passe par l'API GitHub, directement depuis le navigateur, avec un jeton saisi à la connexion.

```
Navigateur ──► api.github.com ──► dépôt moreauremi.github.io
(veille.remim.me)                   │
                                    ├─ content/veille/<sujet>/syntheses.md   lu, puis réécrit : un commit par enregistrement
                                    │                               ──► deploy.yml republie remim.me
                                    │
                                    └─ « Reformuler avec l'IA » :
                                       1. la page dépose le passage dans une version (release) brouillon,
                                          visible seulement des personnes qui peuvent écrire dans le dépôt
                                       2. elle lance le workflow reformuler.yml avec le numéro du brouillon
                                       3. le workflow fait reformuler le passage par GitHub Copilot (l'IA de la
                                          veille, même secret) et écrit la réponse dans le brouillon
                                       4. la page lit la réponse, puis supprime le brouillon
```

La reformulation prend de 30 secondes à une minute : le temps que GitHub démarre une machine pour le workflow.

Le workflow et son script sont dans le dépôt du site : [`.github/workflows/reformuler.yml`](https://github.com/moreauremi/moreauremi.github.io/blob/main/.github/workflows/reformuler.yml) et [`scripts/reformuler.mjs`](https://github.com/moreauremi/moreauremi.github.io/blob/main/scripts/reformuler.mjs).

## Mise en route (une seule fois)

1. **DNS** : chez Namecheap (Domain List → remim.me → Advanced DNS), ajouter un enregistrement **CNAME Record**, hôte `veille`, valeur `moreauremi.github.io`. Puis, quand GitHub a vérifié le domaine (quelques minutes à quelques heures) : dépôt `veille-syntheses` → **Settings → Pages** → cocher **Enforce HTTPS**.
2. **Jeton GitHub** : https://github.com/settings/personal-access-tokens/new (jeton *fine-grained*). Expiration : 1 an. **Repository access** : *Only select repositories* → `moreauremi.github.io`. **Repository permissions** : **Contents** et **Actions** en *Read and write*, rien d'autre. Le coller sur la page de connexion.

L'IA utilise le secret `COPILOT_GITHUB_TOKEN` du dépôt du site, déjà en place pour la veille automatique : rien à ajouter.

3. **Visites du site** (facultatif) : sur https://remim.goatcounter.com, son nom d'utilisateur (menu du haut) → **API** → **New API key**, avec seulement la permission de lire les statistiques. La coller dans la boîte « Visites du site ». Le site compte les pages lui-même (`src/utils/audience.js` du dépôt du site) : voir « Mesure d'audience » dans son README.

## Sécurité

- **La clé GoatCounter** (lecture seule) reste elle aussi dans le navigateur et n'est envoyée qu'à GoatCounter ; « Oublier la clé » ou « Se déconnecter » l'effacent.
- **Le jeton** reste dans le navigateur (case « Rester connecté » : `localStorage`, sinon seulement l'onglet ouvert) et n'est envoyé qu'à `api.github.com`. Il n'a accès qu'au dépôt du site, avec deux droits. « Se déconnecter » l'efface. Sans jeton, la page ne peut rien faire : elle ne contient aucun secret.
- **Adresse à part** (`veille.remim.me`, pas `remim.me/…`) : le jeton est rangé pour cette seule origine, hors de portée du code du portfolio.
- **Aucun script étranger** : politique de sécurité (CSP) stricte, la page ne charge que ses propres fichiers et ne contacte que l'API GitHub et celle de GoatCounter. Le Markdown de l'aperçu ne peut rien exécuter : le HTML écrit dans le texte est affiché tel quel, les liens `javascript:` sont neutralisés. Les textes sont affichés avec `textContent`.
- **Pas d'affichage dans un cadre** d'un autre site (GitHub Pages ne permet pas l'en-tête qui l'interdit : la page vérifie elle-même).
- **Pas d'écrasement** : avant d'écrire, la page relit le fichier ; s'il a changé ailleurs (modification depuis VS Code, autre onglet), rien n'est écrit, la liste est rechargée et le texte en cours conservé.
- **Reformulation** : le dépôt du site est public, donc les journaux de ses workflows aussi. Le passage n'y est jamais écrit : il voyage dans un brouillon privé, supprimé dès la réponse lue. Copilot n'a droit à aucun outil (ni commande, ni écriture) et n'hérite pas du jeton du dépôt.

## Fichiers

```
index.html           structure de la page : connexion, liste, éditeur (et la CSP)
style.css            interface whiptail de RémiOS : fond bleu, boîtes grises en relief, boutons « < … > »
app.js               comportement de la page
config.js            dépôt du site, sujets de veille (à garder identiques à veille.sujets du site), workflow
github.js            API GitHub : lecture et écriture du fichier, reformulation
stats.js             API GoatCounter : visites par jour, pages les plus vues ; géométrie du graphique
visites.js           boîte « Visites du site » : chiffres clés, graphique SVG, tableau, pages
syntheses.js         format des fichiers syntheses.md (une synthèse par titre « ## »)
apercu.js            aperçu Markdown, au plus près du rendu du site
fonts/               IBM Plex Mono (400 et 600), la police du portfolio, licence OFL
vendor/              marked (conversion Markdown, licence MIT)
scripts/version.mjs  numéro de version des fichiers (npm run version), contre le cache des navigateurs
test/                tests (npm test) : format, fausses API GitHub et GoatCounter, graphique, aperçu, versions
CNAME                domaine de la page pour GitHub Pages
```

## En local

```bash
npm test         # tests (Node.js 22 ou plus, aucune dépendance à installer)
npm start        # sert la page sur http://localhost:8068
npm run version  # après chaque modification de la page, avant de l'envoyer
```

**Pourquoi `npm run version`** : GitHub Pages demande aux navigateurs de garder chaque fichier 10 minutes en cache. Juste après une mise à jour, un navigateur pourrait mélanger la nouvelle page et l'ancien style ou d'anciens scripts. Chaque fichier est donc appelé avec un numéro de version (`style.css?v=3`), que cette commande augmente partout à la fois ; `npm test` échoue si un fichier a été oublié. Après une mise à jour, la nouvelle version s'affiche au plus tard 10 minutes plus tard (tout de suite avec Cmd+Maj+R).

Attention : même en local, **Publier écrit sur le dépôt du site et le republie**. Penser à `git pull` dans le dossier du portfolio avant d'y modifier `syntheses.md` à la main.

## Crédits

- [marked](https://github.com/markedjs/marked) (licence MIT), copié dans `vendor/` : conversion Markdown, la même que celle du site.
- [IBM Plex Mono](https://github.com/IBM/plex) (licence SIL Open Font License, `fonts/OFL.txt`), copiée du portfolio.
- Code sous licence MIT (voir `LICENSE`).
