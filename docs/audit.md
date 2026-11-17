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
| Images | aucune — interface entièrement textuelle | 112 fichiers en local : troupes, objets, avatars, bâtiments, ressources |
| Journal de combat | la frise JSON seulement — ni critiques ni KO | le journal rédigé par le jeu, stocké et affiché coup par coup |
| Quartier général | **jamais relevé** | `data/hq.json` — ressources, bâtiments, niveau, points de compétence |
| Export pour agent IA | inexistant | `docs/rapport.md`, téléchargeable et copiable depuis l'interface |
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

**Corrigé après coup** — chaque curseur de l'éditeur de composition était borné aux places
**totales** au lieu des places **restantes** : on pouvait mettre 875 unités sur chacun des sept
types et partir simuler une armée de 6 125 unités sur un budget de 875. Le dépassement n'était
signalé qu'après coup par un avertissement, et le combat se jouait quand même sur une composition
inalignable. Les places sont un budget commun : la borne de chaque type est maintenant
`places − somme des autres`, recalculée à chaque frappe. Côté API, une composition hors budget
reste acceptée — on peut vouloir simuler une hypothèse — mais la réponse porte désormais
`mine.over`, le nombre de places manquantes.

**Corrigé au passage** : les fichiers statiques étaient servis sans `Cache-Control`. Sur un outil
qu'on modifie en le regardant tourner, une feuille de style retouchée ne se voyait qu'après un
rechargement forcé. Désormais `no-store`.

## 4 quater. Les images

L'interface était entièrement textuelle alors que le jeu sert toutes ses images **en clair, sans
session** — vérifié sur les portraits, les vignettes, les avatars et le sprite d'icônes. Un `fetch`
suffit, comme pour les règles publiques.

**Ajouté** : `src/assets.mjs` → `data/assets/`, 82 fichiers pour 1,5 Mo, téléchargement incrémental.

Trois choix qui méritent d'être explicités :

1. **Copie locale plutôt que liens vers le jeu.** Une page qui pointe vers `ssandsun.com` ne
   s'affiche pas hors ligne et signale au serveur chaque consultation du tableau de bord. Les
   images sont servies par le serveur local sous `/assets/`, avec un cache long — contrairement au
   code, elles ne changent jamais sous un même nom.
2. **Un seul sprite pour les objets.** Les 30 icônes sont des `<symbol>` monochromes dans
   `icons.svg` : une requête au lieu de trente, et comme elles héritent de `currentColor`,
   l'interface les teinte **par rareté** en CSS. L'icône devient porteuse d'information, pas
   seulement décorative.
3. **Les 21 types téléchargés d'avance**, verrouillés compris : leurs images existent déjà côté
   serveur, et l'interface ne se trouera pas en montant de niveau.

Aucune image n'est indispensable : la vignette disparaît si le fichier manque, l'avatar retombe sur
l'initiale du pseudo. Le tableau de bord signale l'absence d'images plutôt que de la subir.

**Corrigé au passage** : `src/troops.mjs` abandonnait le relevé entier au premier HTTP 409 — le
serveur refuse les vues trop rapprochées, ce que le code *documentait* sans le gérer. Un échec
emportait aussi la régénération de `docs/troupes.md`. Il y a maintenant trois tentatives espacées.

**Aussi ajouté** : le rendu Markdown maison accepte `![alt](/chemin)` (sources locales seulement),
ce qui met le portrait de chaque type dans sa fiche de `docs/troupes.md`.

## 4 quinquies. Le journal réel des combats — et une erreur qu'il corrige

`GET /play/view/fightlog?id=<id>` rend le déroulé que le jeu écrit lui-même. On avait déjà
`report.events`, la frise brute. Pourquoi aller chercher le journal en plus ? Parce qu'il porte
deux informations que le JSON **ne donne pas** :

- quels coups ont été **critiques** — `events` ne le dit jamais ;
- combien d'unités chaque coup a mises **KO**, calculé par le jeu.

Le HTML pèse 72 Ko par combat, trois fois le combat entier. Il est donc converti en lignes
structurées (~12 Ko) avant stockage. Les 65 combats déjà en base ont été rattrapés par lots.

### Ce que ça a corrigé : mon multiplicateur de critique était faux

Au §4 bis, j'avais tranché l'ambiguïté du talet *Executioner* (« +50 % de dégâts critiques ») en
**calant** le multiplicateur sur le rejeu de l'historique. Le calage préférait ×2,25.

Le journal permet de le **mesurer** directement : pour une même pile dans un même combat, le
rapport entre la médiane de ses coups critiques et celle de ses coups normaux donne le
multiplicateur, puisque l'équipement, les talents et le niveau de type s'annulent.

| Seuil d'échantillon | Mon camp | En face |
| --- | ---: | ---: |
| ≥1 critique, ≥3 normaux | ×1,978 | ×1,516 |
| ≥3 critiques, ≥5 normaux | ×1,986 | ×1,504 |
| ≥5 critiques, ≥8 normaux | ×1,959 | ×1,504 |

**×2,0 pour moi, ×1,5 en face.** Le groupe témoin est décisif : mes adversaires n'ont pas
Executioner, et la mesure leur rend exactement la valeur documentée par les règles. La méthode est
donc juste, et ×2,25 était du **sur-ajustement sur 61 combats**.

Le code préfère désormais la mesure, et ne retombe sur le calage que si aucun journal n'est encore
en base. À noter, parce que c'est contre-intuitif : avec ×2,0 le rejeu est *moins* bon qu'avec
×2,25 (84,6 % contre 86,2 %). Un ajustement qui bat une mesure directe sur un échantillon court ne
prouve rien d'autre que sa propre souplesse.

### Corrigé en le regardant tourner

L'affichage des armées montrait « PV restants : 100 % » sur une défaite où toutes mes piles étaient
tombées. La pile porte deux champs — `hp` (PV au **départ**, réduits en défense si la récupération
n'est pas finie) et `end` (PV à la **fin**) — et seul `hp` était lu. `end` n'était même pas capturé
par `analyse.mjs`. La colonne est maintenant dédoublée : « PV au départ » et « PV à la fin ».

## 4 sexies. Le QG et le compte rendu

**`src/hq.mjs`** → `data/hq.json`, depuis `GET /play/state` et `GET /play/buildings`. 33 bâtiments
avec niveau, maximum, PV et chantiers en cours ; ressources avec capacité et production ; niveau,
XP, points de compétence, classement, attaques restantes. Un point d'historique s'ajoute quand une
valeur suivie change.

L'écran du QG signale les deux pertes invisibles : **points de compétence non dépensés** et
**stocks au plafond** (la production correspondante est jetée).

**`src/report.mjs`** → un Markdown unique destiné à être collé dans une conversation avec un agent
IA. Le parti pris : des chiffres déjà agrégés plutôt que du JSON brut, une séparation nette entre
ce qui est **mesuré** et ce qui est **modélisé**, et une section « limites connues » explicite.
Servi aussi sur `/api/report.md`, téléchargeable et copiable depuis l'interface.

## 4 septies. Recherche

Partout où il y avait une liste de joueurs, c'était un `<select>` — inutilisable passé quelques
dizaines d'entrées, et impossible à filtrer. Remplacé par un sélecteur unique, réutilisé dans le
simulateur et dans l'onglet Adversaires : un champ qui filtre, une liste qui se réduit, les flèches
et Entrée qui marchent.

La recherche est insensible aux accents et à la casse (« chengri » trouve *Chengriha*), accepte
plusieurs mots, et cherche **au-delà du nom** : taper `diablesse` sort les adversaires qui alignent
ce type. Dans l'onglet Adversaires, choisir une entrée ouvre directement sa fiche.

## 4 octies. Un bug signalé qui en cachait un vrai

**Le signalement.** « Mon dernier combat contre HardCofF FILTH, j'étais en défense et je l'ai perdu.
Dans le simulateur, il me sort toujours que je le gagne. »

### Ce que l'archive dit, et qui règle la question

Les combats **11055** et **11060** opposent exactement les mêmes armées :

| | 11055 | 11060 |
| --- | --- | --- |
| Moi | bandit ×543, brute ×88, lascar ×131, racaille ×113 — 3 528 530 PV | identique |
| Lui | bandit ×375, brute ×185, racaille ×197, voyou ×230 | identique |
| Fortifications, poste de garde, capacités actives | 14 %, 50, les mêmes | identiques |
| **Issue réelle** | **gagné** (528 886 PV restants) | **perdu** (0 PV) |

Même situation, issues opposées. Ce qui a changé est dans les journaux :

| | 11055 | 11060 |
| --- | ---: | ---: |
| Mes dégâts | 5 049 331 | 4 020 089 (**−20 %**) |
| Ses dégâts | 3 229 158 | 3 757 670 (**+16 %**) |
| Ses critiques | 8,5 % | 10,8 % |

Le jeu tire les dégâts et les critiques au hasard. Un simulateur déterministe ne peut pas
distinguer ces deux combats, et il ne le doit pas : il donne la même réponse aux deux, ce qui est
le comportement correct. Le défaut était **dans l'affichage**, qui présentait une tendance comme un
verdict.

### Le vrai bug trouvé en creusant : le poste de garde

Les règles sont explicites : « Poste de garde — en défense, tes troupes **se battent avec au moins
30 % de leur vie** (jusqu'à 50 %) ». C'est un plancher sur les **PV de départ**.

Le simulateur en faisait un **plancher permanent sur les unités vivantes pendant tout le combat** :
`aliveOf()` renvoyait `qty × max(ratio, guard/100)`. Avec un poste de garde à 50 %, une armée à
l'agonie continuait de frapper à mi-puissance jusqu'au bout — un bonus massif et imaginaire, du
bon côté pour moi, sur tous mes combats en défense.

Réfuté par les données autant que par les règles : dans le combat 11060, où j'avais le plancher à
50 %, mes lascars sont passés de 131 à **34 unités** — soit 26 %.

Corrigé : le poste de garde relève les PV de départ, et rien d'autre.

| | Justesse | AUC | Équilibrée (att / déf) |
| --- | ---: | ---: | --- |
| Avant | 86,2 % | 0,896 | 92,5 / 83,3 |
| Après | 84,6 % | **0,903** | 92,5 / **86,7** |

La justesse brute baisse, le pouvoir de classement monte et la défense s'améliore nettement — c'est
là que le bug agissait. On garde la correction : elle est exigée par les règles *et* par
l'observation, et l'AUC ne dépend pas d'un seuil calé.

### Une piste écartée en chemin

Le lascar semblait frapper deux fois plus fort que simulé (829 contre 1 660 par unité). Fausse
alerte : avec 43 % de chances de critique, **5 de ses 6 coups du combat étaient critiques** et la
médiane tombait donc sur une valeur critique. Les coups normaux valent 842 — l'écart au simulateur
est de 2 %.

Cette vérification a produit une confirmation inattendue : les coups de cette pile valent 842
normal, 1 640 en critique (×1,95) et 2 290 en critique sous Rage (×2,72 ≈ 2,0 × 1,35). **Le
multiplicateur ×2,0 est confirmé une troisième fois**, par une voie indépendante.

### Ce que l'affichage dit maintenant

Une marge n'est pas un verdict. Pour une marge donnée, `winChance()` regarde les 15 combats de
l'historique dont la marge simulée est la plus proche et renvoie la part réellement gagnée. Entre
25 % et 75 %, le simulateur affiche **« Trop serré »** au lieu de désigner un vainqueur.

Courbe de calibrage mesurée sur les 65 combats :

| Marge simulée | Combats réellement gagnés |
| --- | ---: |
| −0,94 à −0,68 | 0 / 10 (0 %) |
| −0,65 à −0,56 | 0 / 11 (0 %) |
| −0,53 à +0,15 | 2 / 11 (18 %) |
| +0,20 à +0,42 | 7 / 11 (**64 %**) |
| +0,43 à +0,62 | 5 / 11 (**45 %**) |
| +0,71 à +1,00 | 11 / 11 (100 %) |

Le combat 11060 a une marge de **+0,367** — en plein dans la zone où l'issue tient au tirage.

### Ce qui reste imparfait

Les combats simulés durent systématiquement moins longtemps que les vrais (18 s contre 26 s sur ce
combat). Le simulateur répartit chaque coup sur toutes les piles adverses au prorata de leurs PV,
là où le jeu en vise une seule : aucun dégât n'est donc gaspillé en surplus sur une pile presque
morte. L'effet joue dans les deux camps, ce qui explique que le classement reste bon, mais les
durées affichées sont à prendre comme un ordre de grandeur.

## 4 nonies. Trois corrections d'ergonomie

**Une barre de ressources en permanence.** Les stocks conditionnent presque toutes les décisions du
jeu — recruter, construire, améliorer — et il fallait aller dans une autre vue pour les voir. Barre
collée en haut, avec les icônes du jeu, une jauge fine de remplissage, et un stock plein signalé en
rouge (la production y est perdue). Servie avec l'état global : une requête, pas deux.

**Le tableau des combats remonte.** Il était en bas de l'analyse, après six sections. Il est
maintenant juste sous les tuiles de bilan — c'est ce qu'on vient consulter.

**Les fiches deviennent des pages.** Le journal d'un combat et la fiche d'un adversaire
s'affichaient en panneau sous la liste, ce qui obligeait à faire défiler et mélangeait deux niveaux
de lecture. Ce sont désormais des pages à part entière, avec leur propre adresse (`#combat/11086`,
`#adversaire/199`) : un lien se partage, le bouton du navigateur fonctionne, et l'entrée de menu
parente reste allumée.

Deux détails qui font la différence sur ce genre de navigation :

- **toute la ligne est cliquable**, pas seulement une cellule. Une liste dont seules quelques
  cellules réagissent oblige à viser, et rien n'indique où ;
- **le bouton « Retour » fait ce qu'il annonce.** Une première version suivait l'historique du
  navigateur — ce qui, en arrivant par un lien direct, faisait *sortir du site*, et après un détour
  ramenait à la page précédente quelle qu'elle soit plutôt qu'à la liste promise. Il compare
  maintenant l'adresse précédente à sa destination : si elles coïncident, `history.back()` rend la
  liste **et sa position de défilement** (vérifié : 1 077 px retrouvés sur un tableau de 68 lignes) ;
  sinon il pose simplement l'adresse annoncée.

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
            src/assets.mjs        images du jeu → data/assets/
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
