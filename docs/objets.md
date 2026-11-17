# Sand Sea Sun — Les objets

> Relevé des équipements croisés dans les rapports de combat : les tiens et ceux de tes
> adversaires. Chaque troupe porte trois emplacements — une arme, une protection, un porte-bonheur.

*30 objets vus sur 80 combats archivés, dernière mise à jour le 2026-11-17. Document généré : relance `npm run enemies` pour le rafraîchir.*

## Comment lire une pièce d’équipement

Un objet apporte deux choses, et le jeu n’en expose clairement qu’une :

- des **affixes**, les bonus tirés au hasard à la forge. Le rapport de combat les donne explicitement (`+2 pts crit`, `+4 % damage`). Cinq stats possibles seulement :
  - **Dégâts** (`dmg`) — pourcentage multiplicatif, exprimé en % ;
  - **Vie** (`hp`) — pourcentage multiplicatif, exprimé en % ;
  - **Vitesse** (`speed`) — pourcentage multiplicatif, exprimé en % ;
  - **Critique** (`crit`) — points ajoutés à une probabilité, exprimé en pts ;
  - **Riposte** (`riposte`) — points ajoutés à une probabilité, exprimé en pts ;
- un **bonus intrinsèque**, celui de l’objet et de sa rareté. Le jeu ne l’écrit nulle part, mais il est mesurable : à type et niveau de type constants, passer d’un *Leather* à un *Reinforced suit* fait monter les PV unitaires d’un Lascar de 3 508 à 4 212, et les piles portant un affixe de vitesse frappent ~10 % plus vite quand l’affixe n’en promet que 1 à 6,5 %. Ce bonus n’est donc **pas modélisé** : pour une pile d’un combat passé, les PV unitaires servis par le serveur et la cadence mesurée dans les événements font foi.

Les raretés, du plus commun au plus rare : **Commun** (0) · **Peu commun** (1) · **Rare** (2) · **Épique** (3) · **Légendaire** (4) · **Exotique** (5).

## Arme

| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |
| --- | --- | ---: | ---: | --- | --- |
| **AK-47** | `ak47` | 178 | 82 | Commun ×8, Rare ×170 | Critique 2–5 pts · Vitesse 2–5 % · Dégâts 2,5–7,5 % |
| **Poing américain** | `knuckles` | 141 | 79 | Épique ×125, Légendaire ×12, Exotique ×4 | Critique 1–7 pts · Vitesse 1,5–6,5 % · Dégâts 4–16,5 % |
| **Fusil à pompe** | `shotgun` | 137 | 79 | Peu commun ×137 | — |
| **Uzi** | `uzi` | 70 | — | Peu commun ×65, Rare ×5 | Critique 1–1,5 pts · Dégâts 6–8,5 % |
| **Couteau de combat** | `knife` | 67 | 65 | Peu commun ×65, Épique ×2 | Vitesse 6,5–6,5 % |
| **M16** | `m16` | 34 | — | Peu commun ×34 | — |
| **Glokk 17** | `glokk` | 28 | — | Commun ×10, Peu commun ×1, Rare ×11, Légendaire ×6 | Vitesse 4,5–4,5 % · Critique 4,5–4,5 pts · Dégâts 5–17,5 % |
| **Batte cloutée** | `bat` | 4 | — | Rare ×4 | Critique 3,5–3,5 pts |
| **Lance-grenades** | `little_friend` | 1 | — | Rare ×1 | Dégâts 4–4 % |
| **Fusil de précision** | `sniper` | 1 | — | Rare ×1 | Dégâts 3,5–3,5 % |

## Protection

| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |
| --- | --- | ---: | ---: | --- | --- |
| **Casque balistique** | `ballistic` | 172 | 79 | Commun ×9, Rare ×160, Épique ×3 | Vitesse 2–4,5 % · Riposte 1–4,5 pts · Vie 2–7,5 % |
| **Combinaison renforcée** | `reinforced` | 135 | 64 | Rare ×135 | Riposte 1–5 pts · Vie 2–9 % · Vitesse 1–5 % |
| **Bouclier anti-émeute** | `riot_shield` | 117 | 61 | Peu commun ×117 | — |
| **Blouson en cuir** | `leather` | 77 | 48 | Peu commun ×72, Rare ×2, Épique ×2, Légendaire ×1 | Vie 3,5–6 % · Vitesse 1,5–3,5 % · Riposte 2,5–4 pts |
| **Gilet tactique lourd** | `tactical` | 60 | 28 | Peu commun ×60 | — |
| **Combinaison de déminage** | `bomb_suit` | 42 | 3 | Peu commun ×42 | — |
| **Gilet pare-balles** | `vest` | 33 | — | Peu commun ×27, Épique ×6 | Vie 5,5–5,5 % · Vitesse 1–1 % |
| **Casque de moto** | `helmet` | 22 | 22 | Peu commun ×22 | — |
| **Armure d’Iron Dude** | `juggernaut` | 2 | — | Rare ×1, Épique ×1 | Vie 9–9 % · Vitesse 6,5–6,5 % |
| **Gilet léger en Kevlar** | `light_vest` | 1 | — | Rare ×1 | Riposte 3–3 pts |

## Porte-bonheur

| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |
| --- | --- | ---: | ---: | --- | --- |
| **Chapelet de mamie** | `rosary` | 164 | 61 | Commun ×19, Peu commun ×133, Rare ×5, Légendaire ×7 | Dégâts 2,5–3,5 % · Vie 6–6 % · Riposte 4,5–4,5 pts |
| **Montre en or volée** | `gold_watch` | 143 | 51 | Peu commun ×142, Rare ×1 | Dégâts 3,5–3,5 % |
| **Zippo gravé** | `zippo` | 84 | 18 | Commun ×15, Peu commun ×65, Rare ×4 | Vitesse 1–1 % |
| **Patte de lapin** | `rabbit_foot` | 76 | 76 | Peu commun ×76 | — |
| **Chevalière du Parrain** | `signet` | 76 | 28 | Peu commun ×76 | — |
| **Dés pipés** | `loaded_dice` | 75 | 67 | Commun ×2, Peu commun ×70, Épique ×3 | Dégâts 5,5–5,5 % · Vitesse 2–2 % |
| **Fer à cheval doré** | `horseshoe` | 20 | — | Peu commun ×1, Rare ×19 | Riposte 3–4,5 pts · Dégâts 6,5–9,5 % · Critique 1–1 pts · Vie 4–4 % · Vitesse 2–2 % |
| **Trèfle à quatre feuilles** | `clover` | 16 | 3 | Commun ×10, Peu commun ×2, Rare ×2, Épique ×2 | Vie 7,5–7,5 % · Critique 3,5–3,5 pts · Vitesse 1,5–1,5 % |
| **Dent en or du Capo** | `gold_tooth` | 3 | — | Rare ×3 | Dégâts 3,5–5 % |
| **Médaille de la Santa Muerte** | `santa_muerte` | 3 | — | Rare ×3 | Critique 3–3 pts |

## Bornes d’affixes par rareté

Ce que l’historique a montré, toutes pièces confondues. Plus la rareté est haute, plus l’objet porte d’affixes à la fois et plus leurs valeurs montent.

| Rareté | Pièces vues | Affixes par pièce | Bornes relevées |
| --- | ---: | ---: | --- |
| **Commun** | 73 | — | aucun |
| **Peu commun** | 1207 | — | aucun |
| **Rare** | 528 | 1 | Critique 1–5 pts · Vitesse 1–5 % · Dégâts 2,5–9,5 % · Riposte 1–5 pts · Vie 2–9 % |
| **Épique** | 144 | 2 | Critique 1–7 pts · Vitesse 1–6,5 % · Dégâts 4–7 % · Vie 4–9 % · Riposte 2,5–2,5 pts |
| **Légendaire** | 26 | 3 | Dégâts 3,5–17,5 % · Critique 3–6 pts · Vitesse 1,5–3,5 % · Riposte 4–4,5 pts · Vie 6–6 % |
| **Exotique** | 4 | 3 | Critique 2,5–2,5 pts · Vitesse 6,5–6,5 % · Dégâts 6–16,5 % |

> Les bornes se resserrent à mesure que l’historique grossit : ce sont des minima et maxima **observés**, pas les bornes officielles du jeu.
