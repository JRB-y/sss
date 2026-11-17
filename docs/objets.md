# Sand Sea Sun — Les objets

> Relevé des équipements croisés dans les rapports de combat : les tiens et ceux de tes
> adversaires. Chaque troupe porte trois emplacements — une arme, une protection, un porte-bonheur.

*30 objets vus sur 74 combats archivés, dernière mise à jour le 2026-11-17. Document généré : relance `npm run enemies` pour le rafraîchir.*

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
| **AK-47** | `ak47` | 165 | 76 | Commun ×8, Rare ×157 | Critique 2–5 pts · Vitesse 2–5 % · Dégâts 4–7,5 % |
| **Brass knuckles** | `knuckles` | 130 | 73 | Épique ×116, Légendaire ×11, Exotique ×3 | Critique 1–7 pts · Vitesse 1,5–6,5 % · Dégâts 4–16,5 % |
| **Pump shotgun** | `shotgun` | 128 | 73 | Peu commun ×128 | — |
| **Uzzi** | `uzi` | 66 | — | Peu commun ×61, Rare ×5 | Critique 1–1,5 pts · Dégâts 6–8,5 % |
| **Combat knife** | `knife` | 61 | 59 | Peu commun ×59, Épique ×2 | Vitesse 6,5–6,5 % |
| **M16** | `m16` | 32 | — | Peu commun ×32 | — |
| **Glokk 17** | `glokk` | 26 | — | Commun ×8, Peu commun ×1, Rare ×11, Légendaire ×6 | Vitesse 4,5–4,5 % · Critique 4,5–4,5 pts · Dégâts 5–17,5 % |
| **Spiked bat** | `bat` | 4 | — | Rare ×4 | Critique 3,5–3,5 pts |
| **Grenade launcher** | `little_friend` | 1 | — | Rare ×1 | Dégâts 4–4 % |
| **Sniper rifle** | `sniper` | 1 | — | Rare ×1 | Dégâts 3,5–3,5 % |

## Protection

| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |
| --- | --- | ---: | ---: | --- | --- |
| **Ballistic helmet** | `ballistic` | 159 | 73 | Commun ×9, Rare ×147, Épique ×3 | Vitesse 2–4,5 % · Riposte 1–4,5 pts · Vie 2–7,5 % |
| **Reinforced suit** | `reinforced` | 125 | 58 | Rare ×125 | Riposte 1–5 pts · Vie 2–9 % · Vitesse 1–5 % |
| **Riot shield** | `riot_shield` | 114 | 61 | Peu commun ×114 | — |
| **Leather jacket** | `leather` | 76 | 48 | Peu commun ×71, Rare ×2, Épique ×2, Légendaire ×1 | Vie 3,5–6 % · Vitesse 1,5–3,5 % · Riposte 2,5–4 pts |
| **Heavy tactical vest** | `tactical` | 53 | 22 | Peu commun ×53 | — |
| **Bomb suit** | `bomb_suit` | 39 | 3 | Peu commun ×39 | — |
| **Bulletproof vest** | `vest` | 29 | — | Peu commun ×23, Épique ×6 | Vie 5,5–5,5 % · Vitesse 1–1 % |
| **Motorcycle helmet** | `helmet` | 16 | 16 | Peu commun ×16 | — |
| **Iron Dude armor** | `juggernaut` | 2 | — | Rare ×1, Épique ×1 | Vie 9–9 % · Vitesse 6,5–6,5 % |
| **Light Kevlar vest** | `light_vest` | 1 | — | Rare ×1 | Riposte 3–3 pts |

## Porte-bonheur

| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |
| --- | --- | ---: | ---: | --- | --- |
| **Grandma's rosary** | `rosary` | 156 | 61 | Commun ×19, Peu commun ×127, Rare ×3, Légendaire ×7 | Dégâts 2,5–3,5 % · Vie 6–6 % · Riposte 4,5–4,5 pts |
| **Stolen gold watch** | `gold_watch` | 137 | 51 | Peu commun ×136, Rare ×1 | Dégâts 3,5–3,5 % |
| **Engraved Zipo** | `zippo` | 71 | 12 | Commun ×15, Peu commun ×52, Rare ×4 | Vitesse 1–1 % |
| **Rabbit's foot** | `rabbit_foot` | 70 | 70 | Peu commun ×70 | — |
| **Loaded dice** | `loaded_dice` | 69 | 61 | Commun ×2, Peu commun ×64, Épique ×3 | Dégâts 5,5–5,5 % · Vitesse 2–2 % |
| **The Godfather's signet ring** | `signet` | 68 | 22 | Peu commun ×68 | — |
| **Golden horseshoe** | `horseshoe` | 20 | — | Peu commun ×1, Rare ×19 | Riposte 3–4,5 pts · Dégâts 6,5–9,5 % · Critique 1–1 pts · Vie 4–4 % · Vitesse 2–2 % |
| **4-leaf clover** | `clover` | 16 | 3 | Commun ×10, Peu commun ×2, Rare ×2, Épique ×2 | Vie 7,5–7,5 % · Critique 3,5–3,5 pts · Vitesse 1,5–1,5 % |
| **The Capo's gold tooth** | `gold_tooth` | 3 | — | Rare ×3 | Dégâts 3,5–5 % |
| **Santa Muerte medal** | `santa_muerte` | 3 | — | Rare ×3 | Critique 3–3 pts |

## Bornes d’affixes par rareté

Ce que l’historique a montré, toutes pièces confondues. Plus la rareté est haute, plus l’objet porte d’affixes à la fois et plus leurs valeurs montent.

| Rareté | Pièces vues | Affixes par pièce | Bornes relevées |
| --- | ---: | ---: | --- |
| **Commun** | 71 | — | aucun |
| **Peu commun** | 1117 | — | aucun |
| **Rare** | 490 | 1 | Critique 1–5 pts · Vitesse 1–5 % · Dégâts 2,5–9,5 % · Riposte 1–5 pts · Vie 2–9 % |
| **Épique** | 135 | 2 | Critique 1–7 pts · Vitesse 1–6,5 % · Dégâts 4–7 % · Vie 4–9 % · Riposte 2,5–2,5 pts |
| **Légendaire** | 25 | 3 | Dégâts 3,5–17,5 % · Critique 3–6 pts · Vitesse 1,5–3,5 % · Riposte 4–4,5 pts · Vie 6–6 % |
| **Exotique** | 3 | 3 | Critique 2,5–2,5 pts · Vitesse 6,5–6,5 % · Dégâts 6–16,5 % |

> Les bornes se resserrent à mesure que l’historique grossit : ce sont des minima et maxima **observés**, pas les bornes officielles du jeu.
