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
npm run hq         # ressources, bâtiments, niveau, points de compétence → data/hq.json
npm run report     # compte rendu Markdown pour un agent IA → docs/rapport.md (sans connexion)
npm run assets     # images du jeu (troupes, objets, avatars) → data/assets/ (sans connexion)
npm run analyse    # bilan + compositions dans le terminal → out/analysis.json
npm run explore    # dépose les réponses brutes du jeu dans data/raw/ (debug)
```

Seuls `update`, `check`, `fights`, `troops`, `skills`, `hq` et `explore` ouvrent un navigateur et
se connectent. `enemies`, `analyse` et `report` ne lisent que des fichiers, `rules` et `assets`
n'interrogent que des URLs publiques — relance-les autant que tu veux.

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
| *(barre du haut)* | tes ressources, toujours visibles, avec leur jauge de remplissage |
| **Le QG** | ressources, bâtiments, niveau, points de compétence — et l'export Markdown pour un agent IA |
| **Analyse des combats** | bilan, rendement par type, capacités gaspillées, vivier adverse, équipement comparé, fiabilité du simulateur |
| **Adversaires** | une fiche par joueur croisé : son armée, ses objets, l'historique daté de ses changements de troupes |
| **Simulateur** | un duel contre un adversaire réel : rejoue un combat ou éprouve une composition montée à la main |
| **Compositions** | les meilleures compositions trouvées, comparées à celle que tu as en ligne |
| **Arsenal** | chaque objet × rareté : affixes observés, **bonus caché estimé**, et le classement « que forger en priorité » |
| **Les règles / Les troupes / Les objets** | les documents générés, rendus avec sommaire latéral et recherche |

**Un seul geste touche au jeu** : le bouton *Mettre à jour*, qui ouvre Chromium, se connecte,
reprend les combats manquants, relève tes troupes, puis reconstruit les fiches d'adversaires et le
catalogue d'objets. Tous les autres écrans se calculent hors ligne, à partir de `data/`, et se
remplissent seuls à la première visite — il n'y a plus de bouton « Analyser » à cliquer avant de
voir quelque chose. Une seule tâche tourne à la fois, et son avancement part en Server-Sent Events
vers la page (panneau **Journal**). Les actions au grain fin (combats seuls, troupes seules,
reconstruire les fiches, tout retélécharger) sont repliées sous *Actions détaillées*.

## Analyse des combats (`npm run analyse`, onglet Analyse)

Tout vient des rapports de combat (`detail.fight.report`) **croisés avec le journal rédigé**
(`/play/view/fightlog`), une fois le format décodé :

- `events` est la frise complète du combat, un tableau par coup :
  `[t, camp, typeAttaquant, typeCible, dégâts, X, riposte]`. `t` est en **centièmes de seconde**
  (`result.cs` = durée du combat dans la même unité). Le champ `X` ressemble aux unités vivantes
  mais n'est **pas fiable** (il vaut parfois 0 alors que la pile a perdu la moitié de ses unités) :
  la vérité terrain, c'est le `×N` du journal rédigé.
- La comptabilité exacte, vérifiée à l'unité près sur ~4 900 coups :
  `vivants = ceil(PV restants ÷ PV unitaires)`, les KO d'un coup sont la différence de ce `ceil`
  avant/après, et les dégâts valent
  `vivants × tirage uniforme(min…max) × (critique ? ×1,5 à ×2,5) × (1 − fort/100)`.
- **Une pile frappe à intervalle constant** `round(vitesse × 100)` centièmes — seul le premier coup
  est tiré au sort, entre 0,90 et 1,00 × l'intervalle. La frénésie et le dernier carré divisent
  l'intervalle par 1,5, temporairement. Le reste du déroulé est entièrement déterminé par le seed
  du serveur (chaque rapport en contient un ; le générateur n'a pas été identifié).
- **La riposte** se déclenche avec la probabilité « riposte % » de la cible ; les unités qui
  ripostent valent `min(vivants de la cible, vivants de l'attaquant)` — vérifié sur 1 265
  ripostes — à 60 % d'un tirage normal, et n'est **jamais critique** (0 sur 1 346).
- **Le bouclier est un pool commun à l'armée** : 8,00 % des PV de *départ* (pas du max), consommé
  avant les PV quel que soit le groupe touché — le montant servi par le jeu tombe à l'unité près.
- `abNeed` / `abOn` donnent le seuil d'activation retenu par le serveur (10 % des places) et les
  capacités qui ont **réellement** fonctionné. C'est la mesure la plus utile : elle dit quelles
  capacités une composition paie sans les utiliser.
- Les seuils et amplitudes mesurés des capacités : rage sous 50 % des PV max (×1,350 pendant 10 s),
  second souffle sous 30 % (chaque pile récupère `min(12 % de ses PV de départ, retour à ses PV de
  départ)` — montants exacts), onde de choc quand l'adversaire a perdu 30 % de ses PV de *départ*
  (chaque pile adverse perd le même pourcentage de ses PV courants ; total ≈ 10 % des PV courants du
  camp lanceur × (1 − fort)), embuscade à 40 % de la puissance (critique possible), frénésie ×1,5
  pendant 2 s.

Trois résultats contre-intuitifs sortent de l'historique :

- **Le triangle des rôles n'agit pas sur les dégâts.** À rôle d'attaquant donné, les dégâts par
  unité ne dépendent pas du rôle de la cible (écarts < 2 % sur 1 798 coups). Le ciblage n'est pas
  non plus orienté par le rôle : la cible est tirée au sort, pondérée par les PV restants.
- **En défense, les piles démarrent souvent sous leurs PV max** (récupération inachevée, plancher du
  poste de garde) ; un attaquant part presque toujours à 100 %. C'est la première cause des défaites
  en défense, loin devant la composition.
- **Les talents de dégâts adverses sont invisibles dans les stats servies** — les PV unitaires
  contiennent l'équipement d'en face, pas ses talents d'attaque. Le journal les trahit : le rapport
  entre dégâts mesurés et dégâts expliqués par la carte est la signature de ses talents, stable d'un
  combat à l'autre (×0,65 à ×1,5 selon le joueur). L'onglet Analyse les affiche par adversaire.

## Le simulateur (onglet Simulateur)

Un duel joué coup par coup contre un adversaire **réel** de ton historique — son armée exacte, son
équipement, ses fortifications, telles que le rapport de combat les donne. Deux usages :

- **rejouer un combat** en changeant de composition : « et si j'avais aligné ça ce jour-là ? ».
  Si tu ne touches à rien, le rejeu est fidèle (piles reconstruites avec leurs PV réels d'alors) et
  la page compare le verdict simulé au résultat qui s'est vraiment produit ;
- **éprouver une composition** montée de toutes pièces : un curseur et un champ par type, la jauge
  des places, le seuil des capacités affiché en direct (un type sous 10 % des places porte sa
  capacité sans qu'elle agisse — le badge le dit).

> Les places de troupes sont un **budget commun** : 875 places, ce n'est pas 875 par type. Chaque
> curseur s'arrête donc à ce qui reste une fois les autres types servis. Quand tout est distribué,
> un type ne peut plus que baisser — pour en renforcer un, il faut d'abord en dégarnir un autre,
> exactement comme en jeu.

L'écran tient **dans la hauteur de l'écran**, en trois étages : la recherche d'adversaire avec le
rôle, la forme des troupes et le bouton de lancement en pleine largeur — la liste des combats ne
s'ouvre qu'à la saisie (ou au bouton ▾), en surcouche, et se referme dès qu'on a choisi ; la fiche de l'adversaire
choisi juste en dessous, pleine largeur elle aussi ; puis deux colonnes — ma composition à gauche,
le résultat à droite — qui défilent chacune sur elle-même. Lancer un combat n'oblige jamais à
faire défiler la page (vérifié de 1280×720 à 1920×1080) : le verdict, les chiffres clés et la
courbe sont là immédiatement, et les détails (pile par pile, capacités, bilan contre tout
l'historique, export IA, méthode) vivent dans des **onglets** qui se remplacent dans la même zone
au lieu de s'empiler.

Ce que tu obtiens : la **probabilité de victoire** (le duel joué 600 fois avec de vrais tirages),
la marge et la durée avec leur fourchette, la **courbe des PV des deux camps** (la passe la plus
typique des 600) avec les capacités en repères, le détail pile par pile, la frise des capacités
déclenchées — et, pour éviter de conclure sur un seul duel, le bilan de la même composition
**contre les combats archivés**.

Depuis l'onglet Compositions, chaque proposition a un bouton *Essayer dans le simulateur* qui la
charge directement.

### Changer l'équipement d'un type

Chaque ligne de type porte, juste à côté de son portrait, les **trois pièces qu'il équipe** —
arme, protection, porte-bonheur. Les survoler donne leurs stats (affixes exacts et bonus caché
estimé), un clic ouvre la liste des pièces connues pour cet emplacement, **classée par ce qu'elle
apporte** ; un second clic la met en jeu. Une pastille verte signale une pièce remplacée, et
*↩ équipement d'origine* revient en arrière.

Le calcul est fait **en delta** depuis l'équipement réellement porté — même équipement = exactement
les stats de la carte — en appliquant les affixes exacts et le **bonus intrinsèque estimé** de
l'arsenal. Un type jamais vu en combat n'est pas modifiable (son équipement porté est inconnu,
donc le point de départ du delta le serait aussi).

> **Les noms d'objets sont en français** (« Poing américain », « Combinaison renforcée »). Le jeu
> les sert dans la langue du compte, et ce compte joue en anglais : la table de traduction vit dans
> `src/gear.mjs` (`ITEM_FR`). Si tu passes ton compte en français, les noms servis par le jeu
> reprennent automatiquement la main — ils font alors autorité.

## L'arsenal (onglet Arsenal)

Le jeu publie les affixes d'un objet mais pas son **bonus propre** — pourtant un bandit vaut
+10 % de PV en Leather jacket et +37 % en Bomb suit, à niveau égal. L'onglet Arsenal l'estime par
recoupement de l'archive : chaque pile observée donne un résidu (PV servis ÷ expliqué, tirages
mesurés ÷ expliqué), séparé en « talents du joueur » × « bonus des objets » par médianes
alternées, l'échelle étant recalée sur mes propres cartes (vérité terrain). Vie → protections,
dégâts → armes ; le bonus propre des porte-bonheur n'est pas isolable (seuls leurs affixes
comptent) et la vitesse par pièce, trop incertaine, est affichée à titre indicatif sans jamais
entrer dans un calcul.

Le bouton **« Que forger en priorité ? »** rejoue tout l'historique avec chaque pièce candidate à
la place de l'actuelle (affixes à la médiane des bornes observées) et classe par probabilité de
victoire au Monte-Carlo — avec l'écart chiffré contre la composition actuelle.

### Pourquoi le verdict est une probabilité

Le moteur (`src/engine.mjs`) rejoue les **mécaniques exactes du jeu** — intervalles déterministes,
tirages uniformes min…max, critiques, ripostes, ciblage pondéré par les PV, boucliers en pool,
seuils et amplitudes mesurés — mais le jeu tire les dégâts et les critiques **au hasard**, avec un
seed serveur qu'on ne peut pas prédire. L'archive en contient la preuve directe : les combats
**11055** et **11060** opposent exactement les mêmes armées, avec les mêmes fortifications et les
mêmes capacités — l'un est gagné, l'autre perdu.

Le simulateur joue donc chaque duel en **Monte-Carlo** (600 passes seedées, reproductibles) et
annonce la part de victoires. Entre 25 % et 75 %, il affiche **« Trop serré »** plutôt que de
désigner un vainqueur. En face, il rappelle la lecture historique : parmi tes combats passés à
marge simulée comparable, combien ont été réellement gagnés.

## Recherche de compositions (onglet Compositions)

`src/sim.mjs` cherche la meilleure composition en deux temps : un criblage **déterministe** (mode
« espérances » du moteur : chaque tirage remplacé par sa moyenne — deux compositions se comparent
sans bruit), puis un **Monte-Carlo** sur les finalistes qui affiche leur vraie part de victoires,
tirages compris.

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

**Le multiplicateur de critique** n'est plus deviné : le journal de combat marque les coups
critiques, et le rapport entre les tirages critiques et normaux d'une même pile dans un même combat
le **mesure** directement — ×1,98 pour moi (talent *Executioner* : la prime passe de +50 % à
+100 %, donc ×2,0), ×1,5 en face par défaut. Les adversaires dont les journaux montrent ×2,0 sont
détectés individuellement et simulés avec.

### Comment une pile adverse est reconstruite

Quatre sources, chacune à sa place :

1. **servi par le serveur** — les PV unitaires. Équipement, talents de vie et bonus de famille d'en
   face y sont déjà ;
2. **mesuré dans la frise des coups** — la cadence EXACTE de la pile (mode des écarts entre coups,
   en centièmes : l'intervalle est constant). Elle intègre les bonus de vitesse intrinsèques des
   objets, que le jeu ne publie pas ;
3. **carte du shop + équipement relevé** — les stats **de base** du type au niveau de type de la
   pile, plus les affixes de ses trois pièces ;
4. **appris dans ses journaux** — le facteur de dégâts du joueur (ses talents d'attaque, invisibles
   dans les PV), son taux de critique, son taux de riposte et son multiplicateur critique, mesurés
   sur ses combats passés. En backtest, le combat rejoué est exclu de sa propre mesure
   (**leave-one-out**) pour ne pas gonfler le score.

Fiabilité obtenue sur les 68 combats en base, informations d'avant-combat seulement :
**justesse 85,3 %** (attaque 93,5 %, défense 78,4 %), **AUC 0,91**, **score de Brier 0,13**
(0 = parfait, 0,25 = pile ou face) — et les durées simulées collent enfin aux vraies
(médiane 1,06× la durée réelle).

Les **dégâts par coup bruts** (`dpuPerHit`) ne servent que de repli pour un type sans fiche : ils
incluent rage et frénésie que le moteur réapplique ensuite. La mesure propre (`rollMedian`) exclut
critiques, ripostes, embuscades, fenêtres de rage et coups absorbés par un bouclier.

> Ce qui n'est pas modélisé : renforts de famille, objets que tu pourrais forger, capacités jamais
> croisées en combat (gel du temps, intimidation, forteresse, dernier carré, coup de grâce, renvoi,
> corruption — encodées depuis les règles), et le résidu ±20 % de l'onde de choc.

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
3. **Journal** — `GET /play/view/fightlog?id=<id>` donne le déroulé tel que le jeu le rédige. Il
   porte deux choses que le JSON ne donne **pas** : quels coups ont été **critiques**, et combien
   d'unités chaque coup a mises **KO**. Il est converti en lignes structurées (~12 Ko au lieu des
   72 Ko de HTML) et stocké avec le combat. Les combats déjà en base sont rattrapés par lots de 40
   par passage, du plus récent au plus ancien.
4. **Fusion** — chaque run ne télécharge que les ids absents de `data/fights.json`. Relancer la
   commande à tout moment ne récupère donc que les nouveaux combats.

Dans l'onglet **Analyse des combats**, cliquer **n'importe où sur la ligne** d'un combat ouvre son
journal coup par coup, avec les deux armées, les capacités déclenchées et les coups critiques.

La fiche d'un combat porte aussi un bouton **« Copier pour un agent IA »** (et son jumeau
*Télécharger .md*) : tout le combat en Markdown — issue, les deux armées pile par pile avec leur
équipement, les talents adverses mesurés, le journal coup par coup, l'avis du simulateur
(probabilité du combat rejoué, meilleure composition possible) et les limites connues — prêt à
coller dans une conversation pour demander *pourquoi, et quoi changer*. Servi aussi directement sur
`/api/fight.md?id=<id>`. Un résultat de **simulation** s'exporte de la même façon depuis l'onglet
Simulateur.

La fiche porte enfin un bouton **« Trouver la meilleure composition »** : toutes les
combinaisons de types sont jouées contre *ce* combat précis (même adversaire, mêmes murs, et en
défense la forme réelle de tes troupes ce jour-là), les finalistes départagés au Monte-Carlo. Le
podium s'affiche avec sa probabilité de victoire, comparé à ce que tu avais engagé et à ta
composition actuelle — et chaque proposition se rejoue d'un clic : **« Simuler ce duel
maintenant »** précharge le simulateur sur ce combat avec cette composition et lance le duel.
Quand aucune composition ne gagne, la page le dit en face — et chiffre ce qu'auraient changé des
troupes soignées.

Les sous-pages ont leur propre adresse — `#combat/11086`, `#adversaire/199` — donc un lien se
partage, le bouton du navigateur marche, et le bouton **Retour** rend la liste à la position où on
l'avait laissée.

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

## Le quartier général (`npm run hq`, onglet Le QG)

Deux sources, toutes deux ouvertes par la session : `GET /play/state` pour le joueur (ressources,
capacités, production, niveau et XP, points de compétence, attaques restantes, famille, rang) et
`GET /play/buildings` pour la ville — chaque bâtiment posé, avec son niveau, son maximum, ses PV
et le chantier en cours s'il y en a un.

Comme le reste, `data/hq.json` **accumule** : un point d'historique s'ajoute dès qu'une valeur
suivie change (niveau, classement, points libres, nombre de bâtiments). On voit donc sa progression
sans avoir rien eu à prévoir.

L'écran signale les deux choses qui coûtent sans se voir : les **points de compétence non
dépensés** et les **stocks au plafond**, où toute production supplémentaire est perdue.

## Le compte rendu pour un agent IA (`npm run report`)

Un seul document Markdown qui rassemble tout : QG, ressources, bâtiments, troupes avec leur XP de
type, arbre de talents, équipement comparé au leur, bilan de combat, vivier adverse et compositions
proposées. À télécharger ou à copier depuis l'onglet **Le QG**, ou à récupérer directement sur
`http://127.0.0.1:4173/api/report.md`.

Il est écrit pour être *lu par un modèle*, ce qui impose trois règles :

- **des chiffres déjà agrégés**, pas un vidage de 2 Mo de JSON — l'agrégation est le travail qu'un
  modèle fait mal et qu'on a déjà fait ici ;
- **ce qui est mesuré est annoncé comme tel**, ce qui est modélisé aussi, avec la fiabilité du
  simulateur chiffrée ;
- **une section « limites connues »** en clair. Un agent qui ignore ce qu'il ne sait pas donne de
  mauvais conseils avec aplomb.

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

## Les images du jeu (`npm run assets`)

L'interface affiche les vignettes des troupes, les icônes d'objets et les photos de profil des
joueurs. Elles sont **copiées en local**, pas chargées depuis le site : une page qui pointe vers le
jeu ne s'afficherait pas hors ligne, et signalerait au serveur chaque consultation de ton tableau de
bord.

Tout est servi en clair par le jeu, sans session — un `fetch` suffit, comme pour les règles.

| Dans `data/assets/` | Quoi |
| --- | --- |
| `units/<clé>.webp` | le portrait entier d'un type, pour sa fiche |
| `units/face/<clé>.webp` | la vignette, pour une ligne de tableau |
| `avatars/<fichier>.webp` | la photo de profil d'un joueur |
| `icons.svg` | le sprite complet : les 30 icônes d'objets y sont des `<symbol>` |

82 fichiers, 1,5 Mo. Le téléchargement est **incrémental** comme le reste : un fichier déjà présent
n'est pas redemandé, `npm run assets -- --force` reprend tout.

Deux détails qui comptent :

- les **avatars portent un condensat** dans leur nom (`94-e98ac806d605a596.webp`). Quand quelqu'un
  change de photo, c'est un nouveau fichier : rien à invalider, et l'ancienne reste disponible pour
  les combats d'alors ;
- les **icônes d'objets sont monochromes** (`fill="currentColor"`) et vivent toutes dans un seul
  sprite. Une requête au lieu de trente, et l'interface les **teinte par rareté** en CSS — vert
  pour Rare, violet pour Épique, ambre pour Légendaire.

Les **21 types sont téléchargés d'avance**, y compris ceux que ton personnage n'a pas encore
débloqués : leurs images existent déjà côté serveur, autant éviter que l'interface se troue en
montant de niveau.

Rien de tout ça n'est dans Git (`data/` est ignoré) : ce sont les images du jeu, en cache local
pour ton usage.

> Une image absente ne casse jamais l'affichage : la vignette disparaît, l'avatar retombe sur
> l'initiale du pseudo. L'interface reste entièrement lisible sans aucune image.

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
src/assets.mjs    images du jeu → data/assets/ (sans navigateur, URLs publiques)
src/rules.mjs     règles publiques → docs/regles.md (sans navigateur)
src/analyse.mjs   lecture des rapports de combat : tout le mesuré
src/arsenal.mjs   bonus intrinsèques des objets (estimés par recoupement), équipement porté, deltas
src/engine.mjs    le moteur de combat : mécaniques exactes du jeu, mode espérance + Monte-Carlo seedé
src/sim.mjs       reconstruction des armées, mesures apprises par adversaire, backtest, compositions
src/server.mjs    serveur local de l'interface (http + SSE, sans dépendance)
src/explore.mjs   dump des réponses brutes (debug)
src/index.mjs     CLI
web/              l'interface (index.html, style.css, app.js)
docs/             documents générés (versionnés)
data/             l'archive : fights.json (source), enemies.json + items.json (projections),
                  troops.json et skills.json (relevés de compte), assets/ (images)
```

Les fichiers de `data/` ne sont **pas** dans Git (`.gitignore`) : ils contiennent l'activité de ton
compte. `fights.json` est la seule source irremplaçable — `enemies.json`, `items.json` et
`docs/objets.md` se reconstruisent d'un `npm run enemies`. Pense à sauvegarder `data/fights.json`.
