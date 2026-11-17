# sss-play-check

Script Playwright qui se connecte à un compte **ssandsun.com/play** et constitue, sur ton poste,
une archive de ton jeu qui se complète à chaque passage :

- **l'historique de tes combats**, repris là où le passage précédent s'était arrêté ;
- **une fiche par adversaire croisé** — son armée, l'équipement de chaque pile, et la date de
  chaque fois où il a changé de troupes ;
- **un catalogue des objets** vus en combat, avec leurs bornes d'affixes par rareté ;
- la documentation du jeu (règles officielles et fiches de troupes) en Markdown ;
- quelques points de santé du compte.

Tout est incrémental : rien n'est jamais réécrit, chaque passage ne fait qu'ajouter.

## Installation

```bash
npm install                 # installe Playwright + Chromium
cp .env.example .env        # puis renseigne SSS_EMAIL / SSS_PASSWORD
```

`.env` est dans `.gitignore`, ainsi que `out/state.json` (cookies de session) et `data/`.

## Utilisation

```bash
npm run ui         # interface locale → http://127.0.0.1:4173  (tout passe par là)

npm run update     # LE geste courant : combats + troupes, et tout ce qui s'en déduit
npm run check      # connexion + vérifications → out/report.json + out/game.png
npm run fights     # télécharge les combats absents → data/fights.json (+ fiches d'adversaires)
npm run enemies    # reconstruit les fiches d'adversaires et les objets (sans connexion)
npm run all        # check + fights
npm run rules      # règles officielles du site → docs/regles.md (sans connexion)
npm run troops     # fiches des troupes relevées en jeu → data/troops.json + docs/troupes.md
npm run skills     # ton arbre de talents → data/skills.json
npm run analyse    # bilan + compositions dans le terminal → out/analysis.json
npm run explore    # dépose les réponses brutes du jeu dans data/raw/ (debug)
```

Seuls `update`, `check`, `fights`, `troops`, `skills` et `explore` ouvrent un navigateur et se connectent.
`enemies`, `analyse` et `rules` ne lisent que des fichiers — relance-les autant que tu veux.

Options (après `--` avec npm, ou directement) :

```bash
npm run fights -- --refresh     # retélécharge le détail de TOUS les combats
npm run check  -- --headed      # navigateur visible
npm run fights -- --fresh       # ignore la session enregistrée, rejoue le formulaire
npm run fights -- --raw         # garde le HTML des listes dans data/raw/
npm run rules  -- --locale=en   # autre langue : fr (défaut), en, es, de, it
npm run ui     -- --port=5000   # autre port pour l'interface
npm run fights -- --no-project  # ne pas reprojeter les fiches d'adversaires derrière
```

## L'interface (`npm run ui`)

Un petit serveur local (`src/server.mjs`, sans dépendance) sert `web/` et expose les mêmes
traitements que la CLI. Rien n'est écrit vers le jeu : on lit, on analyse, on simule.

| Écran | Ce qu'on y trouve |
| --- | --- |
| **Tableau de bord** | le bouton **Mettre à jour**, ce qu'il y a en base, et où en est la reprise de l'historique |
| **Analyse des combats** | bilan, rendement par type, capacités gaspillées, vivier adverse, équipement comparé, fiabilité du simulateur |
| **Adversaires** | une fiche par joueur croisé : son armée, ses objets, l'historique daté de ses changements de troupes |
| **Simulateur** | un duel contre un adversaire réel : rejoue un combat ou éprouve une composition montée à la main |
| **Compositions** | les meilleures compositions trouvées, comparées à celle que tu as en ligne |
| **Les règles / Les troupes / Les objets** | les documents générés, rendus avec sommaire latéral et recherche |

**Un seul geste touche au jeu** : le bouton *Mettre à jour*, qui ouvre Chromium, se connecte,
reprend les combats manquants, relève tes troupes, puis reconstruit les fiches d'adversaires et le
catalogue d'objets. Tous les autres écrans se calculent hors ligne, à partir de `data/`, et se
remplissent seuls à la première visite — il n'y a plus de bouton « Analyser » à cliquer avant de
voir quelque chose. Une seule tâche tourne à la fois, et son avancement part en Server-Sent Events
vers la page (panneau **Journal**). Les actions au grain fin (combats seuls, troupes seules,
reconstruire les fiches, tout retélécharger) sont repliées sous *Actions détaillées*.

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

## Le simulateur (onglet Simulateur)

Un duel joué coup par coup contre un adversaire **réel** de ton historique — son armée exacte, son
équipement, ses fortifications, telles que le rapport de combat les donne. Deux usages :

- **rejouer un combat** en changeant de composition : « et si j'avais aligné ça ce jour-là ? ».
  Si tu ne touches à rien, le rejeu est fidèle (piles reconstruites avec leurs PV réels d'alors) et
  la page compare le verdict simulé au résultat qui s'est vraiment produit ;
- **éprouver une composition** montée de toutes pièces : un curseur et un champ par type, la jauge
  des places, le seuil des capacités affiché en direct (un type sous 10 % des places porte sa
  capacité sans qu'elle agisse — le badge le dit).

Ce que tu obtiens : l'issue et la marge, la **courbe des PV des deux camps** avec les capacités en
repères, le détail pile par pile (dégâts infligés, subis, PV restants), la frise des capacités
déclenchées — et, pour éviter de conclure sur un seul duel, le bilan de la même composition
**contre les combats archivés**.

Depuis l'onglet Compositions, chaque proposition a un bouton *Essayer dans le simulateur* qui la
charge directement.

> Le moteur est déterministe : il calcule des espérances, pas un tirage. Deux compositions se
> comparent donc sans bruit, mais un vrai combat garde sa part de hasard.

## Recherche de compositions (onglet Compositions)

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

### Niveau de type, talents, équipement : les trois sources de puissance

Une stat réelle se décompose exactement ainsi — vérifié sur les types sans équipement, où la
formule tombe à 1 % près sur la valeur servie par le jeu :

```
réel = (base du type à son niveau de type + bonus plats) × (1 + talents % + objets %)
```

**Le niveau de type** vaut +2 % de vie et de dégâts par palier, pour *toutes* les unités du type.
Le bonus est **additif, pas composé** : `base × (1 + 2 % × (n − 1))`. Les règles ne le précisent
pas, mais la mesure est nette. En déduisant le facteur « talents + matériel » depuis la carte du
shop, il doit rester constant d'un niveau à l'autre, et il l'est à la 4ᵉ décimale près avec le
modèle additif (Bandit 1,2050 / 1,2051 / 1,2051 aux niveaux 1, 2 et 3) là où un modèle composé
dérive (1,2050 → 1,2047). L'écart est petit — 0,2 % au niveau 5, 1,6 % au niveau 50 — mais il va
dans le sens de surestimer les hauts niveaux, c'est-à-dire les adversaires qui comptent.

Le jeu expose aussi l'**XP de chaque type** (`7 911 / 27 134 XP avant le niveau 4`) : `npm run
troops` la relève et `docs/troupes.md` dit combien il reste avant le prochain palier. Seuils
observés : 2 100 · 11 546 · 27 134 · 47 891 XP pour les niveaux 2 à 5.

**Les talents** (`npm run skills`, `/play/view/skills`) sont la pièce qui manquait. Sans eux,
l'écart entre les stats « de base » et « réelles » d'une carte était un trou noir où talents et
objets se confondaient. L'arbre donne l'effet exact de chaque nœud et les points dépensés — 45
nœuds, tous décodés. Sur ce compte, la branche Défense est à 0 point, donc **les talents
n'apportent aucun bonus de vie** : tout l'écart de PV d'un type équipé vient de son matériel,
bonus intrinsèque compris. C'est ce qui rend ce dernier mesurable.

**Le multiplicateur de critique** en dépend aussi. Le jeu part de ×1,5 et le talent *Executioner*
annonce « +50 % de dégâts critiques », sans dire si la prime passe de +50 % à +100 % (×2,0) ou si
les dégâts critiques gagnent 50 % (×2,25). On ne tranche pas au jugé : `calibrateCrit()` rejoue
l'historique avec les trois hypothèses et retient la meilleure. Verdict sans appel — ×2,25 donne
90,2 % de justesse contre 85,2 % pour ×1,5 et ×2,0.

### Comment une pile adverse est reconstruite

Trois sources, chacune à sa place :

1. **servi par le serveur** — les PV unitaires. Équipement, talents et bonus de famille d'en face y
   sont déjà ;
2. **mesuré dans la frise des coups** — la cadence réelle de la pile (durée du combat ÷ coups
   portés) ;
3. **carte du shop + équipement relevé** — les stats **de base** du type (sans *tes* talents ni
   *ton* matériel, qui ne sont pas les siens), au niveau de type de la pile, auxquelles on applique
   les affixes de ses trois pièces.

Ce que ça change, mesuré sur les 59 combats en base :

| Reconstruction | Justesse | Pouvoir de classement (AUC) |
| --- | ---: | ---: |
| Stats de la carte seules (point de départ) | 76,3 % | 0,783 |
| + affixes d'équipement | 84,7 % | 0,873 |
| + cadence mesurée | 86,4 % | 0,892 |
| + niveau de type additif (au lieu de composé) | 85,2 % | 0,886 |
| + talents et multiplicateur de critique calibré (**retenu**) | **90,2 %** | **0,900** |

> La correction du niveau de type fait perdre un combat sur 61 — du bruit, pas un signal. On garde
> la formule mesurée plutôt que celle qui colle d'un cheveu de mieux à un échantillon court.

Les **dégâts par coup mesurés** ne sont volontairement *pas* utilisés : ils incluent les capacités
qui augmentent les dégâts en cours de combat (rage, frénésie, dernier carré) que le simulateur
réapplique ensuite, et les employer fait *baisser* le classement (0,892 → 0,869). Ils ne servent
que de repli pour un type dont le jeu ne sert pas encore la fiche.

> Ce qui n'est pas modélisé : renforts de famille, bonus intrinsèques des objets (non publiés par
> le jeu), capacités adverses mal documentées (coup de grâce, corruption) et la dispersion des
> tirages de dégâts.

Code de sortie : `0` si tout passe, `1` si un check échoue, si un combat n'a pas pu être téléchargé
ou **si un trou a été constaté dans l'historique** — utilisable tel quel en cron ou en CI :

```cron
# toutes les 6 heures : reprend les combats, relève les troupes, reprojette le reste
0 */6 * * *  cd ~/dev/sss && npm run update >> ~/sss.log 2>&1
```

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

### La reprise, et son seul point de fragilité

Le serveur n'expose **pas** de pagination : la vue renvoie une fenêtre fixe d'environ **30 lignes
par onglet** (tes derniers envoyés, tes derniers reçus), et `page` / `offset` / `before` sont
ignorés. On ne peut donc pas remonter plus loin que ce que le jeu affiche à l'instant T.

Comme le fichier **accumule**, un combat reste en base même après être sorti de la fenêtre : relancer
la commande régulièrement constitue l'archive complète au fil du temps. Mais l'inverse est vrai
aussi — **si tu fais plus de 30 combats entre deux passages, ceux du milieu sont perdus pour de
bon.** Le jeu ne les expose plus, aucun script ne peut les rattraper.

Le script ne se contente donc plus de télécharger : il tient un **repère de reprise** et il
**constate les trous**.

- `watermark` — l'id le plus récent en base pour chaque onglet. C'est de là que repart le passage
  suivant, et c'est affiché sur le tableau de bord.
- `window` — ce que la fenêtre du jeu couvrait au dernier passage (taille, id le plus ancien, id le
  plus récent, et combien de ses lignes étaient déjà en base).
- `runs` — le journal des 50 derniers passages : quand, combien listés, combien téléchargés,
  combien en échec. La reprise devient vérifiable au lieu d'être supposée.
- **Détection de trou** : si la fenêtre ne remonte plus jusqu'au dernier combat connu, le script
  l'écrit en clair (`trou dans l'historique « received » : le dernier combat connu est le 10 681,
  la fenêtre ne remonte qu'au 10 702`), l'enregistre dans `runs[].holes`, l'affiche en rouge sur le
  tableau de bord, et **sort en code 1** pour qu'un cron le remonte.

> En pratique : un passage par jour suffit si tu fais moins de 30 combats par jour, dans chaque
> sens. Au-delà, rapproche les passages — c'est la seule parade, et le tableau de bord te dira si
> tu es à la limite (`dont N déjà en base` proche de 0 = tu passes tout juste).

### Format de `data/fights.json`

```json
{
  "version": 2,
  "updatedAt": "2026-11-17T12:00:00.000Z",
  "account": "MonPseudo",
  "counts": { "total": 59, "sent": 28, "received": 31, "attack": 28, "defense": 31,
              "firstFightAt": 1794761239, "lastFightAt": 1794873754 },
  "watermark": { "sent": 10663, "received": 10681 },
  "window": { "sent": { "size": 30, "oldestId": 9513, "newestId": 10663, "alreadyKnown": 28 } },
  "runs": [{ "at": "…", "mode": "incremental", "listed": 59, "downloaded": 2, "failed": 0, "holes": [] }],
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

## Adversaires et équipements (`npm run enemies`, onglet Adversaires)

Un rapport de combat donne l'armée **complète des deux camps** : pour chaque pile, le type, la
quantité, les PV unitaires, le niveau de type, le rôle, la capacité — **et les trois pièces
d'équipement**, avec leurs affixes chiffrés. Tout ce qu'il faut pour suivre un adversaire est donc
déjà dans `data/fights.json` : aucune requête supplémentaire n'est faite au jeu.

`data/enemies.json` est une **projection** de `data/fights.json`, reconstruite intégralement à
chaque passage, dans l'ordre chronologique. C'est voulu : un bug de lecture se corrige en relançant
la commande, et deux passages de suite donnent le même fichier. Les combats, eux, continuent
d'accumuler — c'est eux la source.

Chaque joueur croisé (toi compris) y a une fiche :

| Champ | Contenu |
| --- | --- |
| `level`, `rating`, `fort` | bornes et historique daté — une entrée seulement quand la valeur change |
| `record` | combats, fois attaquant / défenseur, ton bilan contre lui |
| `observations` | **une entrée par combat** : son armée telle qu'elle était ce jour-là, pile par pile, équipement compris, avec les dégâts et la cadence **mesurés** dans la frise des coups. Rien n'est perdu |
| `changes` | seulement les combats où il a **changé de troupes** : type ajouté ou retiré, quantité, niveau de type, PV unitaires, pièce d'équipement remplacée, fortifications |
| `latest` | son dernier état connu, prêt à afficher |

Les lignes de `changes` sont écrites pour être lues telles quelles :

```
16/11 22:25  [quantité, équipement, niveau de type, PV unitaires]
    Bandit : 419 → 215 unités (-204)
    Bandit · porte-bonheur : Grandma's rosary · Commun → Golden horseshoe · Rare · +6,5 % dégâts
    Brute : niveau de type 2 → 4 (+4 % de vie et de dégâts)
    Brute : 6 661 → 7 263 PV par unité à équipement identique, soit +4,8 % au-delà du niveau de
            type — arbre de talents ou bonus de famille
```

Les quantités bougeant à chaque combat, une fiche distingue bien les deux : `observations` garde
tout, `changes` ne retient que ce qui s'est réellement déplacé, et dit lequel.

### Ce qu'un objet apporte, et ce que le jeu n'en dit pas (`docs/objets.md`)

Chaque troupe porte trois emplacements — une arme, une protection, un porte-bonheur. Un objet
apporte deux choses, dont le jeu n'expose clairement qu'une :

- des **affixes**, les bonus tirés à la forge. Le rapport les chiffre explicitement, sur cinq stats
  seulement : `dmg`, `hp`, `speed` en pourcentage, `crit` et `riposte` en points. C'est ce que le
  script exploite ;
- un **bonus intrinsèque**, celui de l'objet et de sa rareté, que le jeu n'écrit nulle part. Il est
  pourtant mesurable : à type et niveau de type constants, passer d'un *Leather* à un *Reinforced
  suit* fait monter les PV unitaires d'un Lascar de 3 508 à 4 212, et les piles portant un affixe de
  vitesse frappent ~10 % plus vite alors que l'affixe n'en promet que 1 à 6,5 %. Il n'est donc
  **pas modélisé** — on s'appuie sur ce qui est mesuré à la place (voir ci-dessous).

`data/items.json` + `docs/objets.md` cataloguent tout l'équipement croisé : 28 objets à ce jour,
par emplacement, avec les raretés et les **bornes d'affixes observées** pour chacune. Une
Peu commune ne porte aucun affixe, une Rare en porte un, une Épique deux, une Légendaire trois.

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
src/fights.mjs    listes → détails → fusion incrémentale, repère de reprise, détection de trous
src/enemies.mjs   projection des combats → fiches d'adversaires et historique de leurs troupes
src/gear.mjs      modèle d'équipement : affixes, raretés, catalogue d'objets, docs/objets.md
src/troops.mjs    cartes du shop → data/troops.json + docs/troupes.md (niveau et XP de type)
src/skills.mjs    arbre de talents → data/skills.json (sépare talents et équipement)
src/rules.mjs     règles publiques → docs/regles.md (sans navigateur)
src/analyse.mjs   lecture des rapports de combat : tout le mesuré
src/sim.mjs       moteur de combat (avec trace du déroulé), backtest, recherche de compositions
src/server.mjs    serveur local de l'interface (http + SSE, sans dépendance)
src/explore.mjs   dump des réponses brutes (debug)
src/index.mjs     CLI
web/              l'interface (index.html, style.css, app.js)
docs/             documents générés (versionnés)
data/             l'archive : fights.json (source), enemies.json + items.json (projections),
                  troops.json et skills.json (relevés de compte)
```

Les fichiers de `data/` ne sont **pas** dans Git (`.gitignore`) : ils contiennent l'activité de ton
compte. `fights.json` est la seule source irremplaçable — `enemies.json`, `items.json` et
`docs/objets.md` se reconstruisent d'un `npm run enemies`. Pense à sauvegarder `data/fights.json`.
