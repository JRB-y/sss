import { cardStats } from './analyse.mjs';
import { atTypeLevel, RARITIES, FAMILIES, itemFr } from './gear.mjs';

/* L'arsenal : ce que vaut chaque objet, affixes ET bonus intrinsèque.

   Le jeu publie les affixes (tirés à la forge) mais pas le bonus propre de l'objet et de sa
   rareté — qui est pourtant gros : à type et niveau égaux, un bandit vaut 3 608 PV en Leather
   jacket et 4 440 en Tactical vest. On l'ESTIME donc par recoupement sur l'archive :

   — chaque pile observée (les deux camps, tous les combats) donne un résidu :
       PV      : unitHp ÷ (base_du_type_au_niveau × (1 + affixes de vie))
       dégâts  : tirage médian mesuré ÷ (base × (1 + affixes de dégâts))
       vitesse : intervalle théorique (base ÷ affixes) ÷ intervalle mesuré
   — ce résidu mélange DEUX choses : les talents du joueur (constants chez lui) et le bonus
     intrinsèque des objets portés. On sépare les deux par médianes alternées : estimer les
     objets à joueurs fixés, puis les joueurs à objets fixés, dix fois ;
   — l'échelle est ancrée sur le plus faible objet observé de chaque famille (bonus 0) : les
     estimations sont RELATIVES — exactement ce qu'il faut pour comparer deux pièces ou chiffrer
     une forge, et le simulateur travaille en delta par rapport à l'équipement porté, donc
     l'ancrage s'annule ;
   — l'attribution par créneau : la vie à la protection, les dégâts à l'arme, la vitesse à
     l'objet qui la porte (deux passes). Le bonus propre des porte-bonheur ne peut pas être
     isolé avec les données actuelles : il reste dans le facteur du joueur, et c'est écrit.

   Tout est médian, jamais moyen : une pile mal reconstruite ne doit pas polluer un objet. */

const ITERATIONS = 10;
const MIN_OBS = 2; // en dessous, l'estimation est publiée mais marquée « fragile »

export function buildArsenal({ analysis, troops, items, skills }) {
    const gameLocale = troops?.gameLocale || null;
    const params = baseByType(troops);
    const talents = skills?.bonuses || null;
    const meId = analysis.account?.id ?? null;

    const obs = collectObservations(analysis, params, meId);
    const hp = separate(obs.hp, meId, talents ? (talents.hpPct || 0) : null);
    const dmg = separate(obs.dmg, meId, null);
    const speed = separateSpeed(obs.speed, meId, talents ? (talents.speedPct || 0) : null);

    /* Calibrage ABSOLU sur mes propres cartes : pour mes types, l'écart total « effectif ÷ base »
       est une vérité terrain (talents connus, affixes connus). Le décalage médian entre cette
       vérité et l'estimation relative recale toute l'échelle — et fait porter aux armures la part
       de vie (resp. aux armes la part de dégâts) que l'ancrage « plus faible = 0 » écrasait. */
    calibrateOnMyCards({ analysis, troops, talents, hp, dmg });

    // Fusion avec le catalogue d'affixes (data/items.json) : une entrée par objet × rareté.
    const out = [];
    for (const it of Object.values(items?.items || {})) {
        const rarities = [];
        for (const [r, rar] of Object.entries(it.rarities || {})) {
            const key = `${it.item}|${r}`;
            rarities.push({
                rarity: Number(r),
                fr: rar.fr || RARITIES[r]?.fr || `r${r}`,
                seen: rar.seen || 0,
                affixes: Object.fromEntries(Object.entries(rar.affixes || {})
                    .map(([stat, a]) => [stat, { min: a.min, max: a.max, unit: a.unit, fr: a.fr, seen: a.seen }])),
                intrinsic: {
                    hpPct: it.slot === 'armor' ? round1(hp.items.get(key)?.value) : null,
                    dmgPct: it.slot === 'weapon' ? round1(dmg.items.get(key)?.value) : null,
                    // La vitesse par pièce est publiée à titre INDICATIF : trop incertaine pour
                    // être appliquée dans le simulateur (voir la note de l'arsenal).
                    speedPct: (speed.items.get(key)?.n || 0) >= 10 ? round1(speed.items.get(key)?.value) : null,
                    n: it.slot === 'armor' ? (hp.items.get(key)?.n || 0)
                        : it.slot === 'weapon' ? (dmg.items.get(key)?.n || 0)
                            : (speed.items.get(key)?.n || 0),
                    solid: (it.slot === 'armor' ? hp.items.get(key)?.n || 0
                        : it.slot === 'weapon' ? dmg.items.get(key)?.n || 0
                            : speed.items.get(key)?.n || 0) >= MIN_OBS,
                },
            });
        }
        out.push({
            item: it.item,
            name: it.name,
            fr: itemFr(it.item, it.name, gameLocale),
            slot: it.slot,
            slotFr: it.slotFr || FAMILIES[it.slot]?.fr || it.slot,
            icon: it.icon,
            seen: it.seen,
            seenMine: it.seenMine || 0,
            onTypes: it.onTypes || {},
            rarities: rarities.sort((a, b) => a.rarity - b.rarity),
        });
    }
    out.sort((a, b) => (a.slot === b.slot ? b.seen - a.seen : a.slot.localeCompare(b.slot)));

    return {
        items: out,
        players: hp.players.size + dmg.players.size,
        note: 'bonus intrinsèques ESTIMÉS par recoupement (médianes alternées, échelle ancrée sur '
            + 'l’objet le plus faible de chaque famille) : vie → protections, dégâts → armes, '
            + 'vitesse → l’objet qui la porte. Le bonus propre des porte-bonheur n’est pas isolable.',
    };
}

/** L'équipement que chaque type porte EN CE MOMENT : relevé dans son combat le plus récent. */
export function currentLoadouts(analysis) {
    const out = new Map();
    for (const f of analysis.fights) { // triés du plus récent au plus ancien
        for (const p of f.myPiles) {
            if (p.reinforcement || out.has(p.base) || !(p.gear || []).length) continue;
            out.set(p.base, p.gear.map((g) => ({
                slot: g.slot, item: g.item, name: g.name, fr: g.fr || g.name,
                rarity: g.rarity, rarityFr: g.rarityFr, affixes: g.affixes || {},
            })));
        }
    }
    return Object.fromEntries(out);
}

/**
 * Les stats d'un type avec un AUTRE équipement que celui porté — calculées en DELTA depuis les
 * stats réelles de la carte, pour que « même équipement » rende exactement les stats actuelles.
 *
 *   réel = (base + plats) × (1 + talents% + affixes% + intrinsèques%)
 *   nouveau = réel × (1 + tal + affNew + intrNew) ÷ (1 + tal + affCur + intrCur)
 *
 * et pour les stats en points (crit, riposte) : réel − affixesCur + affixesNew.
 */
export function applyLoadout(t, loadout, { talents = null, arsenal = null, current = null } = {}) {
    const tal = talents || {};
    const sum = (gear, stat) => (gear || []).reduce((a, g) => a + (g.affixes?.[stat] || 0), 0);
    const intr = (gear, field) => (gear || []).reduce((a, g) => {
        const it = arsenal?.items.find((x) => x.item === g.item);
        const r = it?.rarities.find((x) => x.rarity === g.rarity);
        return a + (r?.intrinsic?.[field] ?? 0);
    }, 0);

    const cur = current || [];
    const next = loadout || [];
    const ratio = (stat, field, talPct) => {
        const a = 1 + (talPct || 0) / 100 + (sum(cur, stat) + intr(cur, field)) / 100;
        const b = 1 + (talPct || 0) / 100 + (sum(next, stat) + intr(next, field)) / 100;
        return a > 0 ? b / a : 1;
    };

    const hpRatio = ratio('hp', 'hpPct', tal.hpPct);
    const dmgRatio = ratio('dmg', 'dmgPct', tal.dmgPct);
    // Vitesse : seuls les AFFIXES sont appliqués — le bonus caché par pièce est trop incertain
    // (il est affiché à titre indicatif dans l'arsenal, jamais injecté dans un calcul).
    const speedRatio = ratio('speed', '_none', tal.speedPct);

    return {
        ...t,
        unitHp: t.unitHp * hpRatio,
        dmgMin: t.dmgMin * dmgRatio,
        dmgMax: t.dmgMax * dmgRatio,
        dmgAvg: t.dmgAvg * dmgRatio,
        crit: Math.max(0, t.crit - sum(cur, 'crit') + sum(next, 'crit')),
        counter: Math.max(0, t.counter - sum(cur, 'riposte') + sum(next, 'riposte')),
        intervalCs: Math.max(1, Math.round(t.intervalCs / speedRatio)),
        speed: Math.max(0.01, t.intervalCs / speedRatio / 100),
        loadout: next,
        loadoutEstimated: next.some((g) => {
            const it = arsenal?.items.find((x) => x.item === g.item);
            const r = it?.rarities.find((x) => x.rarity === g.rarity);
            return r && r.intrinsic && r.intrinsic.solid === false;
        }),
    };
}

/* Le recalage sur mes cartes : pour chacun de mes types détaillés, la carte donne l'écart total
   « effectif ÷ base » dont on retire talents et affixes — il reste la somme des intrinsèques
   portés, mesurée exactement. On compare à l'estimation (armure pour la vie, arme pour les
   dégâts) et on décale toute l'échelle de la médiane des écarts. Les intrinsèques des deux autres
   créneaux sont ainsi portés par le décalage commun : approximation honnête, identique partout. */
function calibrateOnMyCards({ analysis, troops, talents, hp, dmg }) {
    const loadouts = currentLoadouts(analysis);
    const tal = talents || {};
    const hpGaps = [];
    const dmgGaps = [];
    for (const [id, card] of Object.entries(troops?.units || {})) {
        if (!id.startsWith('troops/') || !card.detailed) continue;
        const gear = loadouts[card.key];
        if (!gear) continue;
        const eff = cardStats(card);
        const base = cardStats(card, { base: true });
        const affix = (stat) => gear.reduce((a, g) => a + (g.affixes?.[stat] || 0), 0);
        const armor = gear.find((g) => g.slot === 'armor');
        const weapon = gear.find((g) => g.slot === 'weapon');
        if (armor && base.hp > 0) {
            const truth = (eff.hp / base.hp - 1) * 100 - (tal.hpPct || 0) - affix('hp');
            const est = hp.items.get(`${armor.item}|${armor.rarity}`)?.value;
            if (Number.isFinite(est)) hpGaps.push(truth - est);
        }
        if (weapon && base.avgDmg > 0) {
            const truth = (eff.avgDmg / (base.avgDmg + (tal.dmgFlat || 0)) - 1) * 100
                - (tal.dmgPct || 0) - affix('dmg');
            const est = dmg.items.get(`${weapon.item}|${weapon.rarity}`)?.value;
            if (Number.isFinite(est)) dmgGaps.push(truth - est);
        }
    }
    const shiftHp = hpGaps.length >= 2 ? median(hpGaps) : 0;
    const shiftDmg = dmgGaps.length >= 2 ? median(dmgGaps) : 0;
    for (const [k, x] of hp.items) hp.items.set(k, { ...x, value: x.value + shiftHp });
    for (const [k, x] of dmg.items) dmg.items.set(k, { ...x, value: x.value + shiftDmg });
    hp.shift = round1(shiftHp);
    dmg.shift = round1(shiftDmg);
}

/* ---------- Observations ---------- */

function baseByType(troops) {
    const map = new Map();
    for (const [id, card] of Object.entries(troops?.units || {})) {
        if (!id.startsWith('troops/') || !card.detailed) continue;
        const b = cardStats(card, { base: true });
        map.set(card.key, {
            unitHp: b.hp, dmgAvg: b.avgDmg, speed: b.speed, typeLevel: b.typeLevel,
        });
    }
    return map;
}

function collectObservations(analysis, params, meId) {
    const hp = [];
    const dmg = [];
    const speed = [];
    for (const f of analysis.fights) {
        for (const [who, piles, fortAgainst] of [
            ['me', f.myPiles, f.role === 'attaque' ? f.fort.theirs || 0 : 0],
            [String(f.opponent.id), f.theirPiles, f.role === 'défense' ? f.fort.mine || 0 : 0],
        ]) {
            for (const p of piles) {
                if (p.reinforcement && who === 'me') continue; // les renforts ont les stats d'un autre
                const base = params.get(p.base);
                if (!base || !(p.gear || []).length) continue;
                const lv = atTypeLevel(base, base.typeLevel, p.typeLevel ?? base.typeLevel);
                const player = p.reinforcement ? `reinf-${p.key}` : who;
                const armor = p.gear.find((g) => g.slot === 'armor');
                const weapon = p.gear.find((g) => g.slot === 'weapon');
                const affix = (stat) => p.gear.reduce((a, g) => a + (g.affixes?.[stat] || 0), 0);

                if (armor && p.unitHp > 0 && lv.unitHp > 0) {
                    hp.push({
                        player,
                        key: `${armor.item}|${armor.rarity}`,
                        value: p.unitHp / (lv.unitHp * (1 + affix('hp') / 100)),
                    });
                }
                if (weapon && Number.isFinite(p.rollMedian) && p.rollMedian > 0 && lv.dmgAvg > 0) {
                    dmg.push({
                        player,
                        key: `${weapon.item}|${weapon.rarity}`,
                        value: (p.rollMedian / (1 - fortAgainst / 100)) / (lv.dmgAvg * (1 + affix('dmg') / 100)),
                    });
                }
                if (p.intervalCs && base.speed > 0) {
                    // Plus rapide que la théorie = bonus caché. Le résidu est attribué à CHAQUE
                    // pièce portée (une observation par pièce), puis corrigé en 2e passe.
                    const theory = Math.round((base.speed * 100) / (1 + affix('speed') / 100));
                    const residual = theory / p.intervalCs;
                    for (const g of p.gear) {
                        speed.push({ player, key: `${g.item}|${g.rarity}`, others: p.gear.filter((x) => x !== g).map((x) => `${x.item}|${x.rarity}`), value: residual });
                    }
                }
            }
        }
    }
    return { hp, dmg, speed };
}

/* Médianes alternées : résidu = facteur_joueur × (1 + intrinsèque/100).
   `meTalentPct` ancre le facteur du joueur « me » quand on le connaît (mes talents) ; sinon
   l'échelle est ramenée à « plus faible objet = 0 ». */
function separate(obs, meId, meTalentPct) {
    void meId;
    const items = new Map();
    const players = new Map();
    for (const o of obs) {
        players.set(o.player, 1);
        if (!items.has(o.key)) items.set(o.key, { value: 0, n: 0 });
    }
    for (let i = 0; i < ITERATIONS; i += 1) {
        // objets à joueurs fixés
        const perItem = new Map();
        for (const o of obs) (perItem.get(o.key) || perItem.set(o.key, []).get(o.key)).push(o.value / players.get(o.player));
        for (const [k, xs] of perItem) items.set(k, { value: median(xs), n: xs.length });
        // joueurs à objets fixés
        const perPlayer = new Map();
        for (const o of obs) {
            const it = items.get(o.key);
            if (it?.value) (perPlayer.get(o.player) || perPlayer.set(o.player, []).get(o.player)).push(o.value / it.value);
        }
        for (const [p, xs] of perPlayer) players.set(p, median(xs) || 1);
    }
    // Ancrage : objet le plus faible = 0 % (bonus relatifs).
    const floor = Math.min(...[...items.values()].filter((x) => x.n >= MIN_OBS).map((x) => x.value), Infinity);
    const anchor = Number.isFinite(floor) && floor > 0 ? floor : 1;
    for (const [k, x] of items) items.set(k, { value: (x.value / anchor - 1) * 100, n: x.n });
    void meTalentPct;
    return { items, players };
}

/* La vitesse : chaque pile donne une observation par pièce portée, le résidu étant le PRODUIT des
   trois bonus. Deux passes : d'abord comme `separate`, puis chaque observation est corrigée des
   deux autres pièces estimées, et on re-médiane. */
function separateSpeed(obs, meId, meTalentPct) {
    const first = separate(obs, meId, meTalentPct);
    const items = new Map();
    const est = (k) => 1 + Math.max(0, first.items.get(k)?.value || 0) / 100;
    const perItem = new Map();
    for (const o of obs) {
        const corrected = (o.value / first.players.get(o.player)) / o.others.reduce((a, k) => a * est(k), 1);
        (perItem.get(o.key) || perItem.set(o.key, []).get(o.key)).push(corrected);
    }
    for (const [k, xs] of perItem) items.set(k, { value: median(xs), n: xs.length });
    const floor = Math.min(...[...items.values()].filter((x) => x.n >= MIN_OBS).map((x) => x.value), Infinity);
    const anchor = Number.isFinite(floor) && floor > 0 ? floor : 1;
    for (const [k, x] of items) items.set(k, { value: (x.value / anchor - 1) * 100, n: x.n });
    return { items, players: first.players };
}

function median(xs) {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return NaN;
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
