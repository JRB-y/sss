# sss-play-check

Script Playwright qui se connecte à un compte **ssandsun.com/play**, vérifie quelques points de
santé et exporte l'historique de combats en JSON, de façon incrémentale.

## Installation

```bash
npm install                 # installe Playwright + Chromium
cp .env.example .env        # puis renseigne SSS_EMAIL / SSS_PASSWORD
```

`.env` est dans `.gitignore`, ainsi que `out/state.json` (cookies de session) et `data/`.

## Utilisation

```bash
npm run check      # connexion + vérifications → out/report.json + out/game.png
npm run fights     # télécharge les combats absents → data/fights.json
npm run all        # les deux
npm run explore    # dépose les réponses brutes du jeu dans data/raw/ (debug)
```

Options (après `--` avec npm, ou directement) :

```bash
npm run fights -- --refresh     # retélécharge le détail de TOUS les combats
npm run check  -- --headed      # navigateur visible
npm run fights -- --fresh       # ignore la session enregistrée, rejoue le formulaire
npm run fights -- --raw         # garde le HTML des listes dans data/raw/
```

Code de sortie : `0` si tout passe, `1` si un check échoue ou si un combat n'a pas pu être
téléchargé — utilisable tel quel en cron ou en CI.

## Ce qui est vérifié (`npm run check`)

| Point | Comment |
| --- | --- |
| `/play` répond 200 | statut de la réponse du document |
| Payload de boot lisible | `<script id="boot">` parsé en JSON |
| Connexion au compte | `boot.state === 'game'` et `boot.player` non nul |
| Joueur et ville chargés | `boot.player.name`, `boot.cities` |
| Cadre de jeu présent | `#stage`, `#map`, `#layer`, `#toasts`, canvas MapLibre |
| Pouls serveur | `GET /play/pulse` |
| Vues d'historique accessibles | `GET /play/view/fights?dir=sent|received` |
| Console & réseau propres | erreurs console, exceptions JS, réponses ≥ 400, requêtes échouées |

Les 401/403 émis avant connexion sont comptés à part (sondes de session, normal).

Pour ajouter tes propres points, édite `PAGE_CHECKS` dans `src/checks.mjs` :

```js
{ label: 'Bouton téléphone', selector: '.phone-btn[data-view="phone"]' },
{ label: 'Pseudo affiché',   text: 'MonPseudo' },
```

## Historique de combats (`npm run fights`)

Le script utilise l'API interne du jeu plutôt que de scraper l'écran :

1. **Listes** — `GET /play/view/fights?dir=<sent|received>` renvoie le HTML de la vue ; chaque
   ligne (`li.fh-row`) porte `data-fight-replay="<id>"`, le résultat, le delta de points, le
   butin et l'adversaire. Les directions sont lues dans les onglets de la vue (repli : `sent`,
   `received`) ; les réfs `tmp:` / `share:` (combats volatils) sont ignorées.
2. **Détails** — `GET /play/fight?id=<id>` renvoie le combat complet en JSON
   (`{ ok, fight, names, imgs, res }`), exactement ce que le rejeu utilise (déroulé, unités,
   capacités, bâtiments pillés…).
3. **Fusion** — chaque run ne télécharge que les ids absents de `data/fights.json`. Relancer la
   commande à tout moment ne récupère donc que les nouveaux combats.

> **Portée de l'historique.** Le serveur n'expose **pas** de pagination : la vue renvoie une
> fenêtre fixe des combats récents (tes derniers envoyés + reçus), et `page` / `offset` / `before`
> sont ignorés. On ne peut donc pas remonter plus loin que ce que le jeu affiche. Comme le fichier
> **accumule**, un combat reste en base même après être sorti de la fenêtre : lancer la commande
> régulièrement (cron, lancement manuel) constitue l'archive complète au fil du temps.

### Format de `data/fights.json`

```json
{
  "version": 1,
  "updatedAt": "2026-11-17T12:00:00.000Z",
  "account": "MonPseudo",
  "counts": { "sent": 27, "received": 30 },
  "fights": {
    "9513": {
      "id": 9513,
      "dirs": ["received"],
      "summary": {
        "role": "def", "won": false,
        "me": { "id": 94, "name": "JoeyJr", "level": 12 },
        "opponent": { "id": 12, "name": "Jason Voorhees", "level": 12 },
        "at": 1794761239, "ago": "1 d ago", "delta": "−14 Points",
        "loot": [{ "res": "cash", "value": "−55" }], "buildingsRaided": 3
      },
      "list": { "id": 9513, "outcome": "loss", "result": "Raided", "revenge": false, "…": "" },
      "firstSeenAt": "2026-11-17T12:00:00.000Z",
      "fetchedAt": "2026-11-17T12:00:00.000Z",
      "detail": { "fight": { }, "names": { }, "imgs": { }, "res": { } }
    }
  }
}
```

- `summary` — lecture rapide (qui, résultat, points, butin) croisant la ligne et le détail.
- `list` — ce que montrait la ligne d'historique.
- `detail` — le combat brut complet (`fight.report` : unités, événements, capacités, pillage).

Index par id : la fusion est idempotente et l'écriture atomique (un run interrompu ne laisse pas
de fichier tronqué).

## Réglages (`.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `SSS_EMAIL`, `SSS_PASSWORD` | — | identifiants du compte |
| `SSS_BASE_URL` | `https://ssandsun.com` | base du site |
| `SSS_HEADED` | `0` | `1` pour un navigateur visible |
| `SSS_DELAY_MS` | `150` | pause entre deux requêtes |
| `SSS_TIMEOUT_MS` | `45000` | délai max des attentes Playwright |
| `SSS_DIRS` | auto | forcer les directions, ex. `sent,received` |
| `SSS_LOCALE` | `en` | langue demandée |
| `SSS_DEBUG` | `0` | `1` pour la stack trace complète |

## Structure

```
src/config.mjs    lecture de l'environnement, chemins
src/client.mjs    Chromium, connexion, helpers d'API (view/json), collecte console+réseau
src/checks.mjs    les points vérifiés + rapport
src/fights.mjs    listes → détails → fusion incrémentale
src/explore.mjs   dump des réponses brutes (debug)
src/index.mjs     CLI
```
