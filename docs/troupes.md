# Sand Sea Sun — Les troupes

> Les 21 types de troupes : rôle, capacité spéciale, stats, coût de recrutement.

*Relevé dans le jeu (`/play/view/units?cat=troops`) le 2026-11-17 avec le compte **JoeyJr** (niveau 19). Règles générales : [docs/regles.md](regles.md).*

> ⚠️ L'interface de ce compte est réglée en `en` et le jeu ignore `Accept-Language` comme les paramètres d'URL : les **noms d'unité, descriptions et libellés relevés sont dans cette langue**. Les noms et effets français viennent des règles publiques. Passer le compte en français (téléphone › Réglages) ferait tout remonter en français.

## Comment lire ces chiffres

- **Vie** — ce qu’une unité encaisse avant d’être assommée. Les troupes ne meurent jamais, elles récupèrent.
- **Dégâts** — par coup, tirés au hasard entre le minimum et le maximum.
- **Critique** — chance qu’un coup soit critique : tout le groupe frappe alors ×1,5.
- **Riposte** — chance que le groupe frappé rende le coup à 60 % de ses dégâts (toutes les unités touchées d’un coup).
- **Vitesse** — délai entre deux coups : plus il est court, plus l’unité frappe souvent.
- **Niveau de type** — chaque type gagne de l’XP en combat jusqu’au niveau 50 : **+2 % de dégâts et de vie par niveau**, pour toutes tes unités de ce type. Le bonus est **additif** et non composé : au niveau *n*, une unité vaut `base × (1 + 2 % × (n − 1))`. Vérifié sur l’historique à équipement constant — un modèle composé dérive dès le niveau 3.

Deux colonnes de valeurs pour chaque stat :

- **base** — le type seul, à son niveau de type actuel, sans talents ni équipement (l’interrupteur « Stats de base » du shop) ;
- **réel** — ce que donnent tes unités à toi, bonus d’arbre de talents et d’objets compris.

## Les 21 types

| Nv. | Type | Nom en jeu | Clé | Rôle | Capacité | Stats relevées |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | **Junkie** | — | `mauviette` | Rapide | Embuscade | ✅ |
| 1 | **Racaille** | Scumbag | `racaille` | Défenseur | Bouclier | ✅ |
| 1 | **Lascar** | Hustler | `lascar` | Cogneur | Rage | ✅ |
| 5 | **Voyou** | Thug | `voyou` | Rapide | Frénésie | ✅ |
| 10 | **Bandit** | — | `bandit` | Défenseur | Second souffle | ✅ |
| 15 | **Brute** | — | `brute` | Cogneur | Onde de choc | ✅ |
| 20 | **Diablesse** | She-devil | `diablesse` | Rapide | — | 👁 |
| 26 | **Braqueur** | Robber | `braqueur` | Cogneur | — | 🔒 |
| 33 | **Tueur à gages** | Hitman | `tueur_a_gage` | Défenseur | — | 🔒 |
| 37 | **Gros Bras** | Muscle | `gros_bras` | Cogneur | — | 🔒 |
| 41 | **Assassin** | — | `assassin` | Rapide | — | 🔒 |
| 44 | **Tony Montagna** | — | `tony` | Polyvalent | — | 🔒 |
| 47 | **Deathgirl** | — | `deathgirl` | Défenseur | — | 🔒 |
| 50 | **Sicario** | — | `sicario` | Rapide | — | 🔒 |
| 53 | **Garde du corps** | Bodyguard | `garde_du_corps` | Défenseur | — | 🔒 |
| 56 | **Hellboy** | — | `hellboy` | Cogneur | — | 🔒 |
| 59 | **Bloody Mary** | — | `bloody_mary` | Rapide | — | 🔒 |
| 61 | **Mastodonte** | Mastodon | `mastodonte` | Cogneur | — | 🔒 |
| 63 | **Keyser Söze** | — | `keyser_soze` | Polyvalent | — | 🔒 |
| 65 | **Le Golem** | The Golem | `golem` | Défenseur | — | 🔒 |
| 68 | **Pablo Escobarre** | — | `escobarre` | Polyvalent | — | 🔒 |

✅ relevé complet · 👁 avant-première (type verrouillé mais chiffré par le jeu) · 🔒 verrouillé : le jeu ne sert **ni stats ni capacité** avant que le personnage atteigne le niveau requis — il ne montre que le prochain type à débloquer. Relancer `npm run troops` en montant de niveau complète le tableau : `data/troops.json` accumule et ne perd jamais un relevé.

## Rôles et triangle des forces

| Rôle | Profil | Avantage léger contre |
| --- | --- | --- |
| **Rapide** | Frappe vite, mais fragile | Cogneurs |
| **Cogneur** | Frappe fort, mais lentement | Défenseurs |
| **Défenseur** | Solide, rend souvent les coups | Rapides |
| **Polyvalent** | Bon partout (Tony Montagna, Keyser Söze, Pablo Escobarre) | — |

Tu alignes **4 types** différents au maximum (3 au départ, le 4ᵉ au niveau 5), en quantité libre ; l’**Annexe** (bâtiment du niveau 25) ouvre un **5ᵉ emplacement**.

## Les capacités spéciales

Une capacité agit sur **toute ton armée**, mais seulement si tu engages au moins **10 % de tes places de troupes** en unités de ce type. En dessous, elle ne fait rien. Deux types qui portent la même capacité ne la cumulent pas : chacun doit atteindre le seuil seul.

| Capacité | Effet | Portée par |
| --- | --- | --- |
| **Embuscade** | Avant le combat, chacun de tes groupes frappe une fois, à 40 % de sa puissance. | Junkie |
| **Gel du temps** | Au début du combat, les troupes adverses sont figées 0,5 s. | — |
| **Frénésie** | Au début du combat, tes troupes frappent 50 % plus vite pendant 2 s. | Voyou |
| **Bouclier** | Un bouclier absorbe les premiers dégâts : 8 % de la vie de tes troupes. | Racaille |
| **Onde de choc** | Quand l’adversaire a perdu 30 % de sa vie, une onde frappe toute son armée. | Brute |
| **Coup de grâce** | Quand l’adversaire passe sous 35 % de vie, ses groupes les plus abîmés sont achevés. | — |
| **Rage** | Sous 50 % de vie, tes troupes font +35 % de dégâts pendant 10 s. | Lascar |
| **Forteresse** | Quand ton premier groupe tombe ou sous 40 % de vie, tes troupes encaissent 35 % de dégâts en moins pendant 10 s. | — |
| **Second souffle** | Une fois sous 30 % de vie, tes troupes récupèrent 12 % de leur vie. | Bandit |
| **Dernier carré** | Sous 25 % de vie, tes troupes font +50 % de dégâts et frappent 50 % plus vite jusqu’à la fin. | — |
| **Intimidation** | Au début du combat, l’adversaire inflige 20 % de dégâts en moins pendant 5 s. | — |
| **Saignée** | Tes coups critiques font saigner : ils frappent ×2,5 au lieu de ×1,5. | — |
| **Renvoi** | 2 % des dégâts que reçoivent tes troupes reviennent au groupe qui frappe. | — |
| **Corruption** | Au début du combat, le plus gros groupe adverse est acheté : il ne frappe pas pendant un moment (jusqu’à 2 s, moins s’il fait presque toute l’armée). | — |

*Colonne « Portée par » : d’après les cartes relevées. Elle se remplit à mesure que les types se débloquent.*

## Fiches détaillées

### Junkie

**Niveau requis** 1 · **Rôle** Rapide · **Capacité** Embuscade · **Niveau de type** 3

*Progression du type : 7 911 / 27 134 XP (29,2 %) avant le niveau 4 — il reste 19 223 XP à gagner en combat, et le palier vaudra +2 % de vie et de dégâts pour toutes tes unités de ce type.*

*Twitchy and unpredictable, he hits fast. Anything for his next fix.*

> **Embuscade** — Avant le combat, chacun de tes groupes frappe une fois, à 40 % de sa puissance.

| Stat | Base | Réel (ce compte) |
| --- | --- | --- |
| Vie | 2 246 | 2 246 |
| Dégâts | 237 – 248 | 375 – 388 |
| Critique | 10 % | 15 % |
| Riposte | 4 % | 4 % |
| Vitesse d’attaque | 1 coup / 0,75 s | 1 coup / 0,72 s |

**Coût d’un recrutement** — 50 $ · 35 alcool · 20 herbe · 20 poudre

### Racaille · *Scumbag*

**Niveau requis** 1 · **Rôle** Défenseur · **Capacité** Bouclier · **Niveau de type** 3 · **Possédées** 30

*Progression du type : 11 972 / 27 134 XP (44,1 %) avant le niveau 4 — il reste 15 162 XP à gagner en combat, et le palier vaudra +2 % de vie et de dégâts pour toutes tes unités de ce type.*

*The punk doesn’t look like much, but knows exactly where it hurts.*

> **Bouclier** — Un bouclier absorbe les premiers dégâts : 8 % de la vie de tes troupes.

| Stat | Base | Réel (ce compte) |
| --- | --- | --- |
| Vie | 3 224 | 3 837 |
| Dégâts | 239 – 260 | 466 – 497 |
| Critique | 5 % | 12 % |
| Riposte | 55 % | 71 % |
| Vitesse d’attaque | 1 coup / 1,5 s | 1 coup / 1,58 s |

**Coût d’un recrutement** — 50 $ · 30 alcool · 30 herbe · 15 poudre

### Lascar · *Hustler*

**Niveau requis** 1 · **Rôle** Cogneur · **Capacité** Rage · **Niveau de type** 4 · **Possédées** 641

*Progression du type : 35 918 / 47 891 XP (75 %) avant le niveau 5 — il reste 11 973 XP à gagner en combat, et le palier vaudra +2 % de vie et de dégâts pour toutes tes unités de ce type.*

*He didn’t invent sliced bread, but he hits hard. That’s it.*

> **Rage** — Sous 50 % de vie, tes troupes font +35 % de dégâts pendant 10 s.

| Stat | Base | Réel (ce compte) |
| --- | --- | --- |
| Vie | 3 265 | 4 293 |
| Dégâts | 457 – 490 | 803 – 853 |
| Critique | 25 % | 43 % |
| Riposte | 3 % | 8,5 % |
| Vitesse d’attaque | 1 coup / 2,2 s | 1 coup / 2,18 s |

**Coût d’un recrutement** — 50 $ · 20 alcool · 5 herbe · 40 poudre

### Voyou · *Thug*

**Niveau requis** 5 · **Rôle** Rapide · **Capacité** Frénésie · **Niveau de type** 1

*Progression du type : 430 / 2 100 XP (20,5 %) avant le niveau 2 — il reste 1 670 XP à gagner en combat, et le palier vaudra +2 % de vie et de dégâts pour toutes tes unités de ce type.*

*No faith, no law: the thug always goes for the weak spot.*

> **Frénésie** — Au début du combat, tes troupes frappent 50 % plus vite pendant 2 s.

| Stat | Base | Réel (ce compte) |
| --- | --- | --- |
| Vie | 2 200 | 2 200 |
| Dégâts | 233 – 243 | 367 – 379 |
| Critique | 10 % | 15 % |
| Riposte | 4 % | 4 % |
| Vitesse d’attaque | 1 coup / 0,75 s | 1 coup / 0,72 s |

**Coût d’un recrutement** — 70 $ · 30 alcool · 35 herbe · 30 poudre

### Bandit

**Niveau requis** 10 · **Rôle** Défenseur · **Capacité** Second souffle · **Niveau de type** 3 · **Possédées** 118

*Progression du type : 3 729 / 27 134 XP (13,7 %) avant le niveau 4 — il reste 23 405 XP à gagner en combat, et le palier vaudra +2 % de vie et de dégâts pour toutes tes unités de ce type.*

*Sly and effective, the bandit is ready to serve at any moment.*

> **Second souffle** — Une fois sous 30 % de vie, tes troupes récupèrent 12 % de leur vie.

| Stat | Base | Réel (ce compte) |
| --- | --- | --- |
| Vie | 3 359 | 4 048 |
| Dégâts | 249 – 270 | 441 – 471 |
| Critique | 5 % | 18,5 % |
| Riposte | 55 % | 57,5 % |
| Vitesse d’attaque | 1 coup / 1,5 s | 1 coup / 1,3 s |

**Coût d’un recrutement** — 90 $ · 45 alcool · 50 herbe · 40 poudre

### Brute

**Niveau requis** 15 · **Rôle** Cogneur · **Capacité** Onde de choc · **Niveau de type** 2 · **Possédées** 86

*Progression du type : 2 332 / 11 546 XP (20,2 %) avant le niveau 3 — il reste 9 214 XP à gagner en combat, et le palier vaudra +2 % de vie et de dégâts pour toutes tes unités de ce type.*

*Beneath that shell of muscle lies a sensitive soul. Or not.*

> **Onde de choc** — Quand l’adversaire a perdu 30 % de sa vie, une onde frappe toute son armée.

| Stat | Base | Réel (ce compte) |
| --- | --- | --- |
| Vie | 3 335 | 4 153 |
| Dégâts | 466 – 500 | 699 – 743 |
| Critique | 25 % | 36,5 % |
| Riposte | 3 % | 5 % |
| Vitesse d’attaque | 1 coup / 2,2 s | 1 coup / 2,02 s |

**Coût d’un recrutement** — 110 $ · 70 alcool · 40 herbe · 55 poudre

### Diablesse · *She-devil*

**Niveau requis** 20 · **Rôle** Rapide · **Capacité** — · **Niveau de type** 1

> 👁 **Avant-première** — type encore verrouillé : le jeu en donne les chiffres mais pas le rôle ni la capacité.

| Stat | Base | Réel (ce compte) |
| --- | --- | --- |
| Vie | 2 340 | 2 340 |
| Dégâts | 247 – 258 | 384 – 397 |
| Critique | 10 % | 15 % |
| Riposte | 4 % | 4 % |
| Vitesse d’attaque | 1 coup / 0,75 s | 1 coup / 0,72 s |

**Coût d’un recrutement** — 130 $ · 50 alcool · 55 herbe · 120 poudre

## Les filles

Elles rapportent des dollars à chaque tour (toutes les 5 minutes), tant que le stock n’est pas plein.

| Nv. requis | Unité | Produit | Production / tour | Risque d’arrestation | Coût |
| ---: | --- | --- | ---: | ---: | --- |
| — | **Bernadette** | cash | +25 | jamais | gratuit |
| — | **Roberte** | cash | +39 | 0,4 % | 200 alcool · 200 herbe · 200 poudre |
| — | **L’Okrainienne** | cash | +53 | 0,8 % | 600 alcool · 600 herbe · 600 poudre |
| — | **La Bailandaise** | cash | +67 | 1,2 % | 1 400 alcool · 1 400 herbe · 1 400 poudre |
| 26 | **La Gitanella** | cash | +81 | 1,6 % | 3 000 alcool · 3 000 herbe · 3 000 poudre |
| 32 | **La Russipoff** 🔒 | cash | — | — | — |
| 41 | **La Ritalienne** 🔒 | cash | — | — | — |
| 48 | **La Monagasque** 🔒 | cash | — | — | — |
| 55 | **Carla Borgan** 🔒 | cash | — | — | — |

*🔒 unités dont le jeu ne sert pas encore la fiche (niveau de personnage requis). « — » dans la colonne niveau : disponible sans condition de niveau.*

## Les narcos

Ils fabriquent la marchandise : alcool, herbe, poudre.

| Nv. requis | Unité | Produit | Production / tour | Risque d’arrestation | Coût |
| ---: | --- | --- | ---: | ---: | --- |
| — | **Apprentice distiller** | alcohol | +8 | 1,6 % | 300 $ |
| — | **Apprentice herbalist** | weed | +8 | 1,6 % | 300 $ |
| — | **Apprentice chemist** | powder | +8 | 1,6 % | 300 $ |
| — | **Distiller** | alcohol | +30 | 3,2 % | 1 500 $ |
| — | **Herbalist** | weed | +30 | 3,2 % | 1 500 $ |
| — | **Chemist** | powder | +30 | 3,2 % | 1 500 $ |
| 22 | **Expert distiller** | alcohol | +100 | 4,8 % | 5 000 $ |
| 23 | **Expert herbalist** | weed | +100 | 4,8 % | 5 000 $ |
| 24 | **Expert chemist** | powder | +100 | 4,8 % | 5 000 $ |
| 43 | **Al Kapone** 🔒 | alcohol | — | — | — |
| 44 | **Bob Morley** 🔒 | weed | — | — | — |
| 45 | **Walter Right** 🔒 | powder | — | — | — |

*🔒 unités dont le jeu ne sert pas encore la fiche (niveau de personnage requis). « — » dans la colonne niveau : disponible sans condition de niveau.*
