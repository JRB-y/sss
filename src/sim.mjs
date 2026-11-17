import { cardStats, median, ABILITY_FR, ROLE_FR } from './analyse.mjs';
import { atTypeLevel } from './gear.mjs';
import { army, simulate, simulateMany } from './engine.mjs';
import { applyLoadout, currentLoadouts } from './arsenal.mjs';

/* Simulateur de combat et recherche de compositions.

   Le moteur (src/engine.mjs) reproduit les mécaniques EXACTES du jeu, rétro-conçues depuis les
   frises de coups et les journaux de l'archive : intervalles de frappe déterministes, tirages
   uniformes min…max, vivants = ceil(PV/PV unitaire), riposte min(cible, attaquant) × 0,6,
   bouclier en pool commun (8 % des PV de départ), seuils et amplitudes mesurés des capacités.
   Voir l'en-tête de src/engine.mjs pour la liste complète, chiffres à l'appui.

   Deux lectures d'un même duel :
   — le mode « espérance » (déterministe) sert à CLASSER des compositions : pas de bruit,
     deux compos se comparent à l'identique ;
   — le Monte-Carlo (vrais tirages, seedés) donne la PROBABILITÉ de victoire — la seule réponse
     honnête d'un jeu qui tire les dégâts au hasard : l'archive contient deux combats identiques
     (11055 et 11060) aux issues opposées. */

export { army, simulate, simulateMany };

/* ---------- Paramètres d'un type ---------- */

/* Pour mes types : la carte du shop donne les stats réelles, équipement et talents compris.
   Pour les types adverses : la carte donne vitesse, critique et riposte (constantes du type),
   l'historique donne la cadence exacte et les PV servis par le serveur. */
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
                unitHp: b.hp, dmgAvg: b.avgDmg, dmgMin: b.dmgMin, dmgMax: b.dmgMax,
                crit: b.crit, counter: b.counter, speed: b.speed, typeLevel: b.typeLevel,
            },
            key: card.key,
            fr: card.fr || card.name,
            role: card.role?.key || null,
            roleFr: ROLE_FR[card.role?.key] || null,
            ability: card.ability?.key || null,
            abilityFr: card.ability?.fr || ABILITY_FR[card.ability?.key] || null,
            unitHp: s.hp,
            dmgAvg: s.avgDmg,
            dmgMin: s.dmgMin,
            dmgMax: s.dmgMax,
            crit: s.crit,
            counter: s.counter,
            speed: s.speed,
            intervalCs: Math.round(s.speed * 100),
            cost: s.cost,
            dpsPerUnit: s.dpsPerUnit,
            typeLevel: s.typeLevel,
            foe: measured ? {
                unitHp: measured.unitHpMedian,
                dmgAvg: measured.dpuPerHit,
                qtyMedian: measured.qtyMedian,
                intervalCs: measured.intervalCs || null,
            } : null,
        });
    }
    return params;
}

/* Une pile d'un combat passé, reconstruite au plus près de ce que le rapport dit vraiment.
   Trois sources, chacune à sa place :

   1. **Servi par le serveur** — les PV unitaires. Équipement, talents et bonus de famille d'en
      face y sont déjà : rien à deviner, vrai pour les deux camps.
   2. **Mesuré dans la frise** — la cadence EXACTE de la pile (mode des écarts entre coups, en
      centièmes). Elle intègre les bonus de vitesse intrinsèques des objets, que le jeu ne publie
      pas : les piles à affixe de vitesse frappent ~10 % plus vite que l'affixe ne le promet.
   3. **Carte du shop + équipement relevé** — les stats de base du type à son niveau, plus les
      affixes des trois pièces. Le bonus intrinsèque des objets (non publié) est déduit du résidu
      de PV et appliqué aussi aux dégâts : approximation, mais symétrique entre les camps.

   Les dégâts par coup mesurés (`dpuPerHit`) ne servent QUE de repli pour un type sans fiche :
   ils incluent rage/frénésie que le moteur réapplique ensuite (comptage double, vérifié nocif). */
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
            dmgAvg: observed ?? 0, dmgMin: (observed ?? 0) * 0.97, dmgMax: (observed ?? 0) * 1.03,
            dmgSource: observed ? 'mesuré (type sans fiche)' : 'inconnu',
            crit: 10, counter: 5,
            intervalCs: p.intervalCs || Math.round((p.interval || 1.5) * 100),
            speed: p.interval || 1.5, speedSource: p.intervalCs ? 'mesuré' : 'défaut',
            role: p.role, roleFr: ROLE_FR[p.role] || p.role,
            ability: p.ability, abilityFr: ABILITY_FR[p.ability] || p.ability,
        };
    }

    const lv = atTypeLevel(base, base.typeLevel, p.typeLevel ?? base.typeLevel);
    const lvFactor = base.dmgAvg ? lv.dmgAvg / base.dmgAvg : 1;

    /* Le jeu compose dans cet ordre — vérifié sur les types que je n'équipe pas, où
       `(base + plats) × (1 + %)` tombe à 1 % près sur la valeur servie :

           réel = (base_du_type_à_son_niveau + bonus_plats) × (1 + %talents + %objets)

       Les PV unitaires sont connus (servis). Ce qu'ils contiennent au-delà des talents et des
       affixes, c'est le bonus intrinsèque des objets — déduit du résidu, appliqué aux dégâts. */
    const hpExplained = (lv.unitHp + (tal.hpFlat || 0)) * (1 + ((tal.hpPct || 0) + gear.hp) / 100);
    const intrinsicPct = hpExplained > 0 ? (p.unitHp / hpExplained - 1) * 100 : 0;

    const dmgScale = (1 + ((tal.dmgPct || 0) + gear.dmg + intrinsicPct) / 100);
    const dmgMin = (base.dmgMin * lvFactor + (tal.dmgFlat || 0)) * dmgScale;
    const dmgMax = (base.dmgMax * lvFactor + (tal.dmgFlat || 0)) * dmgScale;

    const intervalCard = Math.round((base.speed * 100) / (1 + ((tal.speedPct || 0) + gear.speed) / 100));

    return {
        key: p.key,
        fr: t?.fr || p.base,
        qty: p.qty,
        unitHp: p.unitHp, // servi par le serveur : équipement et talents d'en face compris
        hp: p.hp,
        dmgAvg: (dmgMin + dmgMax) / 2,
        dmgMin,
        dmgMax,
        dmgSource: 'carte + talents + équipement',
        crit: lv.crit + (tal.critPts || 0) + gear.crit,
        counter: lv.counter + (tal.counterPts || 0) + gear.riposte,
        // La cadence mesurée prime : elle intègre les bonus de vitesse que le jeu ne publie pas.
        intervalCs: p.intervalCs || intervalCard,
        speed: (p.intervalCs || intervalCard) / 100,
        speedSource: p.intervalCs ? 'mesuré' : 'carte + talents + équipement',
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
 * ton équipement du moment. Surtout ne pas y réappliquer les talents : comptage double.
 */
export function composeArmy(spec, params, { slots, fort = 0, guard = 0, readiness = 1, critMult = 1.5, gearCtx = null } = {}) {
    const piles = [];
    const unknown = [];
    for (const { key, qty, gear } of spec || []) {
        let t = params.get(key);
        if (!t) { unknown.push(key); continue; }
        if (!(qty > 0)) continue;
        /* Équipement choisi à la main : les stats de la carte sont recalculées en DELTA depuis
           l'équipement réellement porté (affixes exacts + bonus intrinsèques estimés de
           l'arsenal). Même équipement → exactement les stats actuelles. */
        if (gear && gearCtx?.arsenal) {
            t = applyLoadout(t, gear, {
                talents: gearCtx.talents || null,
                arsenal: gearCtx.arsenal,
                current: gearCtx.current?.[key] || null,
            });
        }
        piles.push({
            key: t.key,
            fr: t.fr,
            qty: Math.round(qty),
            unitHp: t.unitHp,
            dmgAvg: t.dmgAvg,
            dmgMin: t.dmgMin,
            dmgMax: t.dmgMax,
            crit: t.crit,
            counter: t.counter,
            speed: t.speed,
            intervalCs: t.intervalCs,
            role: t.role,
            roleFr: t.roleFr,
            ability: t.ability,
            abilityFr: t.abilityFr,
            cost: t.cost,
            loadout: t.loadout || null,
            loadoutEstimated: t.loadoutEstimated || false,
        });
    }
    const built = army(piles, { slots, fort, guard, readiness, critMult });
    built.unknown = unknown;
    built.customGear = piles.some((p) => p.loadout);
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

/* ---------- Le facteur de dégâts par adversaire ----------

   Les PV unitaires servis par le serveur contiennent l'équipement et les talents de VIE d'en
   face — mais pas ses talents de DÉGÂTS, qui peuvent valoir +45 % (les miens : +21 % et
   +70 plat). Le résidu de PV ne les voit pas, et la reconstruction par la carte se trompait
   d'autant : mesuré ×1,4 chez certains joueurs, ×0,65 chez d'autres.

   Le journal de combat donne le tirage normal médian de chaque pile (`rollMedian`). Le rapport
   `mesuré ÷ reconstruit` est STABLE par joueur et par type (±5 % d'un combat à l'autre) : c'est
   la signature de ses talents. On l'apprend sur ses combats passés et on l'applique aux
   reconstructions — en backtest, le combat rejoué est exclu de sa propre mesure (leave-one-out). */

const factorsCache = new WeakMap();

export function opponentFactors(analysis, params, { talents = null } = {}) {
    if (factorsCache.has(analysis)) return factorsCache.get(analysis);
    const map = new Map(); // `${oppId}|${base}` et `${oppId}` → [{fightId, factor, critRate, critMult, counterRate}]
    const all = [];
    for (const f of analysis.fights) {
        // Mes propres piles aussi : mes talents d'ALORS ne sont pas ceux d'aujourd'hui, et le
        // journal les mesure directement. Clé `me|type`, même logique leave-one-out.
        const fortAgainstMe = f.role === 'attaque' ? f.fort.theirs || 0 : 0;
        for (const p of f.myPiles) {
            if (!Number.isFinite(p.rollMedian)) continue;
            // même reconstruction que celle sur laquelle le facteur sera appliqué : talents compris
            const rebuilt = pileStats(p, params, { fortAgainstThem: fortAgainstMe, talents });
            if (!(rebuilt.dmgAvg > 0) || rebuilt.dmgSource !== 'carte + talents + équipement') continue;
            const factor = p.rollMedian / (1 - fortAgainstMe / 100) / rebuilt.dmgAvg;
            if (!Number.isFinite(factor) || factor <= 0) continue;
            const k = `me|${p.base}`;
            (map.get(k) || map.set(k, []).get(k)).push({ fightId: f.id, factor });
        }
        const fortAgainstThem = f.role === 'défense' ? f.fort.mine || 0 : 0;
        for (const p of f.theirPiles) {
            const rebuilt = pileStats(p, params, { fortAgainstThem });
            const cardOk = rebuilt.dmgAvg > 0 && rebuilt.dmgSource === 'carte + talents + équipement';
            const factor = cardOk && Number.isFinite(p.rollMedian)
                ? p.rollMedian / (1 - fortAgainstThem / 100) / rebuilt.dmgAvg
                : null;
            const s = p.logStats || {};
            if (factor == null && s.critRate == null && s.critMult == null && s.counterRate == null) continue;
            const entry = {
                fightId: f.id,
                factor: Number.isFinite(factor) && factor > 0 ? factor : null,
                critRate: s.critRate ?? null,
                critMult: s.critMult ?? null,
                counterRate: s.counterRate ?? null,
            };
            for (const k of [`${f.opponent.id}|${p.base}`, `${f.opponent.id}`]) {
                (map.get(k) || map.set(k, []).get(k)).push(entry);
            }
            all.push(entry);
        }
    }
    map.set('*', all);
    factorsCache.set(analysis, map);
    return map;
}

/** Médiane d'une mesure apprise, du plus spécifique au plus général (type → joueur → global).
 *  `strict` n'accepte que la clé exacte joueur|type : les taux de critique et de riposte sont
 *  propres au TYPE (un voyou ne riposte pas comme un bandit), seul le facteur de dégâts et le
 *  multiplicateur critique — des traits du joueur — ont le droit de généraliser. */
function learnedStat(factors, oppId, base, excludeFightId, field, fallback = null, { strict = false } = {}) {
    if (!factors) return fallback;
    const keys = strict ? [`${oppId}|${base}`] : [`${oppId}|${base}`, `${oppId}`, '*'];
    for (const k of keys) {
        const xs = (factors.get(k) || [])
            .filter((e) => e.fightId !== excludeFightId && Number.isFinite(e[field]))
            .map((e) => e[field]);
        if (xs.length) return median(xs);
    }
    return fallback;
}

/* Armée adverse d'un combat passé, reconstruite à partir de données d'avant-combat seulement.
   Ses talents à lui sont inconnus : absorbés par le résidu de PV (cf. `pileStats`). Son
   multiplicateur critique mesuré sur l'archive vaut ×1,5 (la valeur de base).

   Les capacités réellement actives sont FORCÉES depuis `abOn` du rapport : le serveur dit
   lesquelles ont tourné, inutile de deviner son seuil de places. Recalculer l'activation
   depuis une estimation de ses places se trompait souvent (et coûtait ~7 points de justesse). */
function foeArmyFromFight(fight, params, { role, foeCritMult = 1.5, factors = null, excludeSelf = false }) {
    // Quand je défends, MES murs rabotaient leurs coups : il faut les retirer de la mesure.
    const fortAgainstThem = role === 'défense' ? fight.fort.mine || 0 : 0;
    const exclude = excludeSelf ? fight.id : null;
    const oppId = fight.opponent.id;
    const piles = fight.theirPiles.map((p) => {
        const s = pileStats(p, params, { fortAgainstThem });
        // Les talents d'en face, appris sur ses AUTRES combats (cf. `opponentFactors`) :
        // facteur de dégâts, taux de critique et taux de riposte réellement observés.
        const f = learnedStat(factors, oppId, p.base, exclude, 'factor', 1);
        if (f !== 1) {
            s.dmgMin *= f;
            s.dmgMax *= f;
            s.dmgAvg *= f;
            s.dmgFactor = Math.round(f * 100) / 100;
        }
        const critRate = learnedStat(factors, oppId, p.base, exclude, 'critRate', null, { strict: true });
        if (critRate != null) s.crit = critRate;
        const counterRate = learnedStat(factors, oppId, p.base, exclude, 'counterRate', null, { strict: true });
        if (counterRate != null) s.counter = counterRate;
        return s;
    });
    // Multiplicateur critique d'en face : ×1,5 de base, ×2,0 si ses journaux montrent Executioner.
    const mult = learnedStat(factors, oppId, null, exclude, 'critMult');
    const critMult = mult != null && mult >= 1.75 ? 2.0 : foeCritMult;
    // Le seuil de capacité d'en face suit SES places : on l'approche par son armée engagée.
    const a = army(piles, {
        slots: Math.round(fight.army.theirs.qty / 0.9),
        fort: role === 'défense' ? 0 : fight.fort.theirs,
        guard: role === 'défense' ? 0 : fight.guard,
        critMult,
    });
    forceAbilities(a, fight.abOnTheirs);
    return a;
}

/** Mon armée telle qu'elle était dans un combat passé — mes talents, eux, sont connus. */
function myArmyFromFight(fight, params, { talents = null, critMult, factors = null, excludeSelf = false } = {}) {
    // Quand j'attaquais, SES murs rabotaient mes coups.
    const fortAgainstThem = fight.role === 'attaque' ? fight.fort.theirs || 0 : 0;
    const exclude = excludeSelf ? fight.id : null;
    const piles = fight.myPiles.map((p) => {
        const s = pileStats(p, params, { fortAgainstThem, talents });
        // Mes talents d'alors, mesurés dans mes autres combats (les cartes datent d'aujourd'hui).
        const xs = (factors?.get(`me|${p.base}`) || [])
            .filter((e) => e.fightId !== exclude && Number.isFinite(e.factor))
            .map((e) => e.factor);
        if (xs.length) {
            const f = median(xs);
            s.dmgMin *= f;
            s.dmgMax *= f;
            s.dmgAvg *= f;
            s.dmgFactor = Math.round(f * 100) / 100;
        }
        return s;
    });
    const a = army(piles, {
        slots: Math.round((fight.abNeed || Math.ceil(fight.army.mine.qty * 0.1)) * 10),
        fort: fight.role === 'défense' ? fight.fort.mine : 0,
        guard: fight.role === 'défense' ? fight.guard : 0,
        critMult,
    });
    forceAbilities(a, fight.abOn);
    return a;
}

/** Aligne l'activation des capacités sur ce que le serveur a réellement fait tourner. */
function forceAbilities(a, abOn) {
    if (!Array.isArray(abOn)) return;
    const on = new Set(abOn);
    for (const p of a.piles) p.abilityOn = Boolean(p.ability) && on.has(p.ability);
    a.abilities = [...new Set(a.piles.filter((p) => p.abilityOn).map((p) => p.ability))];
}

/* ---------- Validation : rejouer l'historique ---------- */

export function backtest(analysis, troops, { skills = null, critMult = null } = {}) {
    const params = typeParams(troops, analysis);
    const talents = skills?.bonuses || null;
    const crit = critMult ?? myCritMultiplier(skills);
    const factors = opponentFactors(analysis, params, { talents });
    const rows = [];
    for (const f of analysis.fights) {
        // leave-one-out : le combat rejoué n'alimente aucune de ses propres mesures
        const mine = myArmyFromFight(f, params, { talents, critMult: crit, factors, excludeSelf: true });
        const theirs = foeArmyFromFight(f, params, { role: f.role, factors, excludeSelf: true });
        const res = simulate(mine, theirs);
        rows.push({ id: f.id, role: f.role, actual: f.won, predicted: res.winner === 'A', margin: res.margin });
    }
    /* La marge (mode espérance) classe les combats ; son zéro n'est pas le point de bascule,
       parce que tout ce qui reste inconnu (talents adverses, renforts, dispersion) décale le
       niveau. On cale le seuil sur l'historique — un paramètre par rôle — et on publie la
       justesse obtenue avec. La CALIBRATION (marge → probabilité) vient des voisins. */
    const threshold = {
        attaque: fitThreshold(rows.filter((r) => r.role === 'attaque')),
        défense: fitThreshold(rows.filter((r) => r.role === 'défense')),
    };
    for (const r of rows) r.predicted = r.margin > threshold[r.role];

    // Probabilité par plus proches voisins de marge, et score de Brier (0 = parfait, 0,25 = pile ou face).
    for (const r of rows) {
        const others = rows.filter((x) => x !== r);
        const near = winChance(others, r.margin, { k: 15 });
        r.prob = near ? near.pct / 100 : 0.5;
    }
    const brier = rows.length
        ? rows.reduce((a, r) => a + (r.prob - (r.actual ? 1 : 0)) ** 2, 0) / rows.length
        : null;

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
        brier: brier != null ? Math.round(brier * 1000) / 1000 : null,
        baseline: round1((100 * Math.max(rows.filter((r) => r.actual).length, rows.filter((r) => !r.actual).length)) / rows.length),
        attack: byRole('attaque'),
        defense: byRole('défense'),
        talents: talents ? { applied: true, ...talents } : { applied: false },
        critMult: crit,
        // Ce qui permet de traduire une marge en « combien de fois ça passe, en vrai ».
        calibration: calibrationCurve(rows),
        rows,
    };
}

/**
 * Probabilité de gagner à une marge donnée, lue dans l'historique.
 *
 * On calibre sur les voisins : pour une marge donnée, les `k` combats de l'historique dont la
 * marge est la plus proche, et la part réellement gagnée. Estimation grossière mais honnête.
 */
export function winChance(rows, margin, { k = 15 } = {}) {
    const near = rows.slice()
        .sort((a, b) => Math.abs(a.margin - margin) - Math.abs(b.margin - margin))
        .slice(0, Math.min(k, rows.length));
    if (!near.length) return null;
    const wins = near.filter((r) => r.actual).length;
    return {
        wins,
        sample: near.length,
        pct: Math.round((100 * wins) / near.length),
        // Écart de marge couvert par l'échantillon : dit si les « voisins » le sont vraiment.
        span: [Math.min(...near.map((r) => r.margin)), Math.max(...near.map((r) => r.margin))]
            .map((x) => Math.round(x * 1000) / 1000),
    };
}

/** Courbe de calibrage complète, pour l'afficher : marge → issue réelle, par tranches. */
export function calibrationCurve(rows, bins = 6) {
    const sorted = rows.slice().sort((a, b) => a.margin - b.margin);
    const out = [];
    for (let i = 0; i < bins; i += 1) {
        const part = sorted.slice(Math.floor((i * sorted.length) / bins), Math.floor(((i + 1) * sorted.length) / bins));
        if (!part.length) continue;
        const wins = part.filter((r) => r.actual).length;
        out.push({
            from: Math.round(part[0].margin * 1000) / 1000,
            to: Math.round(part[part.length - 1].margin * 1000) / 1000,
            wins,
            fights: part.length,
            pct: Math.round((100 * wins) / part.length),
        });
    }
    return out;
}

/* Multiplicateur de critique de mon camp. Le jeu part de ×1,5 ; le talent « Executioner »
   (+50 % de dégâts critiques) le porte à ×2,0 — MESURÉ à ×1,98 dans les journaux de combat
   (médiane des rapports crit/normal d'une même pile dans un même combat). */
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
    // On classe sur l'AUC : indépendante du seuil, donc la moins sujette au sur-ajustement.
    const best = tried.slice().sort((a, b) => (b.auc ?? 0) - (a.auc ?? 0) || b.balanced - a.balanced)[0];
    return { best, tried };
}

/** Justesse équilibrée et pouvoir de classement, par rôle : où croire le modèle. */
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

/* Seuil de marge calé sur l'historique. On maximise la justesse ÉQUILIBRÉE et non la brute :
   avec beaucoup plus de défaites que de victoires en défense, « perdu à tous les coups »
   afficherait un bon score sans rien discriminer. */
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
export function recommend({ analysis, troops, slots, maxTypes = 4, keep = 8, threshold = {}, readiness = {}, critMult = 1.5, monteCarlo = 48 }) {
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

    /* Les finalistes passent au Monte-Carlo : la vraie part de victoires attendue, tirages
       compris, contre chaque combat de l'historique. C'est plus lent (on ne le fait que pour
       le podium) mais c'est la probabilité, pas un classement. */
    const kept = finalists.slice(0, keep).map((f) => ({
        ...f,
        pWin: monteCarlo > 0 ? mcScore(f.piles, scenarios, slots, opts, monteCarlo) : null,
    }));

    const current = currentComposition(troops, params, slots);
    return {
        empty: false,
        slots,
        maxTypes,
        need: Math.ceil(slots * 0.1),
        scenarios: scenarios.length,
        screened: candidates.length,
        best: kept.map((f) => describe(f, slots, scenarios.length, critMult)),
        current: current ? describe({
            piles: current,
            score: score(current, scenarios, slots, opts),
            pWin: monteCarlo > 0 ? mcScore(current, scenarios, slots, opts, monteCarlo) : null,
        }, slots, scenarios.length, critMult) : null,
        pool: scenarios.map((s) => ({ name: s.name, role: s.role, hp: s.army.maxHp, weight: s.weight })),
    };
}

/**
 * La meilleure composition contre UN combat précis — même adversaire, même rôle, mêmes murs,
 * même forme de troupes. Trois temps : criblage en espérances (toutes les combinaisons de types
 * par dixièmes de places), affinage par déplacements d'unités, puis Monte-Carlo des finalistes
 * pour classer sur la vraie probabilité de victoire, tirages compris.
 */
export function bestAgainstFight({
    analysis, troops, fight, slots, maxTypes = 4, readiness = 1, critMult = 1.5,
    skills = null, keep = 3, runs = 240,
}) {
    const params = typeParams(troops, analysis);
    const usable = [...params.values()].filter((t) => t.dmgAvg > 0 && t.unitHp > 0);
    if (!usable.length) return { empty: true, reason: 'Aucune fiche de troupe chiffrée : lance « Relever les troupes ».' };

    const factors = opponentFactors(analysis, params, { talents: skills?.bonuses || null });
    const role = fight.role;
    const scenario = {
        id: fight.id,
        role,
        weight: 1,
        army: foeArmyFromFight(fight, params, { role, factors }),
        myFort: role === 'défense' ? fight.fort.mine : 0,
        myGuard: role === 'défense' ? fight.guard : 0,
    };
    const opts = {
        threshold: {},
        readiness: { attack: readiness, defense: readiness },
        critMult,
    };

    const candidates = [];
    for (const combo of combinations(usable, maxTypes)) {
        for (const split of tenths(combo.length)) {
            const piles = combo.map((t, i) => ({ ...t, qty: Math.floor((slots * split[i]) / 10) }));
            const rest = slots - piles.reduce((a, p) => a + p.qty, 0);
            if (rest > 0) piles[piles.length - 1].qty += rest;
            candidates.push(piles);
        }
    }

    const scored = candidates.map((piles) => ({ piles, score: score(piles, [scenario], slots, opts) }));
    scored.sort((a, b) => b.score.margin - a.score.margin);

    // L'affinage fait souvent converger plusieurs candidats vers la même composition : on
    // déduplique avant le Monte-Carlo, pour ne pas payer deux fois ni afficher deux fois.
    const seen = new Set();
    const finalists = scored.slice(0, 12)
        .map((f) => refine(f, [scenario], slots, opts))
        .filter((f) => {
            const sig = f.piles.map((p) => `${p.key}:${p.qty}`).sort().join('|');
            if (seen.has(sig)) return false;
            seen.add(sig);
            return true;
        })
        .map((f) => ({ ...f, pWin: mcScore(f.piles, [scenario], slots, opts, runs) }))
        .sort((a, b) => (b.pWin ?? 0) - (a.pWin ?? 0) || b.score.margin - a.score.margin);

    /* Les deux références : ce que j'avais engagé ce jour-là (PV réels d'alors), et ma composition
       actuelle. C'est l'écart avec elles qui dit si le détour vaut le coup. */
    const mkMine = (piles) => army(piles, {
        slots, fort: scenario.myFort, guard: scenario.myGuard, readiness, critMult,
    });
    const historicArmy = myArmyFromFight(fight, params, {
        talents: skills?.bonuses || null, critMult, factors,
    });
    const mcOf = (a) => {
        const mc = simulateMany(a, scenario.army, { runs: Math.max(runs, 300), seed: fight.id });
        return { pWin: Math.round(mc.pWin * 1000) / 10, margin: Math.round(mc.margin.p50 * 1000) / 1000 };
    };
    const current = currentComposition(troops, params, slots);

    return {
        empty: false,
        fightId: fight.id,
        role,
        readiness: Math.round(readiness * 100) / 100,
        fort: scenario.myFort,
        foeFort: role === 'attaque' ? fight.fort.theirs : 0,
        guard: scenario.myGuard,
        slots,
        maxTypes,
        need: Math.ceil(slots * 0.1),
        screened: candidates.length,
        runs,
        best: finalists.slice(0, keep).map((f) => describe(f, slots, 1, critMult)),
        historic: {
            ...mcOf(historicArmy),
            types: fight.myPiles.filter((p) => !p.reinforcement)
                .map((p) => ({ key: p.base, fr: params.get(p.base)?.fr || p.base, qty: p.qty })),
        },
        current: current ? { ...describe({ piles: current, score: score(current, [scenario], slots, opts) }, slots, 1, critMult), ...mcOf(mkMine(current)) } : null,
        actual: { won: fight.won },
    };
}

/**
 * Que forger en priorité ? Pour chaque type de ta composition actuelle et chaque pièce
 * remplaçable, on rejoue TOUT l'historique avec la pièce candidate (affixes = médiane des bornes
 * observées, bonus intrinsèque estimé de l'arsenal) et on classe par gain de marge moyenne ;
 * le podium est départagé au Monte-Carlo. Seules les pièces à estimation solide concourent.
 */
export function forgeRanking({ analysis, troops, skills, arsenal, slots, readiness = {}, critMult = 1.5, keep = 10, mcRuns = 24 }) {
    const params = typeParams(troops, analysis);
    const current = currentComposition(troops, params, slots);
    if (!current) return { empty: true, reason: 'Aucune troupe possédée : lance « Mettre à jour ».' };
    const scenarios = buildScenarios(analysis, params);
    if (!scenarios.length) return { empty: true, reason: 'Aucun combat en base.' };
    const loads = currentLoadouts(analysis);
    const talents = skills?.bonuses || null;
    const opts = { threshold: {}, readiness, critMult };

    const base = score(current, scenarios, slots, opts);
    const basePWin = mcScore(current, scenarios, slots, opts, mcRuns);

    const medianAffixes = (bounds) => Object.fromEntries(Object.entries(bounds || {})
        .map(([stat, b]) => [stat, Math.round(((b.min + b.max) / 2) * 10) / 10]));

    const candidates = [];
    for (const p of current) {
        const cur = loads[p.key];
        if (!cur) continue;
        for (const slot of ['weapon', 'armor', 'charm']) {
            const curPiece = cur.find((g) => g.slot === slot) || null;
            for (const it of arsenal.items.filter((i) => i.slot === slot)) {
                for (const r of it.rarities) {
                    if (curPiece && curPiece.item === it.item && curPiece.rarity === r.rarity) continue;
                    const affixes = medianAffixes(r.affixes);
                    const hasAffix = Object.keys(affixes).length > 0;
                    // armes et protections : il faut une estimation solide du bonus caché ;
                    // porte-bonheur : seuls les affixes comptent (bonus propre non isolable).
                    if (slot !== 'charm' && !r.intrinsic.solid) continue;
                    if (slot === 'charm' && !hasAffix) continue;
                    const piece = { slot, item: it.item, name: it.name, rarity: r.rarity, rarityFr: r.fr, affixes };
                    const newLoad = curPiece
                        ? cur.map((g) => (g.slot === slot ? piece : g))
                        : [...cur, piece];
                    candidates.push({ type: p.key, fr: p.fr, slot, piece, newLoad, from: curPiece });
                }
            }
        }
    }

    const armyOf = (c) => current.map((p) => (p.key === c.type
        ? { ...applyLoadout(p, c.newLoad, { talents, arsenal, current: loads[c.type] }), qty: p.qty }
        : p));
    for (const c of candidates) {
        c.margin = score(armyOf(c), scenarios, slots, opts).margin;
        c.delta = c.margin - base.margin;
    }
    candidates.sort((a, b) => b.delta - a.delta);

    const top = candidates.slice(0, keep).map((c) => ({
        type: c.type,
        fr: c.fr,
        slot: c.slot,
        slotFr: c.piece.slot === 'weapon' ? 'Arme' : c.piece.slot === 'armor' ? 'Protection' : 'Porte-bonheur',
        from: c.from ? { item: c.from.item, name: c.from.name, rarity: c.from.rarity, rarityFr: c.from.rarityFr } : null,
        to: c.piece,
        deltaMargin: Math.round(c.delta * 1000) / 1000,
        pWin: mcScore(armyOf(c), scenarios, slots, opts, mcRuns),
    }));

    return {
        empty: false,
        fights: scenarios.length,
        candidates: candidates.length,
        base: { margin: Math.round(base.margin * 1000) / 1000, pWin: basePWin },
        top,
        note: 'affixes pris à la médiane des bornes observées (la forge les tire au sort) ; bonus '
            + 'intrinsèques estimés par recoupement — un gain faible est dans la marge d’erreur.',
    };
}

/** Chaque combat de l'historique devient un scénario : même adversaire, même rôle, même fortif. */
function buildScenarios(analysis, params) {
    const factors = opponentFactors(analysis, params);
    const out = analysis.fights.map((f) => ({
        id: f.id,
        name: `${f.opponent.name} (${f.role})`,
        role: f.role,
        weight: 1,
        army: foeArmyFromFight(f, params, { role: f.role, factors }),
        myFort: f.role === 'défense' ? f.fort.mine : 0,
        myGuard: f.role === 'défense' ? f.guard : 0,
        representative: false,
    }));
    // Échantillon de criblage : les extrêmes et quartiles de taille d'armée, des deux rôles.
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

/** Part de victoires Monte-Carlo d'une compo contre tout l'historique (tirages réels). */
function mcScore(piles, scenarios, slots, { readiness = {}, critMult = 1.5 } = {}, runs = 48) {
    let wins = 0;
    let total = 0;
    for (const s of scenarios) {
        const ready = s.role === 'défense' ? (readiness.defense ?? 1) : (readiness.attack ?? 1);
        const mine = army(piles, { slots, fort: s.myFort, guard: s.myGuard, readiness: ready, critMult });
        const mc = simulateMany(mine, s.army, { runs, seed: 1 + (s.id || 0) });
        wins += mc.wins;
        total += mc.runs;
    }
    return total ? Math.round((1000 * wins) / total) / 10 : null;
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

function describe({ piles, score: s, pWin = null }, slots, nScenarios, critMult = 1.5) {
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
        // La part de victoires au Monte-Carlo : tirages réels, pas un classement déterministe.
        pWin,
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
