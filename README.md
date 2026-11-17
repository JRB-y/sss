# sss-play-check

Script Playwright qui se connecte à un compte **ssandsun.com/play**, vérifie quelques points de
santé, exporte l'historique de combats en JSON et tient à jour une documentation du jeu
(règles officielles et fiches de troupes) en Markdown — tout de façon incrémentale.

## Installation

```bash
npm install                 # installe Playwright + Chromium
cp .env.example .env        # puis renseigne SSS_EMAIL / SSS_PASSWORD
```

`.env` est dans `.gitignore`, ainsi que `out/state.json` (cookies de session) et `data/`.

## Utilisation

```bash
npm run ui         # interface locale → http://127.0.0.1:4173  (tout passe par là)

npm run check      # connexion + vérifications → out/report.json + out/game.png
npm run fights     # télécharge les combats absents → data/fights.json
npm run all        # les deux
npm run rules      # règles officielles du site → docs/regles.md (sans connexion)
npm run troops     # fiches des troupes relevées en jeu → data/troops.json + docs/troupes.md
npm run analyse    # bilan + compositions dans le terminal → out/analysis.json
npm run explore    # dépose les réponses brutes du jeu dans data/raw/ (debug)
```

Options (après `--` avec npm, ou directement) :

```bash
npm run fights -- --refresh     # retélécharge le détail de TOUS les combats
npm run check  -- --headed      # navigateur visible
npm run fights -- --fresh       # ignore la session enregistrée, rejoue le formulaire
npm run fights -- --raw         # garde le HTML des listes dans data/raw/
npm run rules  -- --locale=en   # autre langue : fr (défaut), en, es, de, it
npm run ui     -- --port=5000   # autre port pour l'interface
```

## L'interface (`npm run ui`)

Un petit serveur local (`src/server.mjs`, sans dépendance) sert `web/` et expose les mêmes
traitements que la CLI. Rien n'est écrit vers le jeu : on lit, on analyse, on simule.

| Écran | Ce qu'on y trouve |
| --- | --- |
| **Tableau de bord** | les trois boutons, ce qu'il y a en base, et le journal en direct |
| **Les règles** | `docs/regles.md` rendu avec sommaire latéral et recherche |
| **Les troupes** | `docs/troupes.md`, même traitement |
| **Analyse des combats** | bilan, rendement par type, capacités gaspillées, vivier adverse, fiabilité du simulateur |
| **Compositions** | les meilleures compositions trouvées, comparées à celle que tu as en ligne |

Les boutons qui touchent au jeu ouvrent Chromium et se connectent : une seule tâche à la fois, et
son avancement part en Server-Sent Events vers la page (panneau **Journal**).

## Analyse des combats (`npm run analyse`, onglet Analyse)

Tout vient des rapports de combat (`detail.fight.report`), une fois le format décodé :

- `events` est la frise complète du combat, un tableau par coup :
  `[t, camp, typeAttaquant, typeCible, dégâts, unitésVivantes, riposte]`. `t` est en **centièmes de
  seconde** (`result.cs` = durée du combat dans la même unité), `unitésVivantes` vaut 0 quand la pile
  est au complet, et la riposte compte comme des dégâts subis par l'attaquant.
- Les dégâts d'un coup valent `unités vivantes × tirage(min…max) × (critique ? 1,5) × (1 − fortification)`,
  et les unités vivantes suivent la part de PV restante du groupe. Vérifié coup par coup.
- `abNeed` / `abOn` donnent le seuil d'activation retenu par le serveur (10 % des places) et les
  capacités qui ont **réellement** fonctionné. C'est la mesure la plus utile : elle dit quelles
  capacités une composition paie sans les utiliser.
- `abilities` donne l'amplitude réelle de chaque capacité. Bouclier 8 % des PV de l'armée, second
  souffle ≈ 11,3 %, **onde de choc ≈ 6,8 % des PV de l'armée adverse** — ce dernier chiffre n'est
  documenté nulle part dans les règles.

Deux résultats contre-intuitifs sortent de l'historique :

- **Le triangle des rôles n'agit pas sur les dégâts.** À rôle d'attaquant donné, les dégâts par
  unité ne dépendent pas du rôle de la cible (écarts < 2 % sur 1 798 coups, après normalisation par
  combat et par type qui annule l'équipement). Le ciblage n'est pas non plus orienté par le rôle :
  la cible est tirée au sort, pondérée par les PV.
- **En défense, les piles démarrent à 70 % de leurs PV**, parce que l'attaque arrive avant la fin de
  la récupération ; un attaquant part toujours à 100 %. C'est la première cause des défaites en
  défense, loin devant la composition.

## Simulateur et compositions (onglet Compositions)

`src/sim.mjs` rejoue un combat de façon **déterministe** (espérances, pas de tirage) avec les
mécaniques ci-dessus, puis cherche la meilleure composition.

- **Recherche** : toutes les combinaisons de types débloqués (jusqu'à 4, ou 5 avec l'Annexe),
  réparties par dixièmes des places — le seuil des capacités valant 10 % des places, chaque part non
  nulle allume sa capacité — puis affinage par déplacements d'unités entre types.
- **Score** : chaque composition est jouée contre **tous les adversaires de ton historique**, avec
  leur fortification et ton état de troupes réel. Pas contre une cible théorique.
- **Honnêteté** : `backtest()` rejoue l'historique à partir des seules informations d'avant-combat.
  Le seuil de bascule est calé sur ces combats (un paramètre par rôle, sur la justesse *équilibrée*
  pour que « prédire défaite à tous les coups » ne passe pas pour un bon modèle). L'interface
  affiche la justesse obtenue, le pouvoir de classement (AUC) et la référence « tout perdu ».
  À utiliser pour **classer** des compositions, pas pour promettre un résultat.

> Ce qui n'est pas modélisé : renforts de famille, objets non encore forgés, capacités adverses mal
> documentées (coup de grâce, corruption) et la dispersion des tirages de dégâts.

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

## Documentation du jeu (`docs/`)

Deux documents générés, pas écrits à la main : relance la commande pour les rafraîchir.

### `docs/regles.md` — les règles officielles (`npm run rules`)

Conversion en Markdown de <https://ssandsun.com/fr/regles> : 13 chapitres, 56 sections, tableaux
et encadrés compris. La page est rendue côté serveur, donc **aucune connexion n'est nécessaire** —
un simple `fetch`. Le balisage est régulier (`section.r-chapter` › `article.r-section` ›
`p | ul.r-list | ol.r-steps | table.r-table | div.r-facts | p.r-note`), il est traduit bloc par
bloc pour ne rien perdre des tableaux. `--locale=` choisit la langue (`fr`, `en`, `es`, `de`, `it`).

### `docs/troupes.md` — les 21 types de troupes (`npm run troops`)

Relevé dans le jeu via `GET /play/view/units?cat=<troops|girls|narcos>`. Chaque carte
(`li.unit-card`) porte le rôle, la capacité spéciale et son texte complet, les stats **de base**
(le type seul) **et effectives** (tes talents + ton équipement), le niveau de type et le coût au
recrutement. Les filles et les narcos passent par la même vue (production par tour, risque
d'arrestation).

> **Ce que le serveur ne donne pas.** Les types au-dessus de ton niveau de personnage sont servis
> masqués (`is-secret`) : ni stats, ni capacité. Seul le **prochain** à débloquer est montré en
> avant-première. Aucune autre vue du jeu ne les expose (vérifié sur une quarantaine de vues, les
> rapports de combat et le bundle `app.js`). `data/troops.json` **accumule** donc, comme
> `data/fights.json` : relancer la commande en montant de niveau complète le document, et une
> carte masquée n'écrase jamais un relevé déjà fait. Niveaux de déblocage et rôles des types encore
> verrouillés viennent des règles publiques, les noms français aussi.

> **Langue.** L'interface du jeu suit le réglage du compte (`boot.locale`) ; ni `Accept-Language`
> ni un paramètre d'URL ne la changent. Les noms d'unité, descriptions et libellés sont donc relevés
> dans cette langue — le document le signale et complète avec les noms et effets français des règles.

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
src/troops.mjs    cartes du shop → data/troops.json + docs/troupes.md
src/rules.mjs     règles publiques → docs/regles.md (sans navigateur)
src/analyse.mjs   lecture des rapports de combat : tout le mesuré
src/sim.mjs       simulateur de combat, backtest et recherche de compositions
src/server.mjs    serveur local de l'interface (http + SSE, sans dépendance)
src/explore.mjs   dump des réponses brutes (debug)
src/index.mjs     CLI
web/              l'interface (index.html, style.css, app.js)
docs/             documents générés (versionnés)
```
