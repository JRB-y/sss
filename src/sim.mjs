import { cardStats, median, ABILITY_FR, ROLE_FR } from './analyse.mjs';
import { applyGear, atTypeLevel } from './gear.mjs';

/* Simulateur de combat et recherche de compositions.

   Le moteur reproduit ce que l'historique a permis de mesurer, et rien de plus :
   — une pile frappe toutes les `vitesse` secondes et inflige
     `unités vivantes × dégâts moyens × (1 + critique/2) × (1 − fortification adverse)` ;
   — les unités vivantes suivent la part de PV restante du groupe (vérifié sur les events) ;
   — la cible est tirée au sort pondérée par les PV : ici on répartit le coup au prorata des PV
     adverses, ce qui donne la même espérance sans dépendre du hasard ;
   — la pile touchée riposte avec une probabilité `riposte` à 60 % de ses dégâts ;
   — le rôle de la cible ne change pas les dégâts (mesuré : écarts < 2 % sur 1 798 coups), donc
     aucun multiplicateur de rôle n'est appliqué ;
   — les capacités ne fonctionnent qu'au-delà de 10 % des places de troupes, avec les amplitudes
     relevées dans les rapports (bouclier 8 %, second souffle 12 %, onde de choc 6,8 %…).

   Le simulateur est déterministe : il calcule des espérances, pas un tirage. Deux compositions
   se comparent donc sans bruit, et `backtest()` dit sur quelle part de l'historique il retrouve
   le bon vainqueur. */

const DT = 5; // pas de simulation, en centièmes de seconde
const CAP = 9000; // 90 s : au-delà, on tranche aux PV restants (le combat médian dure 11 s)

/* Amplitudes mesurées dans `report.abilities` sur l'historique. */
const AB = {
    shield: { at: 'start', absorbPctOfArmy: 8 },
    ambush: { at: 'start', powerPct: 40 },
    frenzy: { at: 'start', speedPct: 50, durationCs: 200 },
    rage: { below: 50, dmgPct: 35, durationCs: 1000 },
    second_wind: { below: 30, healPctOfMax: 12 },
    shockwave: { foeLost: 30, dmgPctOfFoeArmy: 6.8 },
    fortress: { below: 40, takenPct: -35, durationCs: 1000 },
    last_stand: { below: 25, dmgPct: 50, speedPct: 50, durationCs: CAP },
    intimidate: { at: 'start', foeDmgPct: -20, durationCs: 500 },
    freeze: { at: 'start', foeFreezeCs: 50 },
    bleed: { passive: 'crit', critMult: 2.5 },
    reflect: { passive: 'reflect', pct: 2 },
    execute: { foeBelow: 35, dmgPctOfFoeArmy: 5 }, // non mesuré : amplitude prudente
    corrupt: { at: 'start', foeFreezeCs: 200, biggestOnly: true },
};

/* ---------- Construction d'une armée ---------- */

/**
 * @param piles [{key, qty, unitHp, dmgAvg, crit, counter, speed, role, ability}]
 * @param slots places de troupes du camp (sert au seuil de capacité : 10 %)
 */
export function army(piles, { slots, fort = 0, guard = 0, readiness = 1, critMult = 1.5 } = {}) {
    const need = Math.ceil((slots || totalQty(piles)) * 0.1);
    const list = piles.filter((p) => p.qty > 0).map((p) => ({
        ...p,
        maxHp: p.qty * p.unitHp,
        // Des troupes blessées frappent moins : les unités vivantes suivent la part de PV restante.
        // En défense, l'historique montre des piles à 70 % en moyenne (elles récupèrent encore).
        hp: p.hp ?? p.qty * p.unitHp * (readiness ?? 1),
        shield: 0,
        nextHit: Math.round(p.speed * 100),
        frozenUntil: 0,
        buffs: [],
        used: new Set(),
        abilityOn: p.ability ? p.qty >= need : false,
    }));
    return {
        piles: list,
        need,
        fort,
        guard,
        maxHp: list.reduce((a, p) => a + p.maxHp, 0),
        startHp: list.reduce((a, p) => a + p.hp, 0),
        readiness,
        // Un coup critique frappe ×1,5 par défaut ; le talent « Executioner » le relève, et la
        // capacité Saignée le porte à ×2,5 pour la pile qui la déclenche.
        critMult,
        abilities: [...new Set(list.filter((p) => p.abilityOn).map((p) => p.ability))],
    };
}

const totalQty = (piles) => piles.reduce((a, p) => a + p.qty, 0);
const armyHp = (a) => a.piles.reduce((s, p) => s + Math.max(0, p.hp), 0);

/* ---------- Le combat ---------- */

/**
 * Joue un combat entre deux armées.
 *
 * `trace: true` enregistre le déroulé — coups portés, capacités déclenchées, courbe de PV. C'est
 * ce qui permet de *regarder* un combat simulé au lieu d'en lire seulement l'issue. L'option est
 * coûteuse (des milliers d'entrées) et la recherche de compositions appelle cette fonction des
 * centaines de milliers de fois : elle reste donc éteinte par défaut, et l'enregistrement ne
 * coûte rien quand elle l'est.
 */
export function simulate(A, B, { dt = DT, cap = CAP, trace = false } = {}) {
    const sides = [reset(A), reset(B)];
    const rec = trace ? newTrace(sides, dt) : null;
    for (const [i, s] of sides.entries()) s.trace = rec ? { rec, side: i } : null;
    for (const [i, s] of sides.entries()) openers(s, sides[1 - i]);
    if (rec) sample(rec, sides, 0);

    let t = 0;
    while (t < cap && armyHp(sides[0]) > 0 && armyHp(sides[1]) > 0) {
        t += dt;
        for (const [i, me] of sides.entries()) {
            const foe = sides[1 - i];
            for (const p of me.piles) {
                if (p.hp <= 0 || t < p.nextHit || t < p.frozenUntil) continue;
                strike(p, me, foe, t);
                p.nextHit = t + Math.round((p.speed * 100) / speedMult(p, t));
            }
            triggers(me, foe, t);
        }
        if (rec) sample(rec, sides, t);
    }
    if (rec) sample(rec, sides, t, true);

    const hp = [armyHp(sides[0]), armyHp(sides[1])];
    const frac = [hp[0] / (sides[0].maxHp || 1), hp[1] / (sides[1].maxHp || 1)];
    return {
        winner: frac[0] > frac[1] ? 'A' : 'B',
        margin: frac[0] - frac[1],
        seconds: t / 100,
        timeout: t >= cap,
        left: { A: frac[0], B: frac[1] },
        abilities: { A: sides[0].abilities, B: sides[1].abilities },
        piles: {
            A: sides[0].piles.map((p) => pileResult(p)),
            B: sides[1].piles.map((p) => pileResult(p)),
        },
        trace: rec ? finishTrace(rec, t) : null,
    };
}

const pileResult = (p) => ({
    key: p.key,
    fr: p.fr || p.key,
    qty: p.qty,
    dealt: Math.round(p.dealt),
    taken: Math.round(p.taken || 0),
    left: p.maxHp ? Math.max(0, p.hp) / p.maxHp : 0,
    hp: Math.round(Math.max(0, p.hp)),
    maxHp: Math.round(p.maxHp),
    ability: p.ability,
    abilityFr: p.abilityFr || null,
    abilityOn: p.abilityOn,
    role: p.role,
    roleFr: p.roleFr || null,
});

/* ---------- Trace du déroulé ---------- */

function newTrace(sides, dt) {
    return {
        dt,
        hits: [], // [t, camp, pile, dégâts, riposte]
        abilities: [], // [t, camp, clé, charge]
        hp: [], // [t, part de PV camp A, part de PV camp B]
        max: [sides[0].maxHp, sides[1].maxHp],
        start: [sides[0].startHp, sides[1].startHp],
    };
}

/* La courbe de PV n'a pas besoin d'un point tous les 5 centièmes : on échantillonne pour rester
   sous ~160 points, ce qui suffit largement à dessiner et garde la réponse légère. */
function sample(rec, sides, t, force = false) {
    const last = rec.hp[rec.hp.length - 1];
    const step = Math.max(rec.dt, 25);
    if (!force && last && t - last[0] < step) return;
    if (last && last[0] === t) return;
    rec.hp.push([
        t,
        Math.max(0, armyHp(sides[0])) / (rec.max[0] || 1),
        Math.max(0, armyHp(sides[1])) / (rec.max[1] || 1),
    ]);
}

function finishTrace(rec, t) {
    return {
        cs: t,
        seconds: t / 100,
        hp: rec.hp.map(([tt, a, b]) => [tt, Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]),
        hits: rec.hits,
        abilities: rec.abilities,
        // Dégâts cumulés par seconde et par camp : la lecture la plus parlante d'un déroulé.
        dps: perSecond(rec.hits, t),
    };
}

function perSecond(hits, t) {
    const out = [];
    for (let s = 0; s <= Math.ceil(t / 100); s += 1) out.push([s, 0, 0]);
    for (const [tt, side, , dmg, counter] of hits) {
        const s = Math.min(out.length - 1, Math.floor(tt / 100));
        out[s][1 + side] += dmg;
        if (counter) out[s][1 + (1 - side)] += counter;
    }
    return out.map(([s, a, b]) => [s, Math.round(a), Math.round(b)]);
}

function reset(a) {
    return {
        ...a,
        piles: a.piles.map((p) => ({
            ...p, hp: p.hp, shield: 0, dealt: 0, taken: 0,
            nextHit: Math.round(p.speed * 100), frozenUntil: 0, buffs: [], used: new Set(),
        })),
    };
}

/** Capacités de début de combat : bouclier, embuscade, frénésie, intimidation, gel, corruption. */
function openers(me, foe) {
    for (const p of me.piles) {
        if (!p.abilityOn) continue;
        const spec = AB[p.ability];
        if (!spec || spec.at !== 'start') continue;
        if (p.ability === 'shield') {
            const pool = (me.maxHp * spec.absorbPctOfArmy) / 100;
            for (const q of me.piles) q.shield += (pool * q.maxHp) / (me.maxHp || 1);
        }
        if (p.ability === 'frenzy') for (const q of me.piles) q.buffs.push({ until: spec.durationCs, speedPct: spec.speedPct });
        if (p.ability === 'intimidate') for (const q of foe.piles) q.buffs.push({ until: spec.durationCs, dmgPct: spec.foeDmgPct });
        if (p.ability === 'freeze') for (const q of foe.piles) q.frozenUntil = Math.max(q.frozenUntil, spec.foeFreezeCs);
        if (p.ability === 'corrupt') {
            const biggest = foe.piles.slice().sort((x, y) => y.maxHp - x.maxHp)[0];
            if (biggest) biggest.frozenUntil = Math.max(biggest.frozenUntil, spec.foeFreezeCs);
        }
        if (p.ability === 'ambush') {
            for (const q of me.piles) strike(q, me, foe, 0, spec.powerPct / 100);
        }
        p.used.add(p.ability);
        if (me.trace) me.trace.rec.abilities.push([0, me.trace.side, p.ability, 0]);
    }
}

/** Un coup porté par la pile `p`, réparti sur les piles adverses au prorata de leurs PV. */
function strike(p, me, foe, t, scale = 1) {
    const alive = aliveOf(p, me);
    if (alive <= 0) return;
    const critMult = 1 + (p.crit / 100) * ((me.critMult || 1.5) - 1);
    const power = alive * p.dmgAvg * critMult * dmgMult(p, t) * (1 - foe.fort / 100) * scale;
    const pool = foe.piles.reduce((s, q) => s + Math.max(0, q.hp), 0);
    if (pool <= 0) return;

    let dealt = 0;
    let back = 0;
    for (const q of foe.piles) {
        if (q.hp <= 0) continue;
        const w = q.hp / pool;
        dealt += apply(q, power * w);
        // La cible riposte à 60 % de ses dégâts, avec sa probabilité de riposte.
        if (q.counter > 0) {
            const hit = (q.counter / 100) * 0.6 * aliveOf(q, foe) * q.dmgAvg * dmgMult(q, t)
                * (1 - me.fort / 100) * w * scale;
            const done = apply(p, hit);
            q.dealt += done;
            back += done;
        }
        if (q.abilityOn && q.ability === 'reflect') {
            const done = apply(p, power * w * (AB.reflect.pct / 100));
            q.dealt += done;
            back += done;
        }
    }
    p.dealt += dealt;
    if (me.trace) {
        me.trace.rec.hits.push([t, me.trace.side, p.key, Math.round(dealt), Math.round(back)]);
    }
}

/** Les unités vivantes suivent la part de PV restante ; un poste de garde met un plancher. */
function aliveOf(p, side) {
    const ratio = Math.max(0, p.hp) / p.maxHp;
    return p.qty * Math.max(ratio, side.guard ? side.guard / 100 : 0) * (ratio > 0 ? 1 : 0);
}

/** Applique des dégâts à une pile (bouclier d'abord) et renvoie ce qui a réellement porté. */
function apply(q, dmg) {
    let rest = dmg;
    if (q.shield > 0) {
        const eaten = Math.min(q.shield, rest);
        q.shield -= eaten;
        rest -= eaten;
    }
    const dealt = Math.min(rest, Math.max(0, q.hp));
    q.hp -= rest;
    const total = dealt + (dmg - rest); // le bouclier absorbé compte dans les dégâts infligés
    q.taken = (q.taken || 0) + total;
    return total;
}

const dmgMult = (p, t) => p.buffs.reduce((m, b) => (t <= b.until && b.dmgPct ? m * (1 + b.dmgPct / 100) : m), 1);
const speedMult = (p, t) => p.buffs.reduce((m, b) => (t <= b.until && b.speedPct ? m * (1 + b.speedPct / 100) : m), 1);

/** Capacités à seuil : rage, second souffle, onde de choc, forteresse, dernier carré, coup de grâce. */
function triggers(me, foe, t) {
    const mine = armyHp(me) / (me.maxHp || 1);
    const theirLost = 1 - armyHp(foe) / (foe.maxHp || 1);
    for (const p of me.piles) {
        if (!p.abilityOn || p.hp <= 0 || p.used.has(p.ability)) continue;
        const spec = AB[p.ability];
        if (!spec) continue;

        if (spec.below != null && mine * 100 <= spec.below) {
            p.used.add(p.ability);
            let healed = 0;
            if (p.ability === 'second_wind') {
                for (const q of me.piles) {
                    if (q.hp <= 0) continue;
                    const before = q.hp;
                    q.hp = Math.min(q.maxHp, q.hp + (q.maxHp * spec.healPctOfMax) / 100);
                    healed += q.hp - before;
                }
            } else {
                for (const q of me.piles) q.buffs.push({ until: t + spec.durationCs, dmgPct: spec.dmgPct, speedPct: spec.speedPct });
                if (spec.takenPct) me.takenUntil = t + spec.durationCs;
            }
            if (me.trace) me.trace.rec.abilities.push([t, me.trace.side, p.ability, Math.round(healed)]);
        }
        if (spec.foeLost != null && theirLost * 100 >= spec.foeLost) {
            p.used.add(p.ability);
            if (me.trace) me.trace.rec.abilities.push([t, me.trace.side, p.ability, Math.round(burstOn(p, foe, spec))]);
            else burstOn(p, foe, spec);
        }
        if (spec.foeBelow != null && armyHp(foe) / (foe.maxHp || 1) * 100 <= spec.foeBelow) {
            p.used.add(p.ability);
            if (me.trace) me.trace.rec.abilities.push([t, me.trace.side, p.ability, Math.round(burstOn(p, foe, spec))]);
            else burstOn(p, foe, spec);
        }
    }
}

/** Souffle de capacité (onde de choc, coup de grâce) : une charge répartie au prorata des PV. */
function burstOn(p, foe, spec) {
    const burst = (foe.maxHp * spec.dmgPctOfFoeArmy) / 100;
    const pool = foe.piles.reduce((s, q) => s + Math.max(0, q.hp), 0) || 1;
    let done = 0;
    for (const q of foe.piles) {
        if (q.hp <= 0) continue;
        done += apply(q, (burst * q.hp) / pool);
    }
    p.dealt += done;
    return done;
}

/* ---------- Paramètres d'un type ---------- */

/* Pour mes types : la carte du shop donne les stats réelles, équipement et talents compris.
   Pour les types adverses : la carte donne vitesse, critique et riposte (ce sont des constantes
   du type), et l'historique donne les dégâts par unité réellement observés, remis à l'échelle
   des PV unitaires de la pile — c'est le meilleur indicateur de l'équipement d'en face. */
export function typeParams(troops, analysis) {
    const params = new Map();
    const pool = new Map((analysis?.opponents?.pool || []).map((o) => [o.key, o]));

    for (const [id, card] of Object.entries(troops?.units || {})) {
        if (!id.startsWith('troops/') || !card.detailed) continue;
        const s = cardStats(card);
        const b = cardStats(card, { base: true });
        const measured = pool.get(card.key);
        params.set(card.key, {
            // Le type seul, sans talents ni équipement : la référence sur laquelle appliquer le
            // matériel relevé d'une pile (cf. `pileStats`).
            base: {
                unitHp: b.hp, dmgAvg: b.avgDmg, crit: b.crit, counter: b.counter, speed: b.speed,
                typeLevel: b.typeLevel,
            },
            key: card.key,
            fr: card.fr || card.name,
            role: card.role?.key || null,
            roleFr: ROLE_FR[card.role?.key] || null,
            ability: card.ability?.key || null,
            abilityFr: card.ability?.fr || ABILITY_FR[card.ability?.key] || null,
            unitHp: s.hp,
            dmgAvg: s.avgDmg,
            crit: s.crit,
            counter: s.counter,
            speed: s.speed,
            cost: s.cost,
            dpsPerUnit: s.dpsPerUnit,
            typeLevel: s.typeLevel,
            foe: measured ? {
                unitHp: measured.unitHpMedian,
                dmgAvg: measured.dpuPerHit,
                qtyMedian: measured.qtyMedian,
            } : null,
        });
    }
    return params;
}

/* Une pile d'un combat passé, reconstruite au plus près de ce que le rapport dit vraiment.
   Trois sources, et chacune à sa place :

   1. **Servi par le serveur** — les PV unitaires. Équipement, talents et bonus de famille d'en
      face y sont déjà : rien à deviner, et c'est vrai pour les deux camps.
   2. **Mesuré dans la frise des coups** — la cadence réelle de la pile (`interval` = durée du
      combat ÷ coups portés). C'est ce qui a le plus fait progresser le rejeu de l'historique
      (justesse 76,3 → 86,4 %, pouvoir de classement 0,783 → 0,892), parce que les objets donnent
      un bonus de vitesse intrinsèque que le jeu ne publie pas : les piles qui portent un affixe de
      vitesse frappent ~10 % plus vite alors que l'affixe n'en promet que 1 à 6,5 %.
   3. **Carte du shop + équipement relevé** — les stats **de base** du type (sans mes talents ni
      mon matériel, qui ne sont pas les siens), au niveau de type de la pile, auxquelles on
      applique les affixes des trois pièces : critique et riposte en points, dégâts en pourcentage.
      Les dégâts sont ensuite remis à l'échelle des PV unitaires réels de la pile.

   Ce qu'on n'utilise **pas** : les dégâts par coup mesurés (`dpuPerHit`). Ils sont tentants, mais
   ils incluent les capacités qui augmentent les dégâts pendant le combat (rage, frénésie, dernier
   carré) que le simulateur réapplique ensuite — on les compterait deux fois. Vérifié sur
   l'historique : les utiliser fait baisser le pouvoir de classement (0,892 → 0,869). Ils ne servent
   donc que de repli pour un type dont le jeu ne m'a pas encore servi la fiche (il n'y en a aucun
   aujourd'hui, mais ça viendra en montant de niveau). */
const NO_TALENTS = { dmgPct: 0, dmgFlat: 0, critPts: 0, speedPct: 0, hpPct: 0, hpFlat: 0, counterPts: 0, counterPct: 0 };

function pileStats(p, params, { fortAgainstThem = 0, talents = null } = {}) {
    const t = params.get(p.base);
    const base = t?.base || null;
    const gear = p.gearBonuses || { dmg: 0, hp: 0, speed: 0, crit: 0, riposte: 0 };
    const tal = talents || NO_TALENTS;

    // Repli pour un type sans fiche : les dégâts observés, la fortification du camp visé remise.
    const observed = Number.isFinite(p.dpuPerHit) && p.hits >= 3
        ? p.dpuPerHit / (1 - (fortAgainstThem || 0) / 100)
        : null;

    if (!base) {
        return {
            key: p.key, fr: p.base, qty: p.qty, unitHp: p.unitHp, hp: p.hp,
            dmgAvg: observed ?? 0,
            dmgSource: observed ? 'mesuré (type sans fiche)' : 'inconnu',
            crit: 10, counter: 5, speed: p.interval || 1.5, speedSource: p.interval ? 'mesuré' : 'défaut',
            role: p.role, roleFr: ROLE_FR[p.role] || p.role,
            ability: p.ability, abilityFr: ABILITY_FR[p.ability] || p.ability,
        };
    }

    const lv = atTypeLevel(base, base.typeLevel, p.typeLevel ?? base.typeLevel);

    /* Le jeu compose dans cet ordre — vérifié sur les types que je n'équipe pas, où
       `(base + plats) × (1 + %)` tombe à 1 % près sur la valeur servie :

           réel = (base_du_type_à_son_niveau + bonus_plats) × (1 + %talents + %objets)

       Les PV unitaires sont connus (le serveur les sert). Ce qu'ils contiennent au-delà des
       talents et des affixes, c'est le **bonus intrinsèque** des objets, que le jeu ne publie
       pas. On le déduit du résidu de PV et on l'applique aussi aux dégâts : c'est une
       approximation, mais elle est symétrique entre les deux camps, et c'est le seul signal
       disponible sur le matériel d'en face. */
    const hpExplained = (lv.unitHp + (tal.hpFlat || 0)) * (1 + ((tal.hpPct || 0) + gear.hp) / 100);
    const intrinsicPct = hpExplained > 0 ? (p.unitHp / hpExplained - 1) * 100 : 0;

    const dmgAvg = (lv.dmgAvg + (tal.dmgFlat || 0))
        * (1 + ((tal.dmgPct || 0) + gear.dmg + intrinsicPct) / 100);

    return {
        key: p.key,
        fr: t?.fr || p.base,
        qty: p.qty,
        unitHp: p.unitHp, // servi par le serveur : équipement et talents d'en face compris
        hp: p.hp,
        dmgAvg,
        dmgSource: 'carte + talents + équipement',
        crit: lv.crit + (tal.critPts || 0) + gear.crit,
        counter: lv.counter + (tal.counterPts || 0) + gear.riposte,
        // La cadence mesurée prime : elle intègre les bonus de vitesse que le jeu ne publie pas.
        speed: p.interval || lv.speed / (1 + ((tal.speedPct || 0) + gear.speed) / 100),
        speedSource: p.interval ? 'mesuré' : 'carte + talents + équipement',
        role: p.role,
        roleFr: ROLE_FR[p.role] || p.role,
        ability: p.ability,
        abilityFr: ABILITY_FR[p.ability] || p.ability,
        intrinsicPct: Math.round(intrinsicPct * 10) / 10,
    };
}

/**
 * Une composition à monter maintenant : `[{ key, qty }]` → armée jouable.
 *
 * Les stats viennent des valeurs **réelles** de la carte du shop, qui portent déjà tes talents et
 * ton équipement du moment — c'est exactement ce que tu alignerais si tu recrutais aujourd'hui.
 * Surtout ne pas y réappliquer les talents : ils seraient comptés deux fois.
 */
export function composeArmy(spec, params, { slots, fort = 0, guard = 0, readiness = 1, critMult = 1.5 } = {}) {
    const piles = [];
    const unknown = [];
    for (const { key, qty } of spec || []) {
        const t = params.get(key);
        if (!t) { unknown.push(key); continue; }
        if (!(qty > 0)) continue;
        piles.push({
            key: t.key,
            fr: t.fr,
            qty: Math.round(qty),
            unitHp: t.unitHp,
            dmgAvg: t.dmgAvg,
            crit: t.crit,
            counter: t.counter,
            speed: t.speed,
            role: t.role,
            roleFr: t.roleFr,
            ability: t.ability,
            abilityFr: t.abilityFr,
            cost: t.cost,
        });
    }
    const built = army(piles, { slots, fort, guard, readiness, critMult });
    built.unknown = unknown;
    return built;
}

/** Armée adverse d'un combat passé : son armée exacte, telle que le rapport la donne. */
export function enemyArmyFromFight(fight, params, opts) {
    return foeArmyFromFight(fight, params, opts);
}

/** Ma composition d'alors, pour comparer « ce que j'avais » à « ce que je mettrais ». */
export function myArmyOfFight(fight, params, opts) {
    return myArmyFromFight(fight, params, opts);
}

/* Armée adverse d'un combat passé, reconstruite à partir de données d'avant-combat seulement.
   Ses talents à lui sont inconnus : ils sont absorbés par le résidu de PV (cf. `pileStats`). */
function foeArmyFromFight(fight, params, { role }) {
    // Quand je défends, MES murs rabotaient leurs coups : il faut les retirer de la mesure.
    const fortAgainstThem = role === 'défense' ? fight.fort.mine || 0 : 0;
    const piles = fight.theirPiles.map((p) => pileStats(p, params, { fortAgainstThem }));
    // Le seuil de capacité d'en face suit SES places : on l'approche par son armée engagée.
    return army(piles, {
        slots: Math.round(fight.army.theirs.qty / 0.9),
        fort: role === 'défense' ? 0 : fight.fort.theirs,
        guard: role === 'défense' ? 0 : fight.guard,
    });
}

/** Mon armée telle qu'elle était dans un combat passé — mes talents, eux, sont connus. */
function myArmyFromFight(fight, params, { talents = null, critMult } = {}) {
    // Quand j'attaquais, SES murs rabotaient mes coups.
    const fortAgainstThem = fight.role === 'attaque' ? fight.fort.theirs || 0 : 0;
    const piles = fight.myPiles.map((p) => pileStats(p, params, { fortAgainstThem, talents }));
    return army(piles, {
        slots: Math.round((fight.abNeed || Math.ceil(fight.army.mine.qty * 0.1)) * 10),
        fort: fight.role === 'défense' ? fight.fort.mine : 0,
        guard: fight.role === 'défense' ? fight.guard : 0,
        critMult,
    });
}

/* ---------- Validation : rejouer l'historique ---------- */

export function backtest(analysis, troops, { skills = null, critMult = null } = {}) {
    const params = typeParams(troops, analysis);
    const talents = skills?.bonuses || null;
    const crit = critMult ?? myCritMultiplier(skills);
    const rows = [];
    for (const f of analysis.fights) {
        const mine = myArmyFromFight(f, params, { talents, critMult: crit });
        const theirs = foeArmyFromFight(f, params, { role: f.role });
        const res = simulate(mine, theirs);
        rows.push({ id: f.id, role: f.role, actual: f.won, predicted: res.winner === 'A', margin: res.margin });
    }
    /* La marge classe correctement les combats, mais son zéro n'est pas le bon point de bascule :
       le simulateur ignore tout ce qui ne se mesure pas (ordre des coups, dispersion des tirages,
       capacités adverses mal connues). On cale donc le seuil sur l'historique — un seul paramètre,
       ajusté sur 57 combats — et on publie la justesse obtenue avec. */
    const threshold = {
        attaque: fitThreshold(rows.filter((r) => r.role === 'attaque')),
        défense: fitThreshold(rows.filter((r) => r.role === 'défense')),
    };
    for (const r of rows) r.predicted = r.margin > threshold[r.role];

    const hits = (xs) => xs.filter((r) => r.actual === r.predicted).length;
    const byRole = (name) => {
        const xs = rows.filter((r) => r.role === name);
        return { fights: xs.length, correct: hits(xs), accuracy: xs.length ? round1((100 * hits(xs)) / xs.length) : 0 };
    };
    return {
        fights: rows.length,
        correct: hits(rows),
        accuracy: rows.length ? round1((100 * hits(rows)) / rows.length) : 0,
        balanced: balanced(rows),
        threshold: {
            attaque: Math.round(threshold.attaque * 1000) / 1000,
            défense: Math.round(threshold.défense * 1000) / 1000,
        },
        separation: auc(rows),
        baseline: round1((100 * Math.max(rows.filter((r) => r.actual).length, rows.filter((r) => !r.actual).length)) / rows.length),
        attack: byRole('attaque'),
        defense: byRole('défense'),
        talents: talents ? { applied: true, ...talents } : { applied: false },
        critMult: crit,
        rows,
    };
}

/* Multiplicateur de critique de mon camp. Le jeu part de ×1,5 et le talent « Executioner »
   annonce `+50% critical damage` : le libellé ne dit pas si la prime passe de +50 % à +100 %
   (×2,0) ou si les dégâts critiques eux-mêmes gagnent 50 % (×2,25). On ne tranche pas au
   jugé — `calibrateCrit()` laisse l'historique choisir. */
export function myCritMultiplier(skills, mode = 'bonus') {
    const pct = (skills?.bonuses?.critDmgPct || 0) / 100;
    return mode === 'total' ? 1.5 * (1 + pct) : 1.5 + pct;
}

/** Rejoue l'historique avec chaque interprétation et renvoie celle qui classe le mieux. */
export function calibrateCrit(analysis, troops, skills) {
    const candidates = [
        { mode: 'aucun', critMult: 1.5 },
        { mode: 'bonus', critMult: myCritMultiplier(skills, 'bonus') },
        { mode: 'total', critMult: myCritMultiplier(skills, 'total') },
    ];
    const tried = candidates.map((c) => {
        const bt = backtest(analysis, troops, { skills, critMult: c.critMult });
        return { ...c, accuracy: bt.accuracy, auc: bt.separation, balanced: bt.balanced.all.balanced };
    });
    // On classe sur l'AUC : c'est la mesure indépendante du seuil, donc la moins sujette au
    // sur-ajustement sur un historique encore court.
    const best = tried.slice().sort((a, b) => (b.auc ?? 0) - (a.auc ?? 0) || b.balanced - a.balanced)[0];
    return { best, tried };
}

/** Justesse équilibrée et pouvoir de classement, par rôle : c'est là qu'on voit où croire le modèle. */
function balanced(rows) {
    const one = (xs) => {
        const w = xs.filter((r) => r.actual);
        const l = xs.filter((r) => !r.actual);
        if (!w.length || !l.length) return { wins: w.length, losses: l.length, balanced: null, auc: null };
        const tpr = w.filter((r) => r.predicted).length / w.length;
        const tnr = l.filter((r) => !r.predicted).length / l.length;
        return {
            wins: w.length,
            losses: l.length,
            recallWins: round1(100 * tpr),
            recallLosses: round1(100 * tnr),
            balanced: round1((100 * (tpr + tnr)) / 2),
            auc: auc(xs),
        };
    };
    return { all: one(rows), attaque: one(rows.filter((r) => r.role === 'attaque')), défense: one(rows.filter((r) => r.role === 'défense')) };
}

/* Seuil de marge calé sur l'historique. On maximise la justesse ÉQUILIBRÉE (moyenne du taux de
   victoires bien vues et du taux de défaites bien vues) et non la justesse brute : avec 26 défaites
   pour 4 victoires en défense, un seuil qui prédit « perdu » à tous les coups afficherait 87 % sans
   rien discriminer. La justesse équilibrée refuse ce raccourci. */
function fitThreshold(rows) {
    if (!rows.length) return 0;
    const wins = rows.filter((r) => r.actual);
    const losses = rows.filter((r) => !r.actual);
    if (!wins.length || !losses.length) return 0;
    const cuts = [...new Set(rows.map((r) => r.margin))].sort((a, b) => a - b);
    let best = 0;
    let bestScore = -1;
    for (const c of cuts.map((x) => x - 1e-9)) {
        const tpr = wins.filter((r) => r.margin > c).length / wins.length;
        const tnr = losses.filter((r) => r.margin <= c).length / losses.length;
        const sc = (tpr + tnr) / 2;
        if (sc > bestScore) { bestScore = sc; best = c; }
    }
    return best;
}

/** Pouvoir de classement de la marge, indépendant du seuil : 1 = parfait, 0,5 = hasard. */
function auc(rows) {
    const wins = rows.filter((r) => r.actual).map((r) => r.margin);
    const losses = rows.filter((r) => !r.actual).map((r) => r.margin);
    if (!wins.length || !losses.length) return null;
    let pairs = 0;
    for (const w of wins) for (const l of losses) pairs += w > l ? 1 : w === l ? 0.5 : 0;
    return Math.round((1000 * pairs) / (wins.length * losses.length)) / 1000;
}

const round1 = (n) => Math.round(n * 10) / 10;

/* ---------- Recherche de compositions ---------- */

/**
 * Cherche la meilleure composition contre le vivier réellement affronté.
 * @param slots places de troupes disponibles
 * @param maxTypes emplacements de types (4, ou 5 avec l'Annexe)
 */
export function recommend({ analysis, troops, slots, maxTypes = 4, keep = 8, threshold = {}, readiness = {}, critMult = 1.5 }) {
    const params = typeParams(troops, analysis);
    const usable = [...params.values()].filter((t) => t.dmgAvg > 0 && t.unitHp > 0);
    if (!usable.length) return { empty: true, reason: 'Aucune fiche de troupe chiffrée : lance « Relever les troupes ».' };

    const scenarios = buildScenarios(analysis, params);
    if (!scenarios.length) return { empty: true, reason: 'Aucun combat en base pour calibrer le vivier adverse.' };

    const screen = scenarios.filter((s) => s.representative);
    const candidates = [];
    for (const combo of combinations(usable, maxTypes)) {
        for (const split of tenths(combo.length)) {
            const piles = combo.map((t, i) => ({ ...t, qty: Math.floor((slots * split[i]) / 10) }));
            // Les arrondis ne doivent pas faire dépasser les places disponibles.
            const rest = slots - piles.reduce((a, p) => a + p.qty, 0);
            if (rest > 0) piles[piles.length - 1].qty += rest;
            candidates.push(piles);
        }
    }

    // Premier tri sur un échantillon d'adversaires représentatifs, puis affinage sur tout l'historique.
    const opts = { threshold, readiness, critMult };
    const scored = candidates.map((piles) => ({ piles, score: score(piles, screen, slots, opts) }));
    scored.sort((a, b) => b.score.margin - a.score.margin);

    const finalists = scored.slice(0, Math.max(keep * 5, 40))
        .map(({ piles }) => ({ piles, score: score(piles, scenarios, slots, opts) }))
        .sort((a, b) => b.score.wins - a.score.wins || b.score.margin - a.score.margin)
        .slice(0, Math.max(keep * 2, 12))
        .map((f) => refine(f, scenarios, slots, opts))
        .sort((a, b) => b.score.wins - a.score.wins || b.score.margin - a.score.margin);

    const current = currentComposition(troops, params, slots);
    return {
        empty: false,
        slots,
        maxTypes,
        need: Math.ceil(slots * 0.1),
        scenarios: scenarios.length,
        screened: candidates.length,
        best: finalists.slice(0, keep).map((f) => describe(f, slots, scenarios.length, critMult)),
        current: current ? describe({ piles: current, score: score(current, scenarios, slots, opts) }, slots, scenarios.length, critMult) : null,
        pool: scenarios.map((s) => ({ name: s.name, role: s.role, hp: s.army.maxHp, weight: s.weight })),
    };
}

/** Chaque combat de l'historique devient un scénario : même adversaire, même rôle, même fortif. */
function buildScenarios(analysis, params) {
    const out = analysis.fights.map((f) => ({
        id: f.id,
        name: `${f.opponent.name} (${f.role})`,
        role: f.role,
        weight: 1,
        army: foeArmyFromFight(f, params, { role: f.role }),
        myFort: f.role === 'défense' ? f.fort.mine : 0,
        myGuard: f.role === 'défense' ? f.guard : 0,
        representative: false,
    }));
    // Échantillon de criblage : les plus fréquents et les extrêmes de taille d'armée, des deux rôles.
    for (const role of ['attaque', 'défense']) {
        const xs = out.filter((s) => s.role === role).sort((a, b) => a.army.maxHp - b.army.maxHp);
        for (const i of [0, xs.length >> 2, xs.length >> 1, (3 * xs.length) >> 2, xs.length - 1]) {
            if (xs[i]) xs[i].representative = true;
        }
    }
    return out;
}

function score(piles, scenarios, slots, { threshold = {}, readiness = {}, critMult = 1.5 } = {}) {
    let wins = 0;
    let margin = 0;
    let weight = 0;
    for (const s of scenarios) {
        const ready = s.role === 'défense' ? (readiness.defense ?? 1) : (readiness.attack ?? 1);
        const mine = army(piles, { slots, fort: s.myFort, guard: s.myGuard, readiness: ready, critMult });
        const res = simulate(mine, s.army);
        if (res.margin > (threshold[s.role] ?? 0)) wins += s.weight;
        margin += res.margin * s.weight;
        weight += s.weight;
    }
    return { wins, winRate: weight ? (100 * wins) / weight : 0, margin: weight ? margin / weight : 0 };
}

/* La grille en dixièmes place les quantités au bon ordre de grandeur ; on finit en déplaçant des
   unités d'un type à l'autre par pas décroissants, sans jamais passer sous le seuil de capacité. */
function refine(start, scenarios, slots, opts) {
    const need = Math.ceil(slots * 0.1);
    let best = start;
    for (const step of [Math.round(slots * 0.05), Math.round(slots * 0.02), Math.round(slots * 0.01)]) {
        let improved = true;
        let guard = 0;
        while (improved && guard < 40) {
            improved = false;
            guard += 1;
            for (let i = 0; i < best.piles.length; i += 1) {
                for (let j = 0; j < best.piles.length; j += 1) {
                    if (i === j) continue;
                    const piles = best.piles.map((p) => ({ ...p }));
                    if (piles[i].qty - step < need) continue;
                    piles[i].qty -= step;
                    piles[j].qty += step;
                    const sc = score(piles, scenarios, slots, opts);
                    if (sc.wins > best.score.wins || (sc.wins === best.score.wins && sc.margin > best.score.margin + 1e-9)) {
                        best = { piles, score: sc };
                        improved = true;
                    }
                }
            }
        }
    }
    return best;
}

function describe({ piles, score: s }, slots, nScenarios, critMult = 1.5) {
    const need = Math.ceil(slots * 0.1);
    const used = piles.reduce((a, p) => a + p.qty, 0);
    // Espérance de dégâts par seconde, prime de critique comprise au vrai multiplicateur.
    const dps = piles.reduce((a, p) => a + p.qty * p.dmgAvg * (1 + (p.crit / 100) * (critMult - 1)) / p.speed, 0);
    const hp = piles.reduce((a, p) => a + p.qty * p.unitHp, 0);
    const cost = {};
    for (const p of piles) {
        for (const [res, v] of Object.entries(p.cost || {})) cost[res] = (cost[res] || 0) + v * p.qty;
    }
    return {
        types: piles.map((p) => ({
            key: p.key,
            fr: p.fr,
            roleFr: p.roleFr,
            abilityFr: p.abilityFr,
            qty: p.qty,
            abilityOn: p.qty >= need,
            share: Math.round((100 * p.qty) / (used || 1)),
        })),
        slotsUsed: used,
        wins: Math.round(s.wins),
        fights: nScenarios,
        winRate: Math.round(s.winRate * 10) / 10,
        margin: Math.round(s.margin * 1000) / 1000,
        dps: Math.round(dps),
        hp: Math.round(hp),
        abilitiesOn: piles.filter((p) => p.qty >= need && p.ability).map((p) => p.abilityFr),
        cost,
    };
}

/** Ce que tu as en ligne en ce moment, pour mesurer l'écart. */
function currentComposition(troops, params, slots) {
    const owned = Object.values(troops?.units || {})
        .filter((u) => u.cat === 'troops' && u.owned > 0)
        .map((u) => ({ ...params.get(u.key), qty: u.owned }))
        .filter((p) => p.key && p.dmgAvg > 0);
    void slots;
    return owned.length ? owned : null;
}

/* ---------- Énumération ---------- */

function* combinations(list, maxK) {
    for (let k = 1; k <= Math.min(maxK, list.length); k += 1) {
        yield* choose(list, k, 0, []);
    }
}

function* choose(list, k, start, acc) {
    if (acc.length === k) {
        yield [...acc];
        return;
    }
    for (let i = start; i <= list.length - (k - acc.length); i += 1) {
        acc.push(list[i]);
        yield* choose(list, k, i + 1, acc);
        acc.pop();
    }
}

/* Répartitions en dixièmes des places, chaque type recevant au moins un dixième : le seuil des
   capacités est précisément de 10 % des places, donc chaque part non nulle active sa capacité. */
function tenths(k) {
    const out = [];
    const walk = (left, parts) => {
        if (parts.length === k - 1) {
            if (left >= 1) out.push([...parts, left]);
            return;
        }
        for (let n = 1; n <= left - (k - 1 - parts.length); n += 1) {
            parts.push(n);
            walk(left - n, parts);
            parts.pop();
        }
    };
    walk(10, []);
    return out;
}

export { median };
