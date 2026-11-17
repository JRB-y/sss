import { config } from './config.mjs';
import { log, readJson, writeJson, writeText } from './util.mjs';
import { ROSTER } from './troops.mjs';
import { ABILITY_FR, ROLE_FR } from './analyse.mjs';
import { readGear, gearSignature, gearBonuses, gearLabel, buildItemCatalog, renderItemsDoc, AFFIXES } from './gear.mjs';

/* Fiches d'adversaires et historique de leurs troupes.

   Aucune requête réseau ici : tout est déjà dans `data/fights.json`. Un rapport de combat donne
   l'armée **complète** des deux camps — type, quantité, PV unitaires, niveau de type, rôle,
   capacité et les trois pièces d'équipement de chaque pile — plus la frise des coups, qui permet
   de *mesurer* la cadence et les dégâts par unité de chaque pile adverse.

   `data/enemies.json` est donc une **projection** de `data/fights.json`, pas un second journal :
   on la reconstruit intégralement à chaque passage, dans l'ordre chronologique. C'est ce qui la
   rend réparable (un bug de lecture se corrige en relançant la commande) et idempotente (deux
   passages de suite donnent le même fichier). Les combats, eux, continuent d'accumuler.

   Deux granularités cohabitent, et elles ne servent pas à la même chose :
   — `observations` : une entrée par combat, l'armée telle qu'elle était ce jour-là. Rien n'est
     perdu, c'est la matière première ;
   — `changes` : seulement les combats où l'adversaire a **changé de troupes** (type ajouté ou
     retiré, équipement remplacé, niveau de type gagné, PV unitaires déplacés). C'est la lecture
     utile : « King Ramirez est passé de l'AK-47 aux poings américains le 16 novembre ». */

const STORE_VERSION = 1;

export async function syncEnemies({ quiet = false } = {}) {
    if (!quiet) log.title('Adversaires et équipements');

    const fights = await readJson(config.paths.fights);
    if (!fights || !Object.keys(fights.fights || {}).length) {
        throw new Error('Aucun combat en base : lance « Récupérer les combats » d’abord.');
    }
    const troops = await readJson(config.paths.troops);

    const store = buildEnemies(fights, troops);
    await writeJson(config.paths.enemies, store);
    const foes = Object.values(store.players).filter((p) => !p.isMe);
    log.pass(`${foes.length} adversaire(s), ${store.counts.observations} relevé(s) d’armée, `
        + `${store.counts.changes} changement(s) de troupes → ${rel(config.paths.enemies)}`);

    const catalog = buildItemCatalog(fights, { meId: store.account.id });
    await writeJson(config.paths.items, catalog);
    await writeText(`${config.paths.docs}/objets.md`, renderItemsDoc(catalog));
    log.pass(`${catalog.counts.items} objets catalogués → ${rel(config.paths.items)} + docs/objets.md`);

    return {
        enemies: foes.length,
        observations: store.counts.observations,
        changes: store.counts.changes,
        items: catalog.counts.items,
    };
}

/* ---------- Projection ---------- */

export function buildEnemies(fights, troops) {
    const meId = guessMyId(fights);
    const entries = Object.values(fights.fights || {})
        .filter((e) => e.detail?.fight?.report)
        .sort((a, b) => at(a) - at(b)); // l'historique ne se lit que dans l'ordre

    const players = new Map();
    const touch = (side, report) => {
        const p = players.get(side.id) || blankPlayer(side, side.id === meId);
        if (side.name && !p.aka.includes(side.name)) p.aka.push(side.name);
        p.name = side.name || p.name;
        p.avatar = side.avatar || p.avatar;
        p.lastSeenAt = report.at || p.lastSeenAt;
        p.firstSeenAt = p.firstSeenAt ?? report.at;
        players.set(side.id, p);
        return p;
    };

    for (const entry of entries) {
        const report = entry.detail.fight.report;
        const mineSide = report.att.id === meId ? 'att' : 'def';
        const measured = measurePiles(report);

        for (const side of ['att', 'def']) {
            const p = touch(report[side], report);
            const theirRole = side === 'att' ? 'attaquant' : 'défenseur';
            const iWon = report.result?.winner === mineSide;

            p.record.fights += 1;
            if (side === 'att') p.record.asAttacker += 1; else p.record.asDefender += 1;
            if (p.isMe) {
                if (iWon) p.record.wins += 1; else p.record.losses += 1;
            } else if (iWon) p.record.myWins += 1; else p.record.myLosses += 1;

            pushHistory(p.level, report.at, report[side].level);
            pushHistory(p.rating, report.at, ratingOf(report, side));
            // La fortification ne se lit qu'en défense : on garde la précédente valeur *défensive*
            // pour pouvoir annoncer un vrai changement de murs, pas un changement de rôle.
            const prevFort = p.fort.last;
            if (side === 'def') pushHistory(p.fort, report.at, report[side].fort || 0);

            const obs = observe({
                report, side, meId, mineSide, theirRole, iWon, measured, troops,
                fightId: entry.id ?? report.id ?? null,
            });
            const previous = p.observations[p.observations.length - 1] || null;
            obs.diff = previous
                ? diffObservations(previous, obs, { prevFort })
                : { first: true, kinds: ['premier relevé'], lines: [] };
            p.observations.push(obs);
            if (obs.diff.kinds.length && !obs.diff.first) {
                p.changes.push({
                    at: obs.at, fightId: obs.fightId, kinds: obs.diff.kinds, lines: obs.diff.lines,
                    sinceAt: previous.at, sinceFightId: previous.fightId,
                });
            }
        }
    }

    const out = {};
    for (const p of [...players.values()].sort((a, b) => b.record.fights - a.record.fights)) {
        p.latest = p.observations[p.observations.length - 1] || null;
        p.span = { from: p.firstSeenAt, to: p.lastSeenAt };
        out[p.id] = p;
    }
    const all = Object.values(out);

    return {
        version: STORE_VERSION,
        updatedAt: new Date().toISOString(),
        account: { id: meId, name: fights.account || players.get(meId)?.name || null },
        source: {
            fights: entries.length,
            from: entries.length ? at(entries[0]) : null,
            to: entries.length ? at(entries[entries.length - 1]) : null,
            fightsUpdatedAt: fights.updatedAt || null,
        },
        counts: {
            players: all.length,
            enemies: all.filter((p) => !p.isMe).length,
            observations: all.reduce((a, p) => a + p.observations.length, 0),
            changes: all.reduce((a, p) => a + p.changes.length, 0),
        },
        players: out,
    };
}

function blankPlayer(side, isMe) {
    return {
        id: side.id,
        name: side.name || null,
        aka: [],
        avatar: side.avatar || null,
        isMe,
        firstSeenAt: null,
        lastSeenAt: null,
        level: emptyHistory(),
        rating: emptyHistory(),
        fort: emptyHistory(),
        record: { fights: 0, asAttacker: 0, asDefender: 0, myWins: 0, myLosses: 0, wins: 0, losses: 0 },
        observations: [],
        changes: [],
    };
}

const emptyHistory = () => ({ first: null, last: null, min: null, max: null, history: [] });

/** Une valeur n'entre dans l'historique que quand elle change : sinon on ne garde que les bornes. */
function pushHistory(h, at_, value) {
    if (!Number.isFinite(value)) return;
    if (h.first == null) h.first = value;
    h.min = h.min == null ? value : Math.min(h.min, value);
    h.max = h.max == null ? value : Math.max(h.max, value);
    if (h.last !== value) h.history.push({ at: at_, value });
    h.last = value;
}

/** Points de classement du camp, tels que le rapport les donne après le combat. */
function ratingOf(report, side) {
    const r = report.result?.rating;
    if (!r) return null;
    return side === 'att' ? r.attacker ?? null : r.defender ?? null;
}

/* ---------- Un relevé d'armée ---------- */

function observe({ report, side, meId, mineSide, theirRole, iWon, measured, troops, fightId }) {
    const all = (report[side].piles || []).map((p) => readPile(p, measured[side][p.key], troops));
    const own = all.filter((p) => !p.owner);
    const reinforcements = all.filter((p) => p.owner);
    const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);

    return {
        fightId: Number(fightId) || null,
        at: report.at || null,
        side,
        theirRole,
        // Rôle vu depuis mon compte : ce combat, l'ai-je attaqué ou m'a-t-il attaqué ?
        vsMe: report[side].id === meId ? null : (mineSide === 'att' ? 'je l’ai attaqué' : 'il m’a attaqué'),
        iWon,
        level: report[side].level ?? null,
        fort: report[side].fort || 0,
        guard: side === mineSide ? (report.result?.guard || 0) : 0,
        abNeed: report.abNeed?.[side] ?? null,
        abOn: report.abOn?.[side] || [],
        army: {
            types: own.length,
            qty: sum(own, (p) => p.qty),
            maxHp: sum(own, (p) => p.maxHp),
            startHp: sum(own, (p) => p.hp),
            readiness: ratio(sum(own, (p) => p.hp), sum(own, (p) => p.maxHp)),
            dealt: sum(all, (p) => p.measured.dealt),
        },
        piles: own,
        reinforcements,
        sig: armySignature(own),
        gearSig: own.map((p) => `${p.base}=${p.gearSig}`).sort().join('|'),
    };
}

function readPile(p, m, troops) {
    const base = String(p.key || '').replace(/@.*/, '');
    const gear = readGear(p.gear);
    return {
        key: p.key,
        base,
        name: p.name || base,
        fr: frName(base, troops),
        owner: p.owner || null,
        qty: p.qty || 0,
        unitHp: p.unitHp || 0,
        hp: p.hp || 0,
        maxHp: p.max || (p.qty || 0) * (p.unitHp || 0),
        typeLevel: p.level ?? null,
        role: p.role || null,
        roleFr: ROLE_FR[p.role] || p.role || null,
        ability: p.ability || null,
        abilityFr: ABILITY_FR[p.ability] || p.abilityName || p.ability || null,
        gear,
        gearSig: gearSignature(gear),
        gearBonuses: gearBonuses(gear),
        // Mesuré dans la frise des coups : c'est la seule fenêtre honnête sur ce que l'équipement
        // d'en face vaut vraiment (les bonus intrinsèques des objets n'étant pas publiés).
        measured: m || { hits: 0, dealt: 0, taken: 0, dpuPerHit: null, intervalS: null },
    };
}

/* Dégâts, coups portés et cadence de chaque pile, lus dans `report.events`.
   Un événement : [t, camp, typeAttaquant, typeCible, dégâts, unitésVivantes, riposte]. */
function measurePiles(report) {
    const out = { att: {}, def: {} };
    const cs = report.result?.cs || 0;
    const qty = {
        att: new Map((report.att.piles || []).map((p) => [p.key, p.qty])),
        def: new Map((report.def.piles || []).map((p) => [p.key, p.qty])),
    };
    const dpu = { att: new Map(), def: new Map() };

    const slot = (sideKey, key) => {
        const s = out[sideKey];
        s[key] ||= { hits: 0, dealt: 0, taken: 0, dpuPerHit: null, intervalS: null };
        return s[key];
    };

    for (const [, sideIdx, from, to, dmg, alive, counter] of report.events || []) {
        const me = sideIdx === 0 ? 'att' : 'def';
        const foe = sideIdx === 0 ? 'def' : 'att';
        const mine = slot(me, from);
        const theirs = slot(foe, to);
        mine.hits += 1;
        mine.dealt += dmg || 0;
        theirs.taken += dmg || 0;
        const n = alive || qty[me].get(from) || 0;
        if (n > 0 && dmg) {
            const list = dpu[me].get(from) || [];
            list.push(dmg / n);
            dpu[me].set(from, list);
        }
        if (counter) {
            // La riposte est portée par la cible et encaissée par l'attaquant.
            theirs.dealt += counter;
            mine.taken += counter;
        }
    }

    for (const side of ['att', 'def']) {
        for (const [key, s] of Object.entries(out[side])) {
            const xs = (dpu[side].get(key) || []).sort((a, b) => a - b);
            s.dpuPerHit = xs.length ? round(xs[xs.length >> 1], 1) : null;
            // Cadence : durée du combat ÷ nombre de coups portés. Approchée dès que la pile tombe
            // avant la fin, donc on exige quelques coups avant d'y croire.
            s.intervalS = s.hits >= 3 && cs ? round(cs / s.hits / 100, 3) : null;
            s.dealt = Math.round(s.dealt);
            s.taken = Math.round(s.taken);
        }
    }
    return out;
}

/* ---------- Empreintes et différences ---------- */

/* L'empreinte d'une armée ne retient que ce qui relève d'un choix du joueur ou de sa progression :
   les types engagés, leur quantité, leur niveau de type, leurs PV unitaires et leur équipement.
   Les PV restants (une pile qui n'a pas fini de récupérer) n'en font pas partie. */
function armySignature(piles) {
    return piles.map((p) => `${p.base}×${p.qty}@${p.unitHp}/lv${p.typeLevel}[${p.gearSig}]`)
        .sort().join('|');
}

function diffObservations(before, after, { prevFort = null } = {}) {
    const kinds = new Set();
    const lines = [];
    const byBase = (obs) => new Map(obs.piles.map((p) => [p.base, p]));
    const a = byBase(before);
    const b = byBase(after);

    for (const [base, p] of b) {
        if (a.has(base)) continue;
        kinds.add('type ajouté');
        lines.push(`+ ${p.fr} ×${fr(p.qty)} — nouveau type engagé (${p.roleFr || '?'}, ${p.abilityFr || 'sans capacité'})`);
    }
    for (const [base, p] of a) {
        if (b.has(base)) continue;
        kinds.add('type retiré');
        lines.push(`− ${p.fr} — plus engagé (il en avait ${fr(p.qty)})`);
    }

    for (const [base, after_] of b) {
        const before_ = a.get(base);
        if (!before_) continue;

        if (before_.qty !== after_.qty) {
            kinds.add('quantité');
            const d = after_.qty - before_.qty;
            lines.push(`${after_.fr} : ${fr(before_.qty)} → ${fr(after_.qty)} unités (${d > 0 ? '+' : ''}${fr(d)})`);
        }
        const levels = Number.isFinite(before_.typeLevel) && Number.isFinite(after_.typeLevel)
            ? after_.typeLevel - before_.typeLevel : 0;
        if (levels) {
            kinds.add('niveau de type');
            lines.push(`${after_.fr} : niveau de type ${before_.typeLevel} → ${after_.typeLevel}`
                + ` (${pct(1.02 ** levels - 1)} de vie et de dégâts)`);
        }
        if (before_.gearSig !== after_.gearSig) {
            kinds.add('équipement');
            for (const line of diffGear(before_, after_)) lines.push(`${after_.fr} · ${line}`);
        } else if (before_.unitHp !== after_.unitHp) {
            /* Même matériel, d'autres PV. Le niveau de type en explique déjà +2 % par palier : on
               ne signale que le reste, c'est-à-dire l'arbre de talents ou un bonus de famille. */
            const expected = before_.unitHp * 1.02 ** levels;
            const residual = after_.unitHp / (expected || after_.unitHp) - 1;
            if (Math.abs(residual) >= 0.01) {
                kinds.add('PV unitaires');
                lines.push(`${after_.fr} : ${fr(before_.unitHp)} → ${fr(after_.unitHp)} PV par unité à équipement identique`
                    + `${levels ? `, soit ${pct(residual)} au-delà du niveau de type` : ''}`
                    + ' — arbre de talents ou bonus de famille');
            }
        }
    }

    // La fortification n'existe qu'en défense : on la compare au dernier combat où il défendait.
    if (after.side === 'def' && prevFort != null && prevFort !== after.fort) {
        kinds.add('fortifications');
        lines.push(`Fortifications : ${prevFort} % → ${after.fort} % de dégâts encaissés en moins`);
    }

    return { first: false, kinds: [...kinds], lines };
}

function diffGear(before, after) {
    const lines = [];
    const slots = new Set([...before.gear.map((g) => g.slot), ...after.gear.map((g) => g.slot)]);
    for (const slot of slots) {
        const x = before.gear.find((g) => g.slot === slot);
        const y = after.gear.find((g) => g.slot === slot);
        const sx = x ? gearLabel(x) : 'rien';
        const sy = y ? gearLabel(y) : 'rien';
        if (sx === sy) continue;
        lines.push(`${(y || x).slotFr.toLowerCase()} : ${sx} → ${sy}`);
    }
    return lines;
}

/* ---------- Utilitaires ---------- */

/** Le compte, c'est l'identité présente dans tous les combats (attaque comme défense). */
function guessMyId(fights) {
    const tally = new Map();
    for (const entry of Object.values(fights.fights || {})) {
        const r = entry.detail?.fight?.report;
        if (!r) continue;
        for (const side of ['att', 'def']) tally.set(r[side].id, (tally.get(r[side].id) || 0) + 1);
    }
    return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const at = (entry) => entry.detail?.fight?.report?.at || entry.summary?.at || 0;
const frName = (base, troops) => troops?.units?.[`troops/${base}`]?.fr
    || ROSTER.find((r) => r.key === base)?.fr
    || troops?.units?.[`troops/${base}`]?.name
    || base;
const fr = (n) => (Number.isFinite(n) ? n.toLocaleString('fr-FR') : String(n ?? '—'));
/** « +4,8 % » — un écart relatif, signé. */
const pct = (x) => `${x > 0 ? '+' : ''}${(Math.round(x * 1000) / 10).toLocaleString('fr-FR')} %`;
const ratio = (a, b) => (b ? Math.round((1000 * a) / b) / 1000 : null);
const round = (n, d = 0) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const rel = (p) => p.replace(`${config.root}/`, '');

export { AFFIXES };
