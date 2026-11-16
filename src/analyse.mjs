import { config } from './config.mjs';
import { readJson } from './util.mjs';

/* Analyse de l'historique de combats — uniquement du mesuré, rien de modélisé.

   Ce qu'un rapport (`detail.fight.report`) contient vraiment, une fois décodé :
   — `att` / `def` : les piles engagées (type, quantité, PV unitaires, rôle, capacité, équipement,
     `dealt` = dégâts totaux infligés par la pile) et `def.fort` = la réduction de dégâts des
     fortifications du défenseur ;
   — `events` : la frise complète du combat, un tableau par coup porté
     `[t, camp, typeAttaquant, typeCible, dégâts, unitésVivantes, riposte]`.
     `t` est en centièmes de seconde (une pile frappe tous les `vitesse × 100` ticks, et
     `result.cs` donne la durée du combat dans la même unité) ; `unitésVivantes` vaut 0 quand la
     pile est au complet ; `riposte` est le coup rendu par la cible, qui compte comme des dégâts
     subis par l'attaquant ;
   — `abilities` : les capacités déclenchées `[t, camp, clé, charge, %PV restants]` ;
   — `abNeed` / `abOn` : le seuil d'activation retenu par le serveur (10 % des places) et les
     capacités qui ont réellement fonctionné. C'est la mesure la plus utile du lot : elle dit
     quelles capacités une compo a gaspillées.

   Les dégâts d'une pile valent `unitésVivantes × tirage(min..max) × (critique ? 1,5 : 1) ×
   (1 − fort)`, et les unités vivantes suivent la part de PV restante du groupe. Vérifié coup par
   coup sur l'historique : voir `mechanics` dans le résultat. */

/** Capacités du jeu, clés canoniques telles que le serveur les nomme (`report.abilityNames`). */
export const ABILITY_FR = {
    ambush: 'Embuscade',
    freeze: 'Gel du temps',
    frenzy: 'Frénésie',
    shield: 'Bouclier',
    shockwave: 'Onde de choc',
    execute: 'Coup de grâce',
    rage: 'Rage',
    fortress: 'Forteresse',
    second_wind: 'Second souffle',
    last_stand: 'Dernier carré',
    intimidate: 'Intimidation',
    bleed: 'Saignée',
    reflect: 'Renvoi',
    corrupt: 'Corruption',
};

export const ROLE_FR = { fast: 'Rapide', heavy: 'Cogneur', guard: 'Défenseur', allround: 'Polyvalent' };

export async function loadAnalysis() {
    const fights = await readJson(config.paths.fights);
    const troops = await readJson(config.paths.troops);
    if (!fights || !Object.keys(fights.fights || {}).length) {
        return { empty: true, reason: 'Aucun combat en base : lance « Récupérer les combats » d’abord.' };
    }
    return analyse(fights, troops);
}

export function analyse(db, troops) {
    const meId = guessMyId(db);
    const rows = [];
    const reports = [];

    for (const [id, entry] of Object.entries(db.fights)) {
        const report = entry.detail?.fight?.report;
        if (!report) continue;
        rows.push(readFight(id, entry, report, meId));
        reports.push(report);
    }
    rows.sort((a, b) => b.at - a.at);

    return {
        empty: false,
        account: { name: db.account || null, id: meId },
        updatedAt: db.updatedAt || null,
        fights: rows,
        record: record(rows),
        points: points(rows),
        myTypes: myTypes(rows, troops),
        abilities: abilities(rows),
        opponents: opponents(rows),
        mechanics: mechanics(rows, reports, meId),
    };
}

/** Le compte est l'identité présente dans tous les combats, attaque comme défense. */
function guessMyId(db) {
    const tally = new Map();
    for (const entry of Object.values(db.fights)) {
        const r = entry.detail?.fight?.report;
        if (!r) continue;
        for (const side of ['att', 'def']) tally.set(r[side].id, (tally.get(r[side].id) || 0) + 1);
    }
    return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/* ---------- Un combat ---------- */

function readFight(id, entry, report, meId) {
    const mine = report.att.id === meId ? 'att' : 'def';
    const theirs = mine === 'att' ? 'def' : 'att';
    const sideIdx = mine === 'att' ? 0 : 1;
    const cs = report.result?.cs || 0;

    // Dégâts subis par pile : les coups reçus plus les ripostes rendues en frappant.
    const taken = { att: {}, def: {} };
    const hits = { att: {}, def: {} };
    const dpu = { att: {}, def: {} }; // dégâts par unité vivante, coup par coup
    for (const [, side, from, to, dmg, alive, counter] of report.events || []) {
        const me = side === 0 ? 'att' : 'def';
        const foe = side === 0 ? 'def' : 'att';
        taken[foe][to] = (taken[foe][to] || 0) + dmg;
        hits[me][from] = (hits[me][from] || 0) + 1;
        const qty = alive || report[me].piles.find((p) => p.key === from)?.qty || 0;
        if (qty) (dpu[me][from] ||= []).push(dmg / qty);
        if (counter) {
            taken[me][from] = (taken[me][from] || 0) + counter;
            // La riposte est portée par la cible : on la compte dans ses dégâts infligés.
            taken[foe][to] = taken[foe][to];
        }
    }

    const pile = (side, p) => ({
        key: p.key,
        base: p.key.replace(/@.*/, ''),
        name: p.name,
        owner: p.owner || null,
        qty: p.qty,
        unitHp: p.unitHp,
        hp: p.hp,
        max: p.max,
        typeLevel: p.level,
        role: p.role,
        ability: p.ability,
        dealt: p.dealt,
        taken: taken[side][p.key] || 0,
        hits: hits[side][p.key] || 0,
        dpuPerHit: median(dpu[side][p.key] || []),
        gear: (p.gear || []).map((g) => ({ item: g.item, name: g.name, rarity: g.r, bonuses: g.axl || [] })),
        reinforcement: Boolean(p.owner),
    });

    const myPiles = report[mine].piles.map((p) => pile(mine, p));
    const theirPiles = report[theirs].piles.map((p) => pile(theirs, p));
    const sum = (ps, f) => ps.reduce((a, p) => a + f(p), 0);

    return {
        id: Number(id),
        at: report.at || entry.summary?.at || 0,
        role: mine === 'att' ? 'attaque' : 'défense',
        won: report.result?.winner === mine,
        cs,
        seconds: cs / 100,
        opponent: { id: report[theirs].id, name: report[theirs].name, level: report[theirs].level },
        myLevel: report[mine].level,
        fort: { mine: report[mine].fort || 0, theirs: report[theirs].fort || 0 },
        guard: report.result?.guard || 0,
        abNeed: report.abNeed?.[mine] ?? null,
        abOn: report.abOn?.[mine] || [],
        abOnTheirs: report.abOn?.[theirs] || [],
        myPiles,
        theirPiles,
        army: {
            mine: { qty: sum(myPiles, (p) => p.qty), hp: sum(myPiles, (p) => p.max), dealt: sum(myPiles, (p) => p.dealt) },
            theirs: { qty: sum(theirPiles, (p) => p.qty), hp: sum(theirPiles, (p) => p.max), dealt: sum(theirPiles, (p) => p.dealt) },
        },
        rating: report.result?.rating || null,
        delta: ratingDelta(report.result?.rating, mine),
        raid: (report.result?.raid || []).length,
        loot: report.result?.loot || [],
        land: report.result?.land || null,
        weak: report.result?.weak || null,
        lootShield: Boolean(report.result?.lootShield),
        charXp: report.result?.charXp?.[mine] || 0,
        abilityEvents: (report.abilities || [])
            .filter(([, s]) => s === sideIdx)
            .map(([t, , key, payload]) => ({ t, key, total: payloadTotal(payload) })),
    };
}

function ratingDelta(rating, mine) {
    if (!rating) return 0;
    // `delta` est signé du point de vue de l'attaquant ; `def` donne le gain du défenseur.
    if (mine === 'att') return rating.delta ?? 0;
    return rating.def ?? -(rating.delta ?? 0);
}

function payloadTotal(payload) {
    if (payload && typeof payload === 'object') return Object.values(payload).reduce((a, b) => a + b, 0);
    return typeof payload === 'number' ? payload : 0;
}

/* ---------- Agrégats ---------- */

function record(rows) {
    const side = (name) => {
        const xs = rows.filter((r) => r.role === name);
        const wins = xs.filter((r) => r.won).length;
        return { fights: xs.length, wins, losses: xs.length - wins, winRate: pct(wins, xs.length) };
    };
    const wins = rows.filter((r) => r.won).length;
    return {
        fights: rows.length,
        wins,
        losses: rows.length - wins,
        winRate: pct(wins, rows.length),
        attack: side('attaque'),
        defense: side('défense'),
        streak: streak(rows),
        armyGap: median(rows.map((r) => r.army.theirs.hp / (r.army.mine.hp || 1))),
    };
}

/** Série en cours (les combats sont triés du plus récent au plus ancien). */
function streak(rows) {
    if (!rows.length) return { kind: null, n: 0 };
    const kind = rows[0].won ? 'victoires' : 'défaites';
    let n = 0;
    for (const r of rows) {
        if (r.won !== rows[0].won) break;
        n += 1;
    }
    return { kind, n };
}

function points(rows) {
    const gained = rows.filter((r) => r.delta > 0).reduce((a, r) => a + r.delta, 0);
    const lost = rows.filter((r) => r.delta < 0).reduce((a, r) => a + r.delta, 0);
    const byRole = (name) => rows.filter((r) => r.role === name).reduce((a, r) => a + r.delta, 0);
    return {
        gained,
        lost,
        net: gained + lost,
        perFight: round(rows.length ? (gained + lost) / rows.length : 0, 2),
        attack: byRole('attaque'),
        defense: byRole('défense'),
        bestWin: Math.max(0, ...rows.map((r) => r.delta)),
        worstLoss: Math.min(0, ...rows.map((r) => r.delta)),
    };
}

/** Rendement mesuré de chacun de mes types, et capacité réellement activée ou non. */
function myTypes(rows, troops) {
    const acc = new Map();
    for (const r of rows) {
        for (const p of r.myPiles) {
            if (p.reinforcement) continue; // les renforts ne sont pas ma compo
            const e = acc.get(p.base) || {
                key: p.base, role: p.role, ability: p.ability, fights: 0, qty: [], dealt: 0, taken: 0,
                hits: 0, cs: 0, dpu: [], wins: 0, abilityFired: 0, underThreshold: 0, needs: [],
                armyDealt: 0, share: [],
            };
            e.fights += 1;
            e.qty.push(p.qty);
            e.dealt += p.dealt;
            e.taken += p.taken;
            e.hits += p.hits;
            e.cs += r.cs;
            if (Number.isFinite(p.dpuPerHit)) e.dpu.push(p.dpuPerHit);
            if (r.won) e.wins += 1;
            if (r.abOn.includes(p.ability)) e.abilityFired += 1;
            if (r.abNeed != null && p.qty < r.abNeed) e.underThreshold += 1;
            if (r.abNeed != null) e.needs.push(r.abNeed);
            e.armyDealt += r.army.mine.dealt;
            e.share.push(p.dealt / (r.army.mine.dealt || 1));
            acc.set(p.base, e);
        }
    }

    return [...acc.values()].map((e) => {
        const qty = median(e.qty);
        const interval = e.hits ? e.cs / e.hits / 100 : null; // secondes entre deux coups, mesuré
        const dpuPerHit = median(e.dpu);
        const card = troops?.units?.[`troops/${e.key}`] || null;
        return {
            key: e.key,
            fr: card?.fr || e.key,
            name: card?.name || e.key,
            role: e.role,
            roleFr: ROLE_FR[e.role] || e.role,
            ability: e.ability,
            abilityFr: ABILITY_FR[e.ability] || e.ability,
            fights: e.fights,
            qtyMedian: qty,
            qtyMin: Math.min(...e.qty),
            qtyMax: Math.max(...e.qty),
            dealt: e.dealt,
            taken: e.taken,
            damageShare: round(100 * mean(e.share), 1),
            dpuPerHit: round(dpuPerHit, 0),
            intervalMeasured: round(interval, 2),
            dpsPerUnit: interval ? round(dpuPerHit / interval, 0) : null,
            dealtPerUnit: round(e.dealt / (sum(e.qty) || 1), 0),
            takenPerUnit: round(e.taken / (sum(e.qty) || 1), 0),
            trade: round(e.dealt / (e.taken || 1), 2),
            winRate: pct(e.wins, e.fights),
            abilityFireRate: pct(e.abilityFired, e.fights),
            underThreshold: e.underThreshold,
            needMedian: median(e.needs),
            // Stats de la carte du shop : c'est ce que vaut le type aujourd'hui, équipement compris.
            card: card ? cardStats(card) : null,
        };
    }).sort((a, b) => b.dealt - a.dealt);
}

export function cardStats(card) {
    const s = card.stats || {};
    const dmg = s.damage?.effective || s.damage?.base;
    const avgDmg = dmg && typeof dmg === 'object' ? (dmg.min + dmg.max) / 2 : dmg || 0;
    return {
        hp: s.hp?.effective ?? s.hp?.base ?? 0,
        dmgMin: dmg?.min ?? avgDmg,
        dmgMax: dmg?.max ?? avgDmg,
        avgDmg,
        crit: s.crit?.effective ?? s.crit?.base ?? 0,
        counter: s.counter?.effective ?? s.counter?.base ?? 0,
        speed: s.speed?.effective ?? s.speed?.base ?? 1,
        typeLevel: card.typeLevel ?? 1,
        // Dégâts attendus par unité et par coup, espérance de critique comprise (×1,5).
        expectedHit: avgDmg * (1 + (s.crit?.effective ?? s.crit?.base ?? 0) / 100 * 0.5),
        dpsPerUnit: (avgDmg * (1 + (s.crit?.effective ?? s.crit?.base ?? 0) / 100 * 0.5))
            / (s.speed?.effective ?? s.speed?.base ?? 1),
        cost: card.cost || {},
    };
}

/** Capacités : lesquelles ont tourné, lesquelles ont été payées pour rien. */
function abilities(rows) {
    const fired = new Map();
    const wasted = new Map();
    for (const r of rows) {
        for (const key of r.abOn) fired.set(key, (fired.get(key) || 0) + 1);
        for (const p of r.myPiles) {
            if (p.reinforcement) continue;
            if (r.abOn.includes(p.ability)) continue;
            const e = wasted.get(p.ability) || { key: p.ability, type: p.base, fights: 0, qty: [], need: [] };
            e.fights += 1;
            e.qty.push(p.qty);
            if (r.abNeed != null) e.need.push(r.abNeed);
            wasted.set(p.ability, e);
        }
    }
    return {
        needMedian: median(rows.map((r) => r.abNeed).filter((n) => n != null)),
        fired: [...fired].map(([key, n]) => ({ key, fr: ABILITY_FR[key] || key, fights: n, rate: pct(n, rows.length) }))
            .sort((a, b) => b.fights - a.fights),
        wasted: [...wasted.values()].map((e) => ({
            key: e.key,
            fr: ABILITY_FR[e.key] || e.key,
            type: e.type,
            fights: e.fights,
            qtyMedian: median(e.qty),
            needMedian: median(e.need),
            missing: Math.max(0, Math.round(median(e.need) - median(e.qty))),
        })).sort((a, b) => b.fights - a.fights),
        theirs: tally(rows.flatMap((r) => r.abOnTheirs)).map(([key, n]) => ({
            key, fr: ABILITY_FR[key] || key, fights: n, rate: pct(n, rows.length),
        })),
    };
}

/** Le vivier réellement affronté : c'est contre lui qu'une compo doit gagner. */
function opponents(rows) {
    const acc = new Map();
    for (const r of rows) {
        for (const p of r.theirPiles) {
            const e = acc.get(p.base) || {
                key: p.base, role: p.role, ability: p.ability, fights: 0, qty: [], unitHp: [], dpu: [],
                hits: 0, cs: 0, reinf: 0,
            };
            e.fights += 1;
            e.qty.push(p.qty);
            e.unitHp.push(p.unitHp);
            if (Number.isFinite(p.dpuPerHit)) e.dpu.push(p.dpuPerHit);
            e.hits += p.hits;
            e.cs += r.cs;
            if (p.reinforcement) e.reinf += 1;
            acc.set(p.base, e);
        }
    }
    const pool = [...acc.values()].map((e) => {
        const interval = e.hits ? e.cs / e.hits / 100 : null;
        const dpuPerHit = median(e.dpu);
        return {
            key: e.key,
            role: e.role,
            roleFr: ROLE_FR[e.role] || e.role,
            ability: e.ability,
            abilityFr: ABILITY_FR[e.ability] || e.ability,
            fights: e.fights,
            share: pct(e.fights, rows.length),
            qtyMedian: median(e.qty),
            unitHpMedian: median(e.unitHp),
            dpuPerHit: round(dpuPerHit, 0),
            intervalMeasured: round(interval, 2),
            dpsPerUnit: interval ? round(dpuPerHit / interval, 0) : null,
            reinforcements: e.reinf,
        };
    }).sort((a, b) => b.fights - a.fights);

    return {
        pool,
        levelGap: median(rows.map((r) => r.opponent.level - r.myLevel)),
        armyHpMedian: median(rows.map((r) => r.army.theirs.hp)),
        armyQtyMedian: median(rows.map((r) => r.army.theirs.qty)),
        fortMedian: median(rows.filter((r) => r.role === 'attaque').map((r) => r.fort.theirs)),
        toughest: rows.slice().sort((a, b) => b.army.theirs.hp - a.army.theirs.hp).slice(0, 5)
            .map((r) => ({ id: r.id, name: r.opponent.name, hp: r.army.theirs.hp, won: r.won })),
    };
}

/* Ce que l'historique dit du moteur de combat lui-même — utile pour savoir à quel point le
   simulateur de compos a le droit d'être cru. */
function mechanics(rows, reports, meId) {
    const matchups = measureMatchups(reports, meId);
    const fortSeen = [...new Set(rows.map((r) => r.fort.theirs).filter(Boolean))].sort((a, b) => a - b);
    return {
        tick: 'centièmes de seconde (result.cs = durée du combat)',
        damageFormula: 'unités vivantes × tirage(dégâts min…max) × (critique ? 1,5) × (1 − fortification)',
        matchups,
        roleEffectOnDamage: 'mesuré nul : à rôle d’attaquant donné, les dégâts par unité ne dépendent '
            + 'pas du rôle de la cible (voir le tableau ci-dessus, tous les rapports valent ≈ 1,00). '
            + 'Le triangle des rôles n’agit donc pas sur les dégâts dans cet historique.',
        targeting: 'cible tirée au sort, pondérée par les PV de la pile adverse (la première cible est '
            + 'la plus grosse pile dans la moitié des cas, jamais le rôle dominé)',
        abilityMagnitudes: {
            shield: '8 % des PV de l’armée (mesuré : 8,00 %)',
            second_wind: '12 % des PV perdus rendus (mesuré : 11,3 % des PV max)',
            shockwave: '≈ 6,8 % des PV de l’armée adverse (mesuré ; non documenté dans les règles)',
            rage: '+35 % de dégâts pendant 10 s',
            ambush: 'un coup gratuit à 40 % de la puissance, à t = 0',
            frenzy: '+50 % de vitesse pendant 2 s',
        },
        fortSeen,
        medianFightSeconds: round(median(rows.map((r) => r.seconds)), 1),
    };
}

/* Le triangle des rôles joue-t-il sur les dégâts ? Pour chacune de mes piles, on divise chaque
   coup par la médiane des coups de cette même pile dans ce même combat : équipement, talents et
   niveau de type s'annulent, il ne reste que l'effet du rôle de la cible. */
function measureMatchups(reports, meId) {
    const raw = [];
    for (const report of reports) {
        const mine = report.att.id === meId ? 'att' : 'def';
        const sideIdx = mine === 'att' ? 0 : 1;
        const theirRole = new Map(report[mine === 'att' ? 'def' : 'att'].piles.map((p) => [p.key, p.role]));
        const myRole = new Map(report[mine].piles.map((p) => [p.key, p.role]));
        const qty = new Map(report[mine].piles.map((p) => [p.key, p.qty]));
        const perPile = new Map();
        for (const [, side, from, to, dmg, alive] of report.events || []) {
            if (side !== sideIdx || !theirRole.has(to)) continue;
            const n = alive || qty.get(from) || 0;
            if (!n) continue;
            (perPile.get(from) || perPile.set(from, []).get(from)).push({ to, dpu: dmg / n });
        }
        for (const [key, hits] of perPile) {
            const ref = median(hits.map((h) => h.dpu));
            if (!ref) continue;
            for (const h of hits) raw.push({ from: myRole.get(key), to: theirRole.get(h.to), ratio: h.dpu / ref });
        }
    }
    const acc = new Map();
    for (const r of raw) {
        const k = `${r.from}>${r.to}`;
        (acc.get(k) || acc.set(k, []).get(k)).push(r.ratio);
    }
    return [...acc].map(([k, xs]) => {
        const [from, to] = k.split('>');
        return {
            from, to, fromFr: ROLE_FR[from] || from, toFr: ROLE_FR[to] || to,
            hits: xs.length, ratio: round(median(xs), 3),
        };
    }).sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
}

/* ---------- Petits calculs ---------- */

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

export function median(xs) {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return NaN;
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function tally(xs) {
    const m = new Map();
    for (const x of xs) m.set(x, (m.get(x) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
}

function pct(n, d) {
    return d ? round((100 * n) / d, 1) : 0;
}

function round(n, d = 0) {
    if (!Number.isFinite(n)) return null;
    const f = 10 ** d;
    return Math.round(n * f) / f;
}
