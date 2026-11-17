# Sand Sea Sun — Les objets

> Relevé des équipements croisés dans les rapports de combat : les tiens et ceux de tes
> adversaires. Chaque troupe porte trois emplacements — une arme, une protection, un porte-bonheur.

*28 objets vus sur 61 combats archivés, dernière mise à jour le 2026-11-17. Document généré : relance `npm run enemies` pour le rafraîchir.*

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
| **AK-47** | `ak47` | 139 | 64 | Commun ×8, Rare ×131 | Critique 2–5 pts · Vitesse 2,5–5 % · Dégâts 4–7,5 % |
| **Brass knuckles** | `knuckles` | 106 | 61 | Épique ×95, Légendaire ×9, Exotique ×2 | Critique 1–7 pts · Vitesse 1,5–6,5 % · Dégâts 4–7 % |
| **Pump shotgun** | `shotgun` | 106 | 61 | Peu commun ×106 | — |
| **Uzzi** | `uzi` | 53 | — | Peu commun ×51, Rare ×2 | Critique 1–1,5 pts |
| **Combat knife** | `knife` | 49 | 47 | Peu commun ×47, Épique ×2 | Vitesse 6,5–6,5 % |
| **M16** | `m16` | 31 | — | Peu commun ×31 | — |
| **Glokk 17** | `glokk` | 22 | — | Commun ×4, Peu commun ×1, Rare ×11, Légendaire ×6 | Vitesse 4,5–4,5 % · Critique 4,5–4,5 pts · Dégâts 5–17,5 % |
| **Grenade launcher** | `little_friend` | 1 | — | Rare ×1 | Dégâts 4–4 % |
| **Spiked bat** | `bat` | 1 | — | Rare ×1 | Critique 3,5–3,5 pts |

## Protection

| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |
| --- | --- | ---: | ---: | --- | --- |
| **Ballistic helmet** | `ballistic` | 130 | 61 | Commun ×6, Rare ×121, Épique ×3 | Vitesse 2–4,5 % · Riposte 2–4,5 pts · Vie 2–7,5 % |
| **Riot shield** | `riot_shield` | 105 | 61 | Peu commun ×105 | — |
| **Reinforced suit** | `reinforced` | 102 | 46 | Rare ×102 | Riposte 1–5 pts · Vie 2–9 % · Vitesse 1–5 % |
| **Leather jacket** | `leather` | 69 | 48 | Peu commun ×64, Rare ×2, Épique ×2, Légendaire ×1 | Vie 3,5–6 % · Vitesse 1,5–3,5 % · Riposte 2,5–4 pts |
| **Heavy tactical vest** | `tactical` | 38 | 10 | Peu commun ×38 | — |
| **Bulletproof vest** | `vest` | 29 | — | Peu commun ×23, Épique ×6 | Vie 5,5–5,5 % · Vitesse 1–1 % |
| **Bomb suit** | `bomb_suit` | 29 | 3 | Peu commun ×29 | — |
| **Motorcycle helmet** | `helmet` | 4 | 4 | Peu commun ×4 | — |
| **Light Kevlar vest** | `light_vest` | 1 | — | Rare ×1 | Riposte 3–3 pts |
| **Iron Dude armor** | `juggernaut` | 1 | — | Épique ×1 | Vitesse 6,5–6,5 % · Vie 9–9 % |

## Porte-bonheur

| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |
| --- | --- | ---: | ---: | --- | --- |
| **Grandma's rosary** | `rosary` | 146 | 61 | Commun ×19, Peu commun ×117, Rare ×3, Légendaire ×7 | Dégâts 2,5–3,5 % · Vie 6–6 % · Riposte 4,5–4,5 pts |
| **Stolen gold watch** | `gold_watch` | 119 | 51 | Peu commun ×119 | — |
| **Rabbit's foot** | `rabbit_foot` | 58 | 58 | Peu commun ×58 | — |
| **Loaded dice** | `loaded_dice` | 57 | 49 | Commun ×2, Peu commun ×52, Épique ×3 | Dégâts 5,5–5,5 % · Vitesse 2–2 % |
| **The Godfather's signet ring** | `signet` | 51 | 10 | Peu commun ×51 | — |
| **Engraved Zipo** | `zippo` | 44 | — | Commun ×15, Peu commun ×25, Rare ×4 | Vitesse 1–1 % |
| **Golden horseshoe** | `horseshoe` | 18 | — | Rare ×18 | Riposte 3–4,5 pts · Dégâts 6,5–9,5 % · Critique 1–1 pts · Vie 4–4 % · Vitesse 2–2 % |
| **4-leaf clover** | `clover` | 11 | 3 | Commun ×7, Peu commun ×2, Rare ×2 | Vie 7,5–7,5 % |
| **The Capo's gold tooth** | `gold_tooth` | 3 | — | Rare ×3 | Dégâts 3,5–5 % |

## Bornes d’affixes par rareté

Ce que l’historique a montré, toutes pièces confondues. Plus la rareté est haute, plus l’objet porte d’affixes à la fois et plus leurs valeurs montent.

| Rareté | Pièces vues | Affixes par pièce | Bornes relevées |
| --- | ---: | ---: | --- |
| **Commun** | 61 | — | aucun |
| **Peu commun** | 923 | — | aucun |
| **Rare** | 402 | 1 | Critique 1–5 pts · Vitesse 1–5 % · Dégâts 2,5–9,5 % · Riposte 1–5 pts · Vie 2–9 % |
| **Épique** | 112 | 2 | Critique 1–7 pts · Vitesse 1–6,5 % · Dégâts 4–7 % · Vie 4–9 % · Riposte 2,5–2,5 pts |
| **Légendaire** | 23 | 3 | Dégâts 3,5–17,5 % · Critique 3–6 pts · Vitesse 1,5–3,5 % · Riposte 4–4,5 pts · Vie 6–6 % |
| **Exotique** | 2 | 3 | Critique 2,5–2,5 pts · Vitesse 6,5–6,5 % · Dégâts 6–6 % |

> Les bornes se resserrent à mesure que l’historique grossit : ce sont des minima et maxima **observés**, pas les bornes officielles du jeu.
