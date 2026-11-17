# Audit du dépôt — 17 novembre 2026

Audit mené contre l'objectif annoncé du dépôt :

> à tout moment je peux fetcher l'historique de mes combats et ça s'enregistre sur mon PC ; quand
> je relance un fetch, il continue d'où il s'est arrêté. Je veux aussi enregistrer chaque ennemi
> avec ses troupes et historiser quand il change de troupes, en tenant compte des troupes **et de
> leurs objets**.

Tout ce qui suit a été vérifié sur les données réelles du dépôt : 61 combats, 18 adversaires,
501 piles, 490 pièces d'équipement, et l'arbre de talents du compte relevé en jeu.

Le §4 bis a été ajouté après coup, en réponse à la question « le niveau des unités est-il pris en
compte partout ? ». Il a mené à une visite directe du jeu, qui a ouvert deux vues jamais lues
jusqu'ici (`/play/view/skills`, `/play/view/inventory`) et corrigé deux erreurs de modèle.

---

## Verdict en une page

| | État avant | État après |
| --- | --- | --- |
| Reprise incrémentale | **fonctionnait**, mais invérifiable et silencieuse en cas de perte | repère de reprise, journal des passages, détection de trous, code de sortie 1 |
| Fiches d'adversaires | **absentes** | `data/enemies.json` — une fiche par joueur, un relevé par combat |
| Historique des troupes adverses | **absent** | `changes[]` daté, ligne à ligne, lisible tel quel |
| Objets | relevés dans le JSON brut, **jamais exploités ni affichés** | catalogue, affichage par pile, intégration au simulateur |
| Simulateur | justesse 76,3 % · AUC 0,783 | **86,4 % · 0,892** (mesuré, cf. ci-dessous) |
| Interface | 6 boutons, 3 écrans vides tant qu'on n'a pas cliqué | 1 bouton, tous les écrans se remplissent seuls |
| Simulateur | moteur sans trace, aucun écran pour le piloter | duel jouable, déroulé visible, composition éditable |
| Niveau de type | stocké mais ignoré par les analyses, mal modélisé par le simulateur | formule corrigée, XP suivie, agrégats conscients du niveau |
| Talents du personnage | **jamais relevés** — confondus avec l'équipement | `data/skills.json`, 45 nœuds décodés, appliqués au simulateur |

> Le simulateur est passé de **76,3 % à 90,2 %** de justesse (AUC 0,783 → 0,900) au fil de cet
> audit. Chaque palier est mesuré par ablation, pas supposé — détail au §4.

---

## 1. La reprise incrémentale : correcte, mais elle ne se vérifiait pas

**Ce qui marchait déjà.** `syncFights()` ne télécharge que les ids absents de `data/fights.json`,
l'écriture est atomique (`writeJson` passe par un `.tmp` + `rename`), et le fichier accumule — un
combat sorti de la fenêtre du jeu reste en base. La promesse « relance et ça continue » était tenue.

**Le problème réel, et il est sérieux.** Le serveur du jeu ne pagine pas : il sert une fenêtre fixe
d'environ 30 lignes par onglet. Vérifié sur `data/raw/view-fights.html` — 30 lignes, aucun lien de
pagination, et `page` / `offset` / `before` ignorés. Donc :

> **Si tu fais plus de 30 combats entre deux passages, ceux du milieu sont perdus définitivement.**

Et le script, avant, ne le disait pas. Il téléchargeait ce qu'il voyait, annonçait « 2 combats
téléchargés », et le trou passait inaperçu. La trace existe déjà dans tes données : `counts` montre
31 combats reçus alors que la fenêtre n'en expose que 30 — un est déjà tombé hors fenêtre.

**Corrigé** (`src/fights.mjs`) :

- `watermark` — l'id le plus récent en base par onglet, c'est le repère de reprise ;
- `window` — ce que la fenêtre couvrait au dernier passage, et combien de ses lignes étaient déjà
  connues (`alreadyKnown` proche de 0 = tu passes tout juste) ;
- `runs[]` — journal des 50 derniers passages ;
- **détection de trou** : si la fenêtre ne remonte plus jusqu'au dernier combat connu, c'est écrit
  en clair dans le terminal, enregistré dans `runs[].holes`, affiché en rouge sur le tableau de
  bord, et le processus **sort en code 1** pour qu'un cron le remonte.

**Ce qui reste à ta main.** Aucun code ne peut rattraper un combat que le jeu n'expose plus. La
seule parade est la fréquence. Un cron toutes les 6 h est dans le README.

### Autres points sur `fights.mjs`

| Point | Gravité | État |
| --- | --- | --- |
| `counts` comptait par onglet (`sent`/`received`) alors que le rôle réel est dans le rapport | cosmétique | corrigé — `attack`/`defense` ajoutés, plus `firstFightAt`/`lastFightAt` |
| `parseRows()` exige une page Playwright vivante : impossible de rejouer un HTML de `data/raw/` hors ligne | faible | **non corrigé** — le DOM du navigateur est un bon choix pour parser du HTML, mais ça interdit un mode « rejeu ». À revoir seulement si le balisage du jeu change et qu'il faut déboguer |
| `resolveDirections()` fait un appel `view('fights')` de plus à chaque passage | négligeable | laissé tel quel : lire les onglets servis vaut mieux que les deviner |

---

## 2. Les adversaires : tout était déjà là, rien n'était exploité

Un rapport de combat (`detail.fight.report`) contient l'armée **complète des deux camps**. Pour
chaque pile : `key`, `qty`, `unitHp`, `level` (niveau de type), `role`, `ability`, `owner` (renfort
de famille), `dealt`, **et `gear[]`** — les trois pièces d'équipement avec leurs affixes chiffrés.
Plus `events[]`, la frise coup par coup.

Autrement dit : **suivre un adversaire ne demande aucune requête supplémentaire au jeu.** Tout est
déjà sur ton disque, dans les 2,3 Mo de `data/fights.json`. Rien n'en sortait.

**Ajouté** : `src/enemies.mjs` projette `fights.json` vers `data/enemies.json`.

**Choix de conception à connaître : c'est une projection, pas un second journal.** Le fichier est
reconstruit *intégralement* à chaque passage, dans l'ordre chronologique. Conséquences voulues :

- un bug de lecture se corrige en relançant `npm run enemies`, sans rien perdre ;
- deux passages de suite donnent le même fichier (idempotent) ;
- la seule source irremplaçable reste `data/fights.json` — c'est le seul fichier à sauvegarder.

**Deux granularités**, parce qu'elles ne répondent pas à la même question :

- `observations[]` — une entrée par combat, l'armée telle qu'elle était ce jour-là. Rien n'est
  perdu, c'est la matière première ;
- `changes[]` — seulement les combats où l'adversaire a **changé de troupes**.

La distinction est nécessaire : les quantités bougent à presque chaque combat (pertes, recrutement).
Historiser « il a changé » à chaque fois n'aurait rien dit. `changes[]` nomme ce qui a bougé —
`type ajouté`, `type retiré`, `quantité`, `niveau de type`, `équipement`, `PV unitaires`,
`fortifications` — et écrit la ligne en clair.

Deux pièges rencontrés et traités, parce qu'ils produisaient du bruit :

1. **La fortification n'existe qu'en défense.** Comparer naïvement deux relevés faisait clignoter
   « 0 % → 16 % → 0 % » à chaque fois que l'adversaire changeait de rôle. La comparaison se fait
   maintenant contre le dernier relevé **défensif**.
2. **Le niveau de type explique déjà +2 % de PV par palier.** Une ligne « 6 586 → 6 710 PV » juste
   après « niveau de type 4 → 5 » n'apprend rien. On ne signale désormais que le **résidu** —
   celui qui, lui, dit vraiment quelque chose : « +4,8 % au-delà du niveau de type, donc arbre de
   talents ou bonus de famille ».

Résultat sur tes données : 18 adversaires, 118 relevés d'armée, **71 changements de troupes datés**.

---

## 3. Les objets : la plus grosse donnée inexploitée du dépôt

490 des 501 piles portent trois pièces d'équipement. Relevé complet :

- **3 emplacements** — arme, protection, porte-bonheur ;
- **28 objets** distincts ;
- **6 raretés** — Commun (0) à Exotique (5) ;
- **5 stats d'affixe** et pas une de plus — `dmg`, `hp`, `speed` en %, `crit` et `riposte` en points.

### Ce que le jeu publie, et ce qu'il cache

Un objet apporte deux choses. Le rapport ne chiffre que la première.

**Les affixes** sont explicites (`+2 pts crit`, `+4 % damage`). Le nombre d'affixes suit la rareté,
c'est net sur tes données : Peu commun 0, Rare 1, Épique 2, Légendaire 3.

**Le bonus intrinsèque** de l'objet — celui qui vient de la pièce et de sa rareté — n'est écrit
nulle part. Il est pourtant parfaitement mesurable, et c'est une trouvaille de cet audit :

> Même Lascar, même niveau de type 3, aucun affixe de vie sur les trois pièces :
> *Leather* → **3 508 PV**, *Ballistic helmet* → **3 860 PV**, *Reinforced suit* → **4 212 PV**.
>
> Et sur les 396 piles ayant frappé au moins 4 fois : celles qui portent un affixe de vitesse
> frappent **10 % plus vite** que les autres (0,90 × la cadence de la carte contre 1,05)… alors que
> l'affixe n'en promet que 1 à 6,5 %.

Conclusion retenue à ce stade : **ne pas modéliser ce bonus caché**, et s'appuyer sur ce qui est
mesuré à la place. C'est ce qui a guidé la reconstruction des piles (§4).

> **Mise à jour.** Le §4 bis revient là-dessus. Une fois l'arbre de talents relevé, on sait que
> les talents n'apportent aucun PV sur ce compte : tout l'écart de PV d'un type équipé lui est
> donc imputable, et le bonus intrinsèque devient lisible type par type (Lascar +31,5 %,
> Brute +24,5 %, Bandit +20,5 %, Racaille +19,0 %). Il reste non modélisé dans le simulateur,
> mais il n'est plus hors de portée.

**Ajouté** : `src/gear.mjs` (modèle d'équipement), `data/items.json` (catalogue avec bornes
d'affixes observées par rareté), `docs/objets.md` (le document lisible), et l'affichage de
l'équipement pile par pile dans l'onglet Adversaires.

---

## 4. Le simulateur : il ignorait l'équipement des deux côtés

**Ce qui n'allait pas.** Pour reconstruire une pile adverse, `sim.mjs` prenait les stats **réelles**
de *ta* carte du shop — qui incluent *tes* talents et *ton* matériel — puis mettait les dégâts à
l'échelle par le rapport des PV unitaires. Deux conséquences :

- le critique, la riposte et la vitesse d'en face étaient **les tiens**, quels que soient ses objets ;
- la part de ses PV due à un affixe de vie était recyclée en dégâts, ce qui n'a pas de sens.

**Corrigé** (`pileStats()` dans `src/sim.mjs`) — trois sources, chacune à sa place :

1. **servi par le serveur** — les PV unitaires (équipement et talents d'en face y sont déjà) ;
2. **mesuré dans la frise des coups** — la cadence réelle de la pile ;
3. **carte du shop + affixes relevés** — les stats **de base** du type (`cardStats(card, {base:true})`,
   ajouté pour ça), au niveau de type de la pile, puis `applyGear()`.

**Ce que ça vaut, mesuré par ablation sur les 59 combats :**

| Reconstruction | Justesse | AUC | En attaque | En défense |
| --- | ---: | ---: | ---: | ---: |
| Stats de la carte seules (avant) | 76,3 % | 0,783 | 0,833 | 0,745 |
| + affixes d'équipement | 84,7 % | 0,873 | 0,956 | 0,852 |
| + cadence mesurée (**retenu**) | **86,4 %** | **0,892** | 0,950 | 0,861 |

**Une tentation écartée, et c'est volontaire.** Utiliser les *dégâts par coup mesurés* paraissait
évident. Mesuré : ça fait **baisser** le pouvoir de classement (0,892 → 0,869). La raison est
mécanique — le `dpuPerHit` observé inclut les capacités qui gonflent les dégâts en cours de combat
(rage, frénésie, dernier carré), que le simulateur réapplique ensuite. On les compterait deux fois.
Ils ne servent donc que de **repli** pour un type dont le jeu ne sert pas encore la fiche (aucun
aujourd'hui, mais ça viendra en montant de niveau — et sans ce repli, ce type aurait valu 0 dégât).

> La même mise en garde qu'avant reste valable : ce chiffre sert à **classer** des compositions,
> pas à promettre un résultat.

---

## 4 bis. Le niveau de type et les talents — seconde passe

Question posée après coup : *le niveau des unités est-il pris en compte partout ?* Réponse courte :
il l'était à trois endroits sur quatre, et mal au quatrième. Détail, et ce qui a été corrigé.

### a. Où le niveau de type était pris en compte, et où il ne l'était pas

| Endroit | Avant | Après |
| --- | --- | --- |
| `analyse.mjs` — lecture d'une pile | stocké (`typeLevel`) | inchangé |
| `analyse.mjs` — « Rendement de mes types », « Vivier adverse » | **ignoré** : les dégâts/unité et PV/unité cumulaient des combats menés à des niveaux différents | amplitude publiée (`min`, `max`, `last`, écart de puissance) et colonne « Niv. type » dans les deux tableaux |
| `sim.mjs` — reconstruction d'une pile | pris en compte, **mais avec la mauvaise formule** | corrigé (voir ci-dessous) |
| `recommend()` — compositions futures | pris en compte implicitement (les stats de la carte sont au niveau courant) | inchangé — c'est le choix honnête : on ne promet pas la progression à venir |
| `enemies.mjs` | pris en compte et historisé | inchangé |

Sur ton historique, l'amplitude n'est pas négligeable : ton Bandit a été engagé du niveau 1 au
niveau 3 (+4 % de puissance), et les Bandits d'en face du niveau 1 au niveau 5 (+8 %). Un
« dégâts par unité » cumulé mélangeait tout ça sans le dire.

### b. La formule était fausse : additive, pas composée

Les règles disent « +2 % de vie et de dégâts par niveau » sans préciser si les paliers se
composent. J'avais codé `1,02^Δ`. C'est faux.

La vérification est directe : en déduisant le facteur « talents + matériel » depuis la carte du
shop, il doit rester **constant** d'un niveau à l'autre pour un même type et un même équipement.

| Type | Facteur déduit, modèle additif | Facteur déduit, modèle composé |
| --- | --- | --- |
| Bandit (niveaux 1, 2, 3) | 1,2050 · 1,2051 · 1,2051 | 1,2050 · 1,2051 · 1,2047 |
| Lascar (niveaux 3, 4) | 1,3149 · 1,3149 | 1,3143 · 1,3134 |
| Racaille (niveaux 2, 3) | 1,1901 · 1,1901 | 1,1901 · 1,1897 |

L'additif tombe juste à la 4ᵉ décimale. Donc :

```
PV(niveau n) = PV(niveau 1) × (1 + 0,02 × (n − 1))
```

L'écart est petit — 0,2 % au niveau 5, 1,6 % au niveau 50 — mais il surestime systématiquement
les hauts niveaux de type, c'est-à-dire exactement les adversaires qui comptent. Corrigé dans
`atTypeLevel()`. Au passage, ça fait perdre un combat sur 61 au rejeu : du bruit sur un échantillon
court, et je préfère la formule mesurée à celle qui colle d'un cheveu de mieux.

### c. L'XP de type n'était pas relevée du tout

La vue du shop expose la progression de chaque type (`7 911 / 27 134 XP avant le niveau 4`) et on
ne la lisait pas. Elle est maintenant dans `data/troops.json` et dans `docs/troupes.md`, avec ce
qu'il reste à gagner. Seuils observés : **2 100 · 11 546 · 27 134 · 47 891 XP** pour les niveaux
2 à 5 (pas de formule évidente sur quatre points — c'est un relevé qui se complétera).

### d. Les talents n'étaient pas relevés — c'était le vrai trou noir

`/play/view/skills` sert l'arbre complet : 45 nœuds, l'effet exact de chacun, et les points
dépensés. Rien n'en sortait. Conséquence : l'écart entre les stats « de base » et « réelles » d'une
carte mélangeait talents et équipement sans moyen de les séparer.

Ajouté : `src/skills.mjs` → `data/skills.json`. Les 45 nœuds sont décodés, y compris les branches
non achetées (bonus plats de vie, réduction de dégâts subis, points de riposte) pour que le modèle
reste juste si tu y investis.

Relevé sur ton compte : 28 points, tous en Offense —
**+21 % de dégâts, +70 dégâts plats par coup, +5 pts de critique, +4 % de vitesse, +50 % de dégâts
critiques, et 0 % de vie.**

Ce zéro est la clé. Il se vérifie immédiatement : tes deux types sans équipement (Junkie, Voyou)
ont des PV réels **exactement** égaux à leurs PV de base. Et la formule complète se valide sur eux
côté dégâts : `(base + 70) × 1,21` donne 378 contre 382 servis, et 373 contre 373.

**Ce que ça débloque.** Dans l'audit initial, j'écrivais que le bonus intrinsèque des objets
n'était « pas modélisable ». C'était vrai sans l'arbre de talents. Maintenant qu'on sait que les
talents n'apportent aucun PV, tout l'écart de PV d'un type équipé lui est imputable, et il se lit
directement : Lascar **+31,5 %**, Brute **+24,5 %**, Bandit **+20,5 %**, Racaille **+19,0 %**.
Avec assez de combinaisons d'objets observées, la table des bonus intrinsèques devient
constructible. Je ne l'ai pas faite — c'est une fonctionnalité, pas une correction.

### e. Le multiplicateur de critique était figé à ×1,5 — et c'est faux

`sim.mjs` lisait `me.critMult || 1.5`, et `me.critMult` n'était **jamais défini**. Or le talent
*Executioner* que tu as acheté annonce « +50 % de dégâts critiques ».

Le libellé est ambigu : la prime passe-t-elle de +50 % à +100 % (×2,0), ou les dégâts critiques
gagnent-ils 50 % (×2,25) ? Plutôt que de trancher au jugé, `calibrateCrit()` rejoue l'historique
avec les trois hypothèses :

| Hypothèse | Multiplicateur | Justesse | AUC | Justesse équilibrée |
| --- | ---: | ---: | ---: | ---: |
| Talent ignoré (code précédent) | ×1,50 | 85,2 % | 0,885 | 88,5 |
| Prime portée à +100 % | ×2,00 | 85,2 % | 0,879 | 87,5 |
| **Dégâts critiques ×1,5** | **×2,25** | **90,2 %** | **0,900** | **92,3** |

Sans appel. Le calibrage est refait à chaque analyse, donc il se corrigera tout seul si tu
redistribues tes points.

> Signal indépendant, plus faible mais cohérent : en normalisant chaque coup par la médiane des
> coups de la même pile dans le même combat, la queue haute de *tes* coups se masse à 2,43× contre
> 2,01× pour ceux d'en face. Mesure bruitée (rage et frénésie la gonflent), citée comme
> corroboration, pas comme preuve.

## 4 ter. Le simulateur interactif

Le moteur `simulate()` existait mais ne rendait qu'un verdict : vainqueur, marge, durée. Rien ne
permettait de *regarder* un combat, ni d'en jouer un à la demande.

**Ajouté au moteur** — une trace optionnelle (`simulate(A, B, { trace: true })`) qui enregistre les
coups portés, les capacités déclenchées avec leur charge, et la courbe de PV des deux camps. Elle
est éteinte par défaut : `recommend()` appelle `simulate()` des centaines de milliers de fois, et
un backtest complet des 61 combats reste à 3,6 ms. Au passage, chaque pile suit désormais les
dégâts qu'elle **subit**, pas seulement ceux qu'elle inflige.

**Ajouté à l'API** — `GET /api/types` (les types alignables avec leurs stats du moment),
`GET /api/scenarios` (les adversaires jouables, un par combat archivé) et `POST /api/simulate`.
Le serveur ne savait lire aucun corps de requête : `readBody()` a été ajouté, plafonné à 256 Ko.

`POST /api/simulate` accepte trois origines de composition :

| `mine.mode` | Ce que ça joue |
| --- | --- |
| `custom` | la composition envoyée par la page |
| `current` | ce que tu as en ligne en ce moment |
| `historic` | ta composition de ce jour-là, avec ses PV réels d'alors — le rejeu fidèle |

La réponse porte le duel (verdict, trace, pile par pile) **et** le bilan de la même composition
contre tout l'historique, parce qu'un duel gagné ne dit rien de la suite.

**Corrigé au passage** : les fichiers statiques étaient servis sans `Cache-Control`. Sur un outil
qu'on modifie en le regardant tourner, une feuille de style retouchée ne se voyait qu'après un
rechargement forcé. Désormais `no-store`.

## 5. Interface

**Avant** : 6 boutons sur le tableau de bord, et trois écrans (Analyse, Compositions) qui
affichaient « clique sur Analyser depuis le tableau de bord » — alors qu'ils se calculent hors ligne
et n'ont *jamais* eu besoin du jeu.

**Après** :

- **un seul bouton** qui touche au jeu — *Mettre à jour* : connexion, reprise des combats, relevé
  des troupes, reprojection des adversaires et des objets. Une tâche, un geste ;
- tous les écrans **se remplissent à la première visite**, plus rien à cliquer avant de voir ;
- les actions au grain fin sont repliées sous *Actions détaillées* ;
- navigation regroupée : les trois écrans de travail d'abord, la documentation ensuite ;
- un bloc **Reprise de l'historique** sur le tableau de bord : d'où repart le prochain passage, ce
  que la fenêtre couvrait, et les trous en rouge ;
- un onglet **Adversaires** : liste cliquable, puis armée actuelle avec les trois pièces
  d'équipement par pile et la frise datée de ses changements de troupes ;
- un onglet **Les objets** et, dans l'Analyse, la comparaison de ton équipement au leur, affixe par
  affixe ;
- depuis la table des combats, le nom de l'adversaire ouvre sa fiche.

---

## 6. Ce qui reste, par ordre de ce qui te mordra en premier

### a. Volumétrie — le point qui cassera en premier

Mesuré aujourd'hui : **39 Ko par combat** dans `fights.json` (2,3 Mo pour 59).

| Combats en base | `fights.json` | Réécrit en entier à chaque passage |
| ---: | ---: | --- |
| 59 (aujourd'hui) | 2,3 Mo | instantané |
| 1 000 | ~39 Mo | quelques secondes, et tout en mémoire |
| 5 000 | ~195 Mo | plus tenable |

`writeJson()` sérialise **tout le fichier** à chaque passage, et `loadAnalysis()` le reparse
entièrement à chaque appel d'API, sans cache. Ce qui le fait grossir, ce sont les `events[]` — la
frise coup par coup, ~136 lignes par combat.

Quand ça gênera, dans l'ordre de simplicité : (1) mettre un cache mémoire sur `loadAnalysis()`
invalidé par le `mtime` du fichier ; (2) sortir le détail des combats en un fichier par combat
(`data/fights/10598.json`) et ne garder qu'un index dans `fights.json` ; (3) ne conserver `events[]`
que pour les N derniers combats, les agrégats mesurés étant déjà extraits dans `enemies.json`.

Rien d'urgent : à ton rythme actuel (~40 combats/jour), le seuil des 1 000 est à ~25 jours.

### b. La recherche de compositions explosera en montant de niveau

`recommend()` énumère toutes les combinaisons de types débloqués. Aujourd'hui, 7 types chiffrés et
4 emplacements → **4 396 compositions**, ~5 s. Avec les 21 types et l'Annexe (5 emplacements) →
**~3,1 millions**, soit plusieurs heures.

Il faudra élaguer avant d'arriver là : écarter les types dominés sur dégâts *et* PV *et* vitesse,
ou passer d'une énumération exhaustive à une recherche locale depuis quelques points de départ.

### c. Charge utile de l'API

`/api/analyse` renvoie **451 Ko** aujourd'hui, parce que la réponse contient les piles détaillées de
chaque combat. Même courbe que (a). `/api/enemies` a déjà été écrit pour éviter le piège : il ne
renvoie que les résumés, le détail d'un adversaire se demande un par un.

### d. Secrets

`.env` contient ton mot de passe en clair et `out/state.json` les cookies de session — les deux sont
bien dans `.gitignore`, et `data/` aussi. C'est correct pour un outil local ; à ne pas transposer
tel quel sur une machine partagée.

### e. Corrigé au passage

- `src/server.mjs` — le garde-fou de chemin des fichiers statiques comparait sans séparateur : un
  dossier voisin nommé `web-autre` aurait été servi. Corrigé.
- `src/analyse.mjs` — une affectation morte (`taken[foe][to] = taken[foe][to]`) dans la boucle des
  ripostes. Supprimée.

---

## Fichiers touchés

```
ajoutés     src/gear.mjs          modèle d'équipement, catalogue, docs/objets.md
            src/enemies.mjs       projection combats → fiches d'adversaires
            src/skills.mjs        arbre de talents → data/skills.json
            docs/audit.md         ce document
modifiés    src/fights.mjs        repère de reprise, journal, détection de trous, compteurs
            src/sim.mjs           reconstruction des piles par équipement + cadence mesurée
            src/analyse.mjs       affixes structurés, cadence par pile, agrégats d'équipement
            src/server.mjs        /api/enemies, /api/enemy, /api/items, /api/update-all, garde-fou
            src/index.mjs         commande « enemies », --no-project, code 1 sur trou
            src/config.mjs        chemins enemies.json / items.json
            src/troops.mjs        ROSTER et ROLE_FR exportés, XP de type relevée
            src/gear.mjs          atTypeLevel corrigé : bonus additif et non composé
            web/                  onglet Adversaires, tableau de bord simplifié, objets
            package.json          npm run update, npm run enemies
            README.md             reprise, adversaires, objets, nouveaux chiffres du simulateur
```
