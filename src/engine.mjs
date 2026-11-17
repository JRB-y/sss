/* Le moteur de combat, calqué sur le serveur du jeu.

   Tout ce qui suit a été MESURÉ dans les frises de coups et les journaux des combats archivés
   (voir « Mécaniques » dans l'onglet Analyse, et docs/rapport.md) — pas supposé :

   — le temps est en centièmes de seconde ; une pile frappe à intervalle CONSTANT
     `round(vitesse × 100)`, son premier coup part à `round(intervalle × U(0,90 ; 1,00))` ;
   — un coup vaut `vivants × tirage_uniforme(min…max) × (critique ? ×mult) × (1 − fort/100)`,
     où `vivants = ceil(PV restants / PV unitaires)` — vérifié à l'unité près sur 4 900 coups ;
   — la cible est tirée au sort, pondérée par les PV restants des piles adverses ;
   — le multiplicateur critique vaut ×1,5, ×2,0 avec le talent « Executioner » (mesuré 1,98),
     ×2,5 pour une pile qui porte Saignée ;
   — la riposte se déclenche avec la probabilité `riposte%` de la cible ; les unités qui ripostent
     valent `min(vivants de la cible, vivants de l'attaquant)` — règle vérifiée sur 1 265
     ripostes — à 60 % d'un tirage normal, réduite par le fort du camp qui l'encaisse,
     et une riposte n'est jamais critique (0 sur 1 346 dans l'archive) ;
   — le bouclier est un POOL COMMUN à l'armée (8,000 % des PV de départ, mesuré exact), consommé
     avant les PV, quel que soit le groupe touché ;
   — rage : ≤ 50 % des PV MAX de l'armée → +35 % de dégâts (mesuré ×1,350) pendant 10 s ;
   — second souffle : ≤ 30 % des PV max → chaque pile vivante récupère
     `min(12 % de ses PV de DÉPART, ce qui lui manque pour revenir à ses PV de départ)` —
     les montants servis par le jeu collent à l'unité près ;
   — onde de choc : l'adversaire a perdu ≥ 30 % de ses PV de DÉPART → chaque pile adverse perd
     le même POURCENTAGE de ses PV courants ; le total vaut ≈ 10 % des PV courants du camp
     lanceur × (1 − fort adverse) (résidu ±20 %, tiré au sort en mode aléatoire) ;
   — frénésie : vitesse ×1,5 pendant 2 s (le délai du premier coup n'en profite pas) ;
   — embuscade : à t = 0, chaque pile du camp frappe une fois à 40 % de sa puissance
     (mesuré 0,39–0,42), critique possible ;
   — une capacité n'agit que si sa pile atteint 10 % des places de troupes, et ne se déclenche
     qu'UNE fois par combat.

   Capacités jamais croisées dans l'archive — encodées depuis les règles officielles, à prendre
   avec prudence : gel du temps (adversaire figé 0,5 s), intimidation (−20 % dégâts adverses 5 s),
   forteresse (−35 % de dégâts subis 10 s sous 40 % ou à la première pile tombée), dernier carré
   (+50 % dégâts et vitesse sous 25 %), coup de grâce (les groupes adverses les plus abîmés sont
   achevés sous 35 %), renvoi (2 % des dégâts reçus renvoyés), corruption (le plus gros groupe
   adverse figé jusqu'à 2 s).

   Deux modes :
   — `mode: 'expected'` (défaut) : chaque tirage est remplacé par son espérance. Déterministe,
     rapide, parfait pour comparer des compositions ;
   — `mode: 'random'`  : vrais tirages, seedés (reproductibles). `simulateMany()` en déduit une
     probabilité de victoire — c'est la seule réponse honnête d'un jeu qui tire au hasard. */

const CAP = 9000; // 90 s — le plus long combat archivé dure 50 s

export const TRIGGERS = {
    rage: { ownMaxBelow: 0.50, dmgMult: 1.35, durationCs: 1000 },
    second_wind: { ownMaxBelow: 0.30, healPctOfStart: 0.12 },
    shockwave: { foeStartBelow: 0.70, pctOfOwnCur: 0.10, spread: [0.06, 0.125] },
    fortress: { ownMaxBelow: 0.40, orFirstPileDown: true, takenMult: 0.65, durationCs: 1000 },
    last_stand: { ownMaxBelow: 0.25, dmgMult: 1.5, speedMult: 1.5 },
    execute: { foeMaxBelow: 0.35 },
};

export const OPENERS = {
    shield: { poolPctOfStart: 0.08 },
    ambush: { power: 0.40 },
    frenzy: { speedMult: 1.5, durationCs: 200 },
    freeze: { foeFrozenCs: 50 },
    intimidate: { foeDmgMult: 0.80, durationCs: 500 },
    corrupt: { frozenCs: 200 },
};

/* ---------- RNG (mulberry32, seedé, reproductible) ---------- */

export function makeRng(seed = 1) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ---------- Construction d'un camp ---------- */

/**
 * @param piles [{key, fr, qty, unitHp, dmgMin, dmgMax, crit, counter, speed | intervalCs,
 *               role, ability, hp?}]  (hp = PV de départ s'ils diffèrent du max : défense)
 * @param opts  {slots, fort, guard, readiness, critMult}
 */
export function army(piles, { slots, fort = 0, guard = 0, readiness = 1, critMult = 1.5 } = {}) {
    const totalQty = piles.reduce((a, p) => a + (p.qty || 0), 0);
    const need = Math.ceil((slots || totalQty) * 0.1);
    const list = piles.filter((p) => p.qty > 0).map((p) => {
        const max = p.qty * p.unitHp;
        /* Le poste de garde est un plancher sur les PV de DÉPART en défense (« tes troupes se
           battent avec au moins X % de leur vie »), pas un plancher pendant le combat. */
        const start = Math.max(p.hp ?? max * (readiness ?? 1), guard ? (max * guard) / 100 : 0);
        const dmgMin = p.dmgMin ?? p.dmgAvg ?? 0;
        const dmgMax = p.dmgMax ?? p.dmgAvg ?? 0;
        return {
            key: p.key,
            fr: p.fr || p.key,
            qty: p.qty,
            unitHp: p.unitHp,
            max,
            start,
            dmgMin,
            dmgMax,
            dmgAvg: (dmgMin + dmgMax) / 2,
            crit: Math.max(0, Math.min(100, p.crit ?? 0)),
            counter: Math.max(0, Math.min(100, p.counter ?? 0)),
            intervalCs: Math.max(1, Math.round(p.intervalCs ?? (p.speed ?? 1) * 100)),
            speed: p.speed ?? (p.intervalCs ?? 100) / 100,
            role: p.role || null,
            roleFr: p.roleFr || null,
            ability: p.ability || null,
            abilityFr: p.abilityFr || null,
            abilityOn: Boolean(p.ability) && p.qty >= need,
            cost: p.cost || null,
            source: p.source || null,
            loadout: p.loadout || null,
            loadoutEstimated: p.loadoutEstimated || false,
        };
    });
    return {
        piles: list,
        need,
        fort,
        guard,
        readiness,
        critMult,
        maxHp: list.reduce((a, p) => a + p.max, 0),
        startHp: list.reduce((a, p) => a + p.start, 0),
        abilities: [...new Set(list.filter((p) => p.abilityOn).map((p) => p.ability))],
    };
}

/* ---------- État d'un combat ---------- */

function sideState(a) {
    return {
        fort: a.fort || 0,
        critMult: a.critMult || 1.5,
        maxHp: a.maxHp,
        startHp: a.startHp,
        shield: 0,
        dmgWindows: [], // {from, until, mult}
        takenWindows: [],
        speedWindows: [],
        lastStand: false,
        firstPileDown: false,
        abilities: a.abilities,
        piles: a.piles.map((p) => ({
            ...p,
            hp: p.start,
            frozenUntil: 0,
            nextHit: 0,
            dealt: 0,
            taken: 0,
            fired: false, // sa capacité à déclenchement s'est-elle consommée ?
        })),
    };
}

const aliveUnits = (p) => (p.hp > 0 ? Math.min(p.qty, Math.ceil(p.hp / p.unitHp)) : 0);
const armyHp = (s) => s.piles.reduce((a, p) => a + Math.max(0, p.hp), 0);

function multAt(windows, t, extra = 1) {
    let m = extra;
    for (const w of windows) if (t >= w.from && t <= w.until) m *= w.mult;
    return m;
}

/* ---------- Le combat ---------- */

/**
 * Joue un combat. `mode: 'expected'` (déterministe, espérances) ou `'random'` (tirages seedés).
 * `trace: true` enregistre coups, capacités et courbe de PV.
 */
export function simulate(A, B, { mode = 'expected', seed = 1, cap = CAP, trace = false } = {}) {
    const rng = mode === 'random' ? makeRng(seed) : null;
    const E = mode !== 'random'; // mode espérance
    const sides = [sideState(A), sideState(B)];
    const rec = trace ? { hits: [], abilities: [], hp: [], max: [sides[0].maxHp, sides[1].maxHp], start: [sides[0].startHp, sides[1].startHp] } : null;

    // Délai du premier coup : U(0,90 ; 1,00) × intervalle (mesuré ; 0,95 en espérance).
    for (const s of sides) {
        for (const p of s.piles) {
            p.nextHit = Math.max(1, Math.round(p.intervalCs * (E ? 0.95 : 0.9 + rng() * 0.1)));
        }
    }

    openers(sides, rng, E, rec, cap);
    if (rec) sample(rec, sides, 0);

    let t = 0;
    let guard = 0;
    while (t < cap && armyHp(sides[0]) > 0 && armyHp(sides[1]) > 0 && guard < 20000) {
        guard += 1;
        // prochaine frappe toutes piles confondues
        let next = Infinity;
        for (const s of sides) {
            for (const p of s.piles) {
                if (p.hp <= 0) continue;
                const h = Math.max(p.nextHit, p.frozenUntil);
                if (h < next) next = h;
            }
        }
        if (!Number.isFinite(next)) break;
        t = next;
        if (t >= cap) break;
        for (const [i, s] of sides.entries()) {
            const foe = sides[1 - i];
            for (const p of s.piles) {
                if (p.hp <= 0 || Math.max(p.nextHit, p.frozenUntil) !== t) continue;
                strike(p, s, foe, i, t, 1, rng, E, rec, false);
                const speedMult = multAt(s.speedWindows, t);
                p.nextHit = t + Math.max(1, Math.round(p.intervalCs / speedMult));
                checkTriggers(sides, t, rng, E, rec, cap);
                if (armyHp(sides[0]) <= 0 || armyHp(sides[1]) <= 0) break;
            }
        }
        if (rec) sample(rec, sides, t);
    }
    if (rec) sample(rec, sides, t, true);

    const hp = [armyHp(sides[0]), armyHp(sides[1])];
    const frac = [hp[0] / (sides[0].maxHp || 1), hp[1] / (sides[1].maxHp || 1)];
    return {
        winner: hp[0] > 0 && hp[1] <= 0 ? 'A' : hp[1] > 0 && hp[0] <= 0 ? 'B' : frac[0] > frac[1] ? 'A' : 'B',
        margin: frac[0] - frac[1],
        seconds: Math.round(t) / 100,
        timeout: t >= cap,
        left: { A: frac[0], B: frac[1] },
        abilities: { A: sides[0].abilities, B: sides[1].abilities },
        piles: {
            A: sides[0].piles.map(pileResult),
            B: sides[1].piles.map(pileResult),
        },
        trace: rec ? finishTrace(rec, t) : null,
    };
}

const pileResult = (p) => ({
    key: p.key,
    fr: p.fr,
    qty: p.qty,
    alive: aliveUnits(p),
    dealt: Math.round(p.dealt),
    taken: Math.round(p.taken),
    left: p.max ? Math.max(0, p.hp) / p.max : 0,
    hp: Math.round(Math.max(0, p.hp)),
    maxHp: Math.round(p.max),
    ability: p.ability,
    abilityFr: p.abilityFr,
    abilityOn: p.abilityOn,
    role: p.role,
    roleFr: p.roleFr,
});

/* ---------- Capacités de début de combat ---------- */

function openers(sides, rng, E, rec, cap) {
    // D'abord les effets d'état (bouclier, gel, corruption, intimidation, frénésie)…
    for (const [i, s] of sides.entries()) {
        const foe = sides[1 - i];
        for (const p of s.piles) {
            if (!p.abilityOn) continue;
            switch (p.ability) {
                case 'shield':
                    s.shield += s.startHp * OPENERS.shield.poolPctOfStart;
                    note(rec, 0, i, 'shield', Math.round(s.startHp * OPENERS.shield.poolPctOfStart));
                    break;
                case 'frenzy':
                    s.speedWindows.push({ from: 0, until: OPENERS.frenzy.durationCs, mult: OPENERS.frenzy.speedMult });
                    note(rec, 0, i, 'frenzy', OPENERS.frenzy.durationCs);
                    break;
                case 'freeze':
                    for (const q of foe.piles) q.frozenUntil = Math.max(q.frozenUntil, OPENERS.freeze.foeFrozenCs);
                    note(rec, 0, i, 'freeze', OPENERS.freeze.foeFrozenCs);
                    break;
                case 'intimidate':
                    foe.dmgWindows.push({ from: 0, until: OPENERS.intimidate.durationCs, mult: OPENERS.intimidate.foeDmgMult });
                    note(rec, 0, i, 'intimidate', OPENERS.intimidate.durationCs);
                    break;
                case 'corrupt': {
                    // Le plus gros groupe adverse, figé moins longtemps s'il fait presque toute l'armée.
                    const biggest = foe.piles.slice().sort((x, y) => y.max - x.max)[0];
                    if (biggest) {
                        const share = biggest.max / (foe.maxHp || 1);
                        const dur = Math.round(OPENERS.corrupt.frozenCs * Math.min(1, Math.max(0.25, (1 - share) * 2)));
                        biggest.frozenUntil = Math.max(biggest.frozenUntil, dur);
                        note(rec, 0, i, 'corrupt', dur);
                    }
                    break;
                }
                default:
            }
        }
    }
    // …puis les frappes d'embuscade (attaquant d'abord, comme un tour normal).
    for (const [i, s] of sides.entries()) {
        const foe = sides[1 - i];
        const hasAmbush = s.piles.some((p) => p.abilityOn && p.ability === 'ambush');
        if (!hasAmbush) continue;
        note(rec, 0, i, 'ambush', 0);
        for (const p of s.piles) {
            if (p.hp <= 0) continue;
            strike(p, s, foe, i, 0, OPENERS.ambush.power, rng, E, rec, true);
        }
        checkTriggers(sides, 0, rng, E, rec, cap);
    }
}

/* ---------- Un coup ---------- */

function strike(p, me, foe, sideIdx, t, scale, rng, E, rec, isOpener) {
    const alive = aliveUnits(p);
    if (alive <= 0) return;

    // Tirage de dégâts par unité, uniforme entre min et max.
    const roll = E ? p.dmgAvg : p.dmgMin + rng() * (p.dmgMax - p.dmgMin);
    // Critique : ×1,5 (×2,0 avec Executioner), ×2,5 pour une pile Saignée.
    const mult = p.abilityOn && p.ability === 'bleed' ? 2.5 : me.critMult;
    const critFactor = E
        ? 1 + (p.crit / 100) * (mult - 1)
        : (rng() < p.crit / 100 ? mult : 1);
    const dmgMult = multAt(me.dmgWindows, t) * (me.lastStand ? TRIGGERS.last_stand.dmgMult : 1);
    const takenMult = multAt(foe.takenWindows, t);
    const power = alive * roll * critFactor * dmgMult * (1 - foe.fort / 100) * takenMult * scale;

    // Cible : tirée au sort pondérée par les PV restants (espérance : réparti au prorata).
    const targets = foe.piles.filter((q) => q.hp > 0);
    const pool = targets.reduce((a, q) => a + q.hp, 0);
    if (pool <= 0) return;

    let dealt = 0;
    let back = 0;
    const hitOne = (q, dmg, share) => {
        const aliveT = aliveUnits(q);
        const applied = applyDamage(foe, q, dmg);
        dealt += applied;
        // Riposte : min(vivants cible, vivants attaquant) unités, ×0,6, jamais critique,
        // réduite par le fort du camp qui l'encaisse.
        if (q.counter > 0 && aliveT > 0) {
            const units = Math.min(aliveT, alive);
            const rollT = E ? q.dmgAvg : q.dmgMin + rng() * (q.dmgMax - q.dmgMin);
            const dmgMultT = multAt(foe.dmgWindows, t) * (foe.lastStand ? TRIGGERS.last_stand.dmgMult : 1);
            const base = units * rollT * 0.6 * dmgMultT * (1 - me.fort / 100) * multAt(me.takenWindows, t);
            const expect = E ? base * (q.counter / 100) * share : (rng() < q.counter / 100 ? base : 0);
            if (expect > 0) {
                const done = applyDamage(me, p, expect);
                q.dealt += done;
                back += done;
            }
        }
        // Renvoi : 2 % des dégâts reçus reviennent au groupe qui frappe.
        if (q.abilityOn && q.ability === 'reflect' && applied > 0) {
            const done = applyDamage(me, p, applied * 0.02);
            q.dealt += done;
            back += done;
        }
    };

    if (E) {
        for (const q of targets) hitOne(q, power * (q.hp / pool), q.hp / pool);
    } else {
        let pick = rng() * pool;
        let target = targets[targets.length - 1];
        for (const q of targets) { pick -= q.hp; if (pick <= 0) { target = q; break; } }
        hitOne(target, power, 1);
    }
    p.dealt += dealt;
    if (rec) rec.hits.push([Math.round(t), sideIdx, p.key, Math.round(dealt), Math.round(back), isOpener ? 1 : 0]);
}

/** Applique des dégâts à une pile — le bouclier du camp (pool commun) encaisse d'abord. */
function applyDamage(side, q, dmg) {
    let rest = dmg;
    if (side.shield > 0) {
        const eaten = Math.min(side.shield, rest);
        side.shield -= eaten;
        rest -= eaten;
    }
    if (rest > 0) {
        if (q.hp > 0 && q.hp - rest <= 0) side.firstPileDown = true;
        q.hp -= rest;
    }
    q.taken += dmg;
    return dmg; // le bouclier absorbé compte dans les dégâts infligés (comme dans les rapports)
}

/* ---------- Capacités à seuil ---------- */

function checkTriggers(sides, t, rng, E, rec, cap) {
    for (const [i, s] of sides.entries()) {
        const foe = sides[1 - i];
        const ownFracMax = armyHp(s) / (s.maxHp || 1);
        const foeFracStart = armyHp(foe) / (foe.startHp || 1);
        const foeFracMax = armyHp(foe) / (foe.maxHp || 1);
        for (const p of s.piles) {
            if (!p.abilityOn || p.fired || p.hp <= 0) continue;
            const spec = TRIGGERS[p.ability];
            if (!spec) continue;

            if (p.ability === 'rage' && ownFracMax <= spec.ownMaxBelow) {
                p.fired = true;
                s.dmgWindows.push({ from: t, until: t + spec.durationCs, mult: spec.dmgMult });
                note(rec, t, i, 'rage', spec.durationCs);
            }
            if (p.ability === 'second_wind' && ownFracMax <= spec.ownMaxBelow) {
                p.fired = true;
                let healed = 0;
                for (const q of s.piles) {
                    if (q.hp <= 0) continue;
                    const heal = Math.min(q.start * spec.healPctOfStart, Math.max(0, q.start - q.hp));
                    q.hp += heal;
                    healed += heal;
                }
                note(rec, t, i, 'second_wind', Math.round(healed));
            }
            if (p.ability === 'shockwave' && foeFracStart <= spec.foeStartBelow) {
                p.fired = true;
                const pct = E ? spec.pctOfOwnCur : spec.spread[0] + rng() * (spec.spread[1] - spec.spread[0]);
                const total = armyHp(s) * pct * (1 - foe.fort / 100);
                const pool = armyHp(foe) || 1;
                let done = 0;
                for (const q of foe.piles) {
                    if (q.hp <= 0) continue;
                    done += applyDamage(foe, q, total * (Math.max(0, q.hp) / pool));
                }
                p.dealt += done;
                note(rec, t, i, 'shockwave', Math.round(done));
            }
            if (p.ability === 'fortress'
                && (ownFracMax <= spec.ownMaxBelow || (spec.orFirstPileDown && s.firstPileDown))) {
                p.fired = true;
                s.takenWindows.push({ from: t, until: t + spec.durationCs, mult: spec.takenMult });
                note(rec, t, i, 'fortress', spec.durationCs);
            }
            if (p.ability === 'last_stand' && ownFracMax <= spec.ownMaxBelow) {
                p.fired = true;
                s.lastStand = true;
                s.speedWindows.push({ from: t, until: cap, mult: spec.speedMult });
                note(rec, t, i, 'last_stand', 0);
            }
            if (p.ability === 'execute' && foeFracMax <= spec.foeMaxBelow) {
                p.fired = true;
                // « Ses groupes les plus abîmés sont achevés » : la pile adverse la plus entamée tombe.
                const target = foe.piles.filter((q) => q.hp > 0)
                    .sort((a, b) => a.hp / a.max - b.hp / b.max)[0];
                if (target) {
                    const done = applyDamage(foe, target, Math.max(0, target.hp));
                    p.dealt += done;
                    note(rec, t, i, 'execute', Math.round(done));
                }
            }
        }
    }
}

function note(rec, t, side, key, amount) {
    if (rec) rec.abilities.push([Math.round(t), side, key, amount]);
}

/* ---------- Trace ---------- */

function sample(rec, sides, t, force = false) {
    const last = rec.hp[rec.hp.length - 1];
    if (!force && last && t - last[0] < 25) return;
    if (last && last[0] === t) return;
    rec.hp.push([
        Math.round(t),
        Math.max(0, armyHp(sides[0])) / (rec.max[0] || 1),
        Math.max(0, armyHp(sides[1])) / (rec.max[1] || 1),
    ]);
}

function finishTrace(rec, t) {
    return {
        cs: Math.round(t),
        seconds: Math.round(t) / 100,
        hp: rec.hp.map(([tt, a, b]) => [tt, Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]),
        hits: rec.hits,
        abilities: rec.abilities,
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

/* ---------- Monte-Carlo ---------- */

/**
 * Rejoue le même duel N fois avec de vrais tirages et renvoie la distribution des issues.
 * C'est la réponse honnête : le jeu tire les dégâts au hasard, deux combats identiques peuvent
 * basculer dans les deux sens (combats 11055 et 11060 de l'archive : mêmes armées, un gagné,
 * un perdu).
 */
export function simulateMany(A, B, { runs = 400, seed = 42, trace = false, cap = CAP } = {}) {
    const margins = [];
    const perRun = [];
    const durations = [];
    let wins = 0;
    let timeouts = 0;
    const leftA = [];
    const leftB = [];
    for (let i = 0; i < runs; i += 1) {
        const s = seed + i * 7919;
        const r = simulate(A, B, { mode: 'random', seed: s, cap });
        margins.push(r.margin);
        perRun.push([s, r.margin]);
        durations.push(r.seconds);
        leftA.push(r.left.A);
        leftB.push(r.left.B);
        if (r.winner === 'A') wins += 1;
        if (r.timeout) timeouts += 1;
    }
    margins.sort((a, b) => a - b);
    durations.sort((a, b) => a - b);
    const qt = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    const result = {
        runs,
        wins,
        pWin: wins / runs,
        timeouts,
        margin: { p10: qt(margins, 0.1), p50: qt(margins, 0.5), p90: qt(margins, 0.9) },
        seconds: { p10: qt(durations, 0.1), p50: qt(durations, 0.5), p90: qt(durations, 0.9) },
        left: {
            A: leftA.reduce((a, b) => a + b, 0) / runs,
            B: leftB.reduce((a, b) => a + b, 0) / runs,
        },
    };
    if (trace) {
        // La passe tracée est celle dont la marge est la plus proche de la médiane : le déroulé
        // « typique », pas le plus chanceux ni le plus noir.
        const med = qt(margins, 0.5);
        let bestSeed = seed;
        let bestGap = Infinity;
        for (const [s, m] of perRun) {
            const gap = Math.abs(m - med);
            if (gap < bestGap) { bestGap = gap; bestSeed = s; }
        }
        result.median = simulate(A, B, { mode: 'random', seed: bestSeed, cap, trace: true });
    }
    return result;
}
