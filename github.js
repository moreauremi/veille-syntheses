// =============================================================================
// Échanges avec GitHub, directement depuis le navigateur
// -----------------------------------------------------------------------------
// La page n'a pas de serveur : toutes les requêtes partent vers api.github.com
// avec le jeton saisi à la connexion, qui ne va nulle part ailleurs.
//
//   - lecture et écriture des synthèses d'un sujet de veille,
//     content/veille/<sujet>/syntheses.md (API « contents ») : chaque écriture
//     est un commit sur la branche du site, qui relance sa publication ;
//   - reformulation par l'IA, par le workflow reformuler.yml du dépôt du site :
//     la page dépose le passage dans une version (release) brouillon, visible
//     seulement des personnes qui ont le droit d'écrire dans le dépôt, lance le
//     workflow, attend sa réponse dans le même brouillon, puis le supprime.
// =============================================================================

import { BRANCHE, DEPOT, WORKFLOW, fichier } from './config.js?v=6';

const API = `https://api.github.com/repos/${DEPOT}`;
const TAG_PREFIX = 'reformulation-';
const ABANDONED_MS = 15 * 60 * 1000; // brouillon de reformulation oublié (page fermée pendant l'attente)

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

//   token           : jeton GitHub
//   fetch           : remplaçable dans les tests
//   pollInterval    : attente entre deux lectures de la réponse de l'IA (ms)
//   rephraseTimeout : attente maximale de cette réponse (ms)
export function createClient(token, { fetch = globalThis.fetch.bind(globalThis), pollInterval = 4000, rephraseTimeout = 240_000 } = {}) {
  async function request(method, path, body) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', // toujours la dernière version du fichier
    });
    if (!response.ok) throw await toError(response);
    return response.status === 204 ? null : response.json();
  }

  // Brouillons de reformulation abandonnés et exécutions réussies du workflow
  // (les échouées restent, pour lire leur journal) : supprimés au passage,
  // sans bloquer ni signaler d'erreur
  async function cleanUp() {
    const releases = await request('GET', '/releases?per_page=100');
    for (const release of releases) {
      const old = Date.now() - Date.parse(release.created_at) > ABANDONED_MS;
      if (release.draft && release.tag_name.startsWith(TAG_PREFIX) && old) await request('DELETE', `/releases/${release.id}`);
    }
    const { workflow_runs: runs } = await request('GET', `/actions/workflows/${WORKFLOW}/runs?status=success&per_page=50`);
    for (const run of runs) await request('DELETE', `/actions/runs/${run.id}`);
  }

  return {
    // Fichier des synthèses d'un sujet → { source, version }
    async readFile(sujet) {
      const data = await request('GET', `/contents/${fichier(sujet)}?ref=${encodeURIComponent(BRANCHE)}`);
      return { source: fromBase64(data.content), version: data.sha };
    },

    // Nouveau contenu → { version, commit }. GitHub refuse (409) si le fichier
    // n'est plus à la version `version` : rien n'est écrasé.
    async writeFile(sujet, source, version, message) {
      const data = await request('PUT', `/contents/${fichier(sujet)}`, {
        message,
        content: toBase64(source),
        sha: version,
        branch: BRANCHE,
      });
      return { version: data.content.sha, commit: data.commit.html_url };
    },

    // Passage → passage reformulé par l'IA, avec des consignes adaptées au
    // sujet de veille. `onWait(secondes)` est appelé à chaque lecture de la
    // réponse, pour afficher l'attente.
    async rephrase(texte, sujet, onWait = () => {}) {
      const release = await request('POST', '/releases', {
        tag_name: `${TAG_PREFIX}${randomId()}`,
        target_commitish: BRANCHE,
        name: 'Reformulation en cours (tableau de bord des synthèses)',
        body: JSON.stringify({ texte, sujet }),
        draft: true,
      });
      try {
        await request('POST', `/actions/workflows/${WORKFLOW}/dispatches`, {
          ref: BRANCHE,
          inputs: { demande: String(release.id) },
        });
        const start = Date.now();
        while (Date.now() - start < rephraseTimeout) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          onWait(Math.round((Date.now() - start) / 1000));
          const reponse = parseJson((await request('GET', `/releases/${release.id}`)).body);
          if (reponse?.etat === 'ok' && typeof reponse.texte === 'string') return reponse.texte;
          if (reponse?.etat === 'erreur') throw new GitHubError(502, `Reformulation impossible : ${reponse.message}`);
        }
        throw new GitHubError(
          504,
          "L'IA n'a pas répondu à temps (la tâche GitHub Actions attend peut-être une machine libre). Réessayez dans un moment.",
        );
      } finally {
        await request('DELETE', `/releases/${release.id}`).catch(() => {});
        cleanUp().catch(() => {});
      }
    },
  };
}

// Réponse d'erreur de GitHub → message qui dit quoi faire
async function toError(response) {
  const detail = await response
    .json()
    .then((data) => data.message ?? '')
    .catch(() => '');
  const { status } = response;
  const messages = {
    401: 'Jeton refusé par GitHub : expiré, révoqué ou mal copié. Reconnectez-vous avec un nouveau jeton.',
    403: /rate limit/i.test(detail)
      ? 'Limite de requêtes GitHub atteinte : réessayez dans quelques minutes.'
      : "Jeton sans les droits nécessaires sur le dépôt du site : « Contents » et « Actions » en lecture et écriture (voir l'aide de la page de connexion).",
    404: "Dépôt, fichier ou workflow introuvable, ou jeton sans accès au dépôt du site (voir l'aide de la page de connexion).",
    409: 'Le fichier a changé entre-temps.',
  };
  return new GitHubError(status, messages[status] ?? `GitHub a répondu ${status}${detail ? ` : ${detail}` : ''}.`);
}

function parseJson(text) {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
}

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Texte (UTF-8) ↔ base64, le format de l'API « contents ». btoa et atob ne
// connaissent que les octets : le texte passe par TextEncoder / TextDecoder.
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
