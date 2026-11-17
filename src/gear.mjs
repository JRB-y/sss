/* Équipement des troupes : objets, raretés et bonus.

   Chaque pile d'un rapport de combat porte son équipement complet, et c'est la seule source du
   jeu qui le donne pour un adversaire :

       gear: [{ ico, item, fam, r, rn, name, ax: [[stat, valeur], …], axl: ["+4% damage", …] }]

   — `fam`  : l'emplacement (weapon | armor | charm) ;
   — `item` : la clé de l'objet (ak47, reinforced, rosary…), 28 relevés à ce jour ;
   — `r`/`rn` : la rareté, 0 (Commun) → 5 (Exotique) ;
   — `ax`  : les affixes, c'est-à-dire les bonus *aléatoires* du tirage de l'objet. Cinq stats
     seulement : dmg, hp et speed en pourcentage, crit et riposte en points de pourcentage.

   Ce que le jeu ne donne PAS : le bonus *intrinsèque* d'un objet (celui qui vient de l'objet
   lui-même et de sa rareté, avant affixes). Il est pourtant bien réel et mesurable dans
   l'historique — à type et niveau de type constants, changer de protection déplace les PV
   unitaires (Leather 3 508 → Ballistic 3 860 → Reinforced 4 212 sur le même Lascar niv. 3), et
   les piles qui portent un affixe de vitesse frappent 10 % plus vite que les autres alors que
   l'affixe n'en promet que 1 à 6,5 %. On ne modélise donc PAS ces bonus intrinsèques : pour les
   piles d'un combat passé, les PV unitaires servis par le serveur et la cadence mesurée dans les
   événements sont la vérité, et les affixes ne corrigent que ce qu'ils expliquent seuls
   (critique, riposte, et la part « dégâts » que les PV ne disent pas). */

export const FAMILIES = {
    weapon: { fr: 'Arme', order: 0 },
    armor: { fr: 'Protection', order: 1 },
    charm: { fr: 'Porte-bonheur', order: 2 },
};

/** Rareté : le serveur sert l'indice (`r`) et son nom dans la langue du compte (`rn`). */
export const RARITIES = [
    { fr: 'Commun', key: 'common' },
    { fr: 'Peu commun', key: 'uncommon' },
    { fr: 'Rare', key: 'rare' },
    { fr: 'Épique', key: 'epic' },
    { fr: 'Légendaire', key: 'legendary' },
    { fr: 'Exotique', key: 'exotic' },
];

/* Les cinq stats qu'un affixe peut toucher. `kind` dit comment le bonus s'applique :
   — `pct`  : pourcentage multiplicatif sur la stat (dégâts, vie, vitesse) ;
   — `pts`  : points ajoutés à une probabilité déjà exprimée en pourcentage (critique, riposte). */
export const AFFIXES = {
    dmg: { fr: 'Dégâts', kind: 'pct', unit: '%', stat: 'dmgAvg' },
    hp: { fr: 'Vie', kind: 'pct', unit: '%', stat: 'unitHp' },
    speed: { fr: 'Vitesse', kind: 'pct', unit: '%', stat: 'speed' },
    crit: { fr: 'Critique', kind: 'pts', unit: 'pts', stat: 'crit' },
    riposte: { fr: 'Riposte', kind: 'pts', unit: 'pts', stat: 'counter' },
};

export const AFFIX_KEYS = Object.keys(AFFIXES);

/* Noms français des objets.

   Le jeu sert le nom d'un objet dans la langue du COMPTE (`boot.locale`), et ce compte est en
   anglais : les rapports de combat donnent donc « Brass knuckles », pas « Poing américain ».
   Aucune vue du jeu ni aucune page publique ne publie la liste traduite (vérifié : règles dans
   les cinq langues, vues du téléphone, bundle `app.js` — l'i18n du client ne couvre que les
   libellés d'interface, pas le catalogue d'objets).

   Cette table est donc une **traduction maison**, utilisée uniquement tant que le jeu répond en
   anglais : si tu passes ton compte en français, `itemFr()` reprend automatiquement le nom servi
   par le jeu, qui fait autorité. */
export const ITEM_FR = {
    // armes
    ak47: 'AK-47',
    knuckles: 'Poing américain',
    shotgun: 'Fusil à pompe',
    uzi: 'Uzi',
    knife: 'Couteau de combat',
    m16: 'M16',
    glokk: 'Glokk 17',
    bat: 'Batte cloutée',
    little_friend: 'Lance-grenades',
    sniper: 'Fusil de précision',
    // protections
    ballistic: 'Casque balistique',
    reinforced: 'Combinaison renforcée',
    riot_shield: 'Bouclier anti-émeute',
    leather: 'Blouson en cuir',
    tactical: 'Gilet tactique lourd',
    bomb_suit: 'Combinaison de déminage',
    vest: 'Gilet pare-balles',
    helmet: 'Casque de moto',
    juggernaut: 'Armure d’Iron Dude',
    light_vest: 'Gilet léger en Kevlar',
    // porte-bonheur
    rosary: 'Chapelet de mamie',
    gold_watch: 'Montre en or volée',
    zippo: 'Zippo gravé',
    rabbit_foot: 'Patte de lapin',
    signet: 'Chevalière du Parrain',
    loaded_dice: 'Dés pipés',
    horseshoe: 'Fer à cheval doré',
    clover: 'Trèfle à quatre feuilles',
    gold_tooth: 'Dent en or du Capo',
    santa_muerte: 'Médaille de la Santa Muerte',
};

/**
 * Le nom à afficher pour un objet.
 * @param item clé de l'objet (`knuckles`)
 * @param name nom servi par le jeu, dans la langue du compte
 * @param gameLocale langue du compte (`troops.gameLocale`)
 */
export function itemFr(item, name = null, gameLocale = null) {
    // Le jeu répond déjà en français : son nom fait autorité, il est à jour par construction.
    if (gameLocale && gameLocale.startsWith('fr') && name) return name;
    return ITEM_FR[item] || name || item;
}

/** Un équipement normalisé, lisible et stable : c'est cette forme qui part en base et à l'écran. */
export function readGear(raw) {
    return (raw || []).map((g) => ({
        slot: g.fam || null,
        slotFr: FAMILIES[g.fam]?.fr || g.fam || null,
        item: g.item || null,
        name: g.name || g.item || null,
        // Nom français : traduction maison tant que le compte joue en anglais (cf. ITEM_FR).
        fr: ITEM_FR[g.item] || g.name || g.item || null,
        rarity: Number.isFinite(g.r) ? g.r : null,
        rarityFr: RARITIES[g.r]?.fr || g.rn || null,
        rarityName: g.rn || null,
        affixes: affixesOf(g),
        labels: g.axl || [],
    })).sort((a, b) => (FAMILIES[a.slot]?.order ?? 9) - (FAMILIES[b.slot]?.order ?? 9));
}

/** Affixes d'un seul objet, en objet plutôt qu'en paires. */
export function affixesOf(g) {
    const out = {};
    for (const [stat, value] of g?.ax || []) {
        if (!(stat in AFFIXES)) continue; // stat inconnue : on préfère l'ignorer que la deviner
        out[stat] = (out[stat] || 0) + Number(value || 0);
    }
    return out;
}

/** Somme des affixes des trois emplacements : ce que l'équipement apporte à la pile entière. */
export function gearBonuses(gear) {
    const out = { dmg: 0, hp: 0, speed: 0, crit: 0, riposte: 0 };
    for (const g of gear || []) {
        const affixes = g.affixes || affixesOf(g);
        for (const [stat, value] of Object.entries(affixes)) {
            if (stat in out) out[stat] += value;
        }
    }
    return out;
}

/** Vrai dès qu'un bonus est non nul (un équipement « nu » n'a que des objets sans affixe). */
export const hasBonuses = (bonuses) => AFFIX_KEYS.some((k) => (bonuses[k === 'riposte' ? 'riposte' : k] || 0) !== 0);

/* Empreinte d'un équipement : objet + rareté + affixes, par emplacement. Deux piles de même
   empreinte portent le même matériel — c'est ce qui permet de ne historiser qu'un changement
   réel au lieu d'une ligne par combat. */
export function gearSignature(gear) {
    return (gear || [])
        .map((g) => {
            const affixes = g.affixes || affixesOf(g);
            const bonus = Object.entries(affixes).sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => `${k}${v}`).join('+');
            return `${g.slot || g.fam}:${g.item}/r${g.rarity ?? g.r}${bonus ? `(${bonus})` : ''}`;
        })
        .sort()
        .join('|');
}

/** Libellé court d'un objet, pour une ligne de tableau : « AK-47 · Rare · +2 pts crit ». */
export function gearLabel(g) {
    const bonus = Object.entries(g.affixes || {})
        .map(([k, v]) => `${v > 0 ? '+' : ''}${fmtNum(v)} ${AFFIXES[k]?.unit === 'pts' ? 'pts' : '%'} ${AFFIXES[k]?.fr.toLowerCase() || k}`);
    return [g.fr || ITEM_FR[g.item] || g.name, g.rarityFr, ...bonus].filter(Boolean).join(' · ');
}

/* ---------- Application à des stats de type ---------- */

/**
 * Stats d'une pile équipée, à partir des stats **de base** du type (le type seul, sans talents
 * ni matériel) et de l'équipement relevé.
 *
 * Attention : les stats « réelles » de la carte du shop incluent déjà tes talents ET ton
 * équipement du moment. Ne jamais leur appliquer `applyGear` — on doublerait les bonus. Cette
 * fonction sert aux piles d'un combat (les miennes d'hier comme celles d'en face), dont on
 * connaît le matériel exact.
 */
export function applyGear(base, bonuses) {
    const g = bonuses || { dmg: 0, hp: 0, speed: 0, crit: 0, riposte: 0 };
    return {
        unitHp: mul(base.unitHp, g.hp),
        dmgAvg: mul(base.dmgAvg, g.dmg),
        crit: (base.crit || 0) + (g.crit || 0),
        counter: (base.counter || 0) + (g.riposte || 0),
        // La vitesse est un délai entre deux coups : « +4,5 % de vitesse » le raccourcit.
        speed: base.speed ? base.speed / (1 + (g.speed || 0) / 100) : base.speed,
    };
}

const mul = (v, pct) => (Number.isFinite(v) ? v * (1 + (pct || 0) / 100) : v);

/* Stats d'un type à un autre niveau de type.

   Les règles disent « +2 % de vie et de dégâts par niveau » sans préciser si les paliers se
   composent. Mesuré sur l'historique, à équipement **et** compte identiques : ils ne se composent
   pas, le bonus est **additif** sur la valeur du niveau 1.

       PV(niveau n) = PV(niveau 1) × (1 + 0,02 × (n − 1))

   La vérification est nette. En déduisant le facteur « talents + matériel » depuis la carte du
   shop, il doit rester constant d'un niveau à l'autre — et il l'est à la 4ᵉ décimale près avec le
   modèle additif (Bandit 1,2050 / 1,2051 / 1,2051 aux niveaux 1, 2 et 3 ; Lascar 1,3149 aux
   niveaux 3 et 4), là où un modèle composé dérive (1,2050 → 1,2047, 1,3143 → 1,3134).

   L'écart reste petit — 0,2 % au niveau 5, 1,6 % au niveau 50 — mais il va dans le sens de
   surestimer les hauts niveaux de type, c'est-à-dire exactement les adversaires qui comptent.

   `from` est le niveau auquel `base` est exprimé : les stats « de base » de la carte du shop sont
   servies au niveau de type **courant** du type, pas au niveau 1. */
export function atTypeLevel(base, from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return base;
    const f = (1 + 0.02 * (to - 1)) / (1 + 0.02 * (from - 1));
    return { ...base, unitHp: base.unitHp * f, dmgAvg: base.dmgAvg * f };
}

/* ---------- Catalogue d'objets ---------- */

/* Tout l'équipement croisé dans l'historique, regroupé par objet puis par rareté. Les bornes
   d'affixes se remplissent au fil des combats : c'est un relevé, pas une table officielle. */
export function buildItemCatalog(fights, { meId = null } = {}) {
    const items = new Map();

    for (const entry of Object.values(fights?.fights || {})) {
        const report = entry.detail?.fight?.report;
        if (!report) continue;
        const at = report.at || 0;
        for (const side of ['att', 'def']) {
            const own = meId != null && report[side].id === meId;
            for (const pile of report[side].piles || []) {
                for (const raw of pile.gear || []) {
                    if (!raw.item) continue;
                    const it = items.get(raw.item) || {
                        item: raw.item,
                        name: raw.name || raw.item,
                        fr: ITEM_FR[raw.item] || raw.name || raw.item,
                        slot: raw.fam || null,
                        slotFr: FAMILIES[raw.fam]?.fr || raw.fam || null,
                        icon: raw.ico || null,
                        seen: 0,
                        seenMine: 0,
                        firstSeenAt: at,
                        lastSeenAt: at,
                        onTypes: {},
                        rarities: {},
                    };
                    it.seen += 1;
                    if (own) it.seenMine += 1;
                    it.firstSeenAt = Math.min(it.firstSeenAt || at, at || it.firstSeenAt);
                    it.lastSeenAt = Math.max(it.lastSeenAt || at, at || it.lastSeenAt);
                    const base = String(pile.key || '').replace(/@.*/, '');
                    it.onTypes[base] = (it.onTypes[base] || 0) + 1;

                    const rk = String(raw.r ?? '?');
                    const rar = it.rarities[rk] || { rarity: raw.r ?? null, fr: RARITIES[raw.r]?.fr || raw.rn || null, seen: 0, affixes: {} };
                    rar.seen += 1;
                    const affixes = affixesOf(raw);
                    // Un objet d'une rareté donnée porte un nombre fixe d'affixes : on relève
                    // combien de fois chaque stat sort, et dans quelles bornes.
                    for (const [stat, value] of Object.entries(affixes)) {
                        const a = rar.affixes[stat] || { stat, fr: AFFIXES[stat].fr, unit: AFFIXES[stat].unit, seen: 0, min: value, max: value };
                        a.seen += 1;
                        a.min = Math.min(a.min, value);
                        a.max = Math.max(a.max, value);
                        rar.affixes[stat] = a;
                    }
                    rar.slots = Math.max(rar.slots || 0, Object.keys(affixes).length);
                    it.rarities[rk] = rar;
                    items.set(raw.item, it);
                }
            }
        }
    }

    const list = [...items.values()].sort((a, b) => (FAMILIES[a.slot]?.order ?? 9) - (FAMILIES[b.slot]?.order ?? 9)
        || b.seen - a.seen);
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        source: { fights: Object.keys(fights?.fights || {}).length },
        counts: {
            items: list.length,
            bySlot: Object.fromEntries(Object.keys(FAMILIES).map((k) => [k, list.filter((i) => i.slot === k).length])),
        },
        items: Object.fromEntries(list.map((i) => [i.item, i])),
    };
}

/* ---------- Document ---------- */

export function renderItemsDoc(catalog) {
    const items = Object.values(catalog.items || {});
    const out = [];
    out.push('# Sand Sea Sun — Les objets', '');
    out.push('> Relevé des équipements croisés dans les rapports de combat : les tiens et ceux de tes', '> adversaires. Chaque troupe porte trois emplacements — une arme, une protection, un porte-bonheur.', '');
    out.push(`*${items.length} objets vus sur ${catalog.source?.fights ?? 0} combats archivés, dernière mise à jour`
        + ` le ${day(catalog.updatedAt)}. Document généré : relance \`npm run enemies\` pour le rafraîchir.*`, '');

    out.push('## Comment lire une pièce d’équipement', '');
    out.push('Un objet apporte deux choses, et le jeu n’en expose clairement qu’une :', '');
    out.push('- des **affixes**, les bonus tirés au hasard à la forge. Le rapport de combat les donne'
        + ' explicitement (`+2 pts crit`, `+4 % damage`). Cinq stats possibles seulement :');
    for (const [key, a] of Object.entries(AFFIXES)) {
        out.push(`  - **${a.fr}** (\`${key}\`) — ${a.kind === 'pct' ? 'pourcentage multiplicatif' : 'points ajoutés à une probabilité'}, exprimé en ${a.unit} ;`);
    }
    out.push('- un **bonus intrinsèque**, celui de l’objet et de sa rareté. Le jeu ne l’écrit nulle part,'
        + ' mais il est mesurable : à type et niveau de type constants, passer d’un *Leather* à un'
        + ' *Reinforced suit* fait monter les PV unitaires d’un Lascar de 3 508 à 4 212, et les piles'
        + ' portant un affixe de vitesse frappent ~10 % plus vite quand l’affixe n’en promet que 1 à 6,5 %.'
        + ' Ce bonus n’est donc **pas modélisé** : pour une pile d’un combat passé, les PV unitaires servis'
        + ' par le serveur et la cadence mesurée dans les événements font foi.', '');
    out.push(`Les raretés, du plus commun au plus rare : ${RARITIES.map((r, i) => `**${r.fr}** (${i})`).join(' · ')}.`, '');

    for (const [slot, meta] of Object.entries(FAMILIES)) {
        const xs = items.filter((i) => i.slot === slot);
        if (!xs.length) continue;
        out.push(`## ${meta.fr}`, '');
        out.push('| Objet | Clé | Vu | Dont chez moi | Raretés relevées | Affixes relevés |');
        out.push('| --- | --- | ---: | ---: | --- | --- |');
        for (const i of xs) {
            const rars = Object.values(i.rarities).sort((a, b) => (a.rarity ?? 9) - (b.rarity ?? 9))
                .map((r) => `${r.fr} ×${r.seen}`).join(', ');
            const affixes = affixRanges(i);
            out.push(`| **${esc(i.fr || i.name)}** | \`${i.item}\` | ${i.seen} | ${i.seenMine || '—'} | ${rars || '—'} | ${affixes || '—'} |`);
        }
        out.push('');
    }

    out.push('## Bornes d’affixes par rareté', '');
    out.push('Ce que l’historique a montré, toutes pièces confondues. Plus la rareté est haute, plus'
        + ' l’objet porte d’affixes à la fois et plus leurs valeurs montent.', '');
    out.push('| Rareté | Pièces vues | Affixes par pièce | Bornes relevées |');
    out.push('| --- | ---: | ---: | --- |');
    for (const [idx, r] of RARITIES.entries()) {
        const all = items.flatMap((i) => (i.rarities[String(idx)] ? [i.rarities[String(idx)]] : []));
        if (!all.length) continue;
        const seen = all.reduce((a, x) => a + x.seen, 0);
        const perStat = new Map();
        for (const x of all) {
            for (const a of Object.values(x.affixes)) {
                const e = perStat.get(a.stat) || { ...a };
                e.min = Math.min(e.min, a.min);
                e.max = Math.max(e.max, a.max);
                perStat.set(a.stat, e);
            }
        }
        const slots = Math.max(0, ...all.map((x) => x.slots || 0));
        out.push(`| **${r.fr}** | ${seen} | ${slots || '—'} | `
            + `${[...perStat.values()].map((a) => `${a.fr} ${fmtNum(a.min)}–${fmtNum(a.max)} ${a.unit}`).join(' · ') || 'aucun'} |`);
    }
    out.push('');
    out.push('> Les bornes se resserrent à mesure que l’historique grossit : ce sont des minima et maxima'
        + ' **observés**, pas les bornes officielles du jeu.', '');

    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function affixRanges(item) {
    const perStat = new Map();
    for (const r of Object.values(item.rarities)) {
        for (const a of Object.values(r.affixes)) {
            const e = perStat.get(a.stat) || { ...a };
            e.min = Math.min(e.min, a.min);
            e.max = Math.max(e.max, a.max);
            perStat.set(a.stat, e);
        }
    }
    return [...perStat.values()].map((a) => `${a.fr} ${fmtNum(a.min)}–${fmtNum(a.max)} ${a.unit}`).join(' · ');
}

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-CA') : '—');
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
