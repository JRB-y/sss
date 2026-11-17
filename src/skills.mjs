import { config } from './config.mjs';
import { log, readJson, writeJson, writeText } from './util.mjs';

/* Arbre de talents du personnage — GET /play/view/skills.

   C'est la pièce qui manquait pour décomposer proprement une stat. Les « stats réelles » d'une
   carte du shop valent :

       réel = (base_du_type_à_son_niveau + bonus_plats) × (1 + talents% + objets%)

   Sans l'arbre, talents et objets étaient confondus dans un seul écart inexplicable. La vue les
   sépare : chaque nœud donne son effet exact (`+1% damage`, `+6 damage per hit`, `+1 pts crit`…)
   et les points qu'on y a mis.

   Vérifié sur ce compte : la branche Défense est à 0 point, donc **les talents n'apportent aucun
   bonus de vie** — et de fait, les deux types que je n'équipe pas (Junkie, Voyou) ont des PV
   réels exactement égaux à leurs PV de base. Tout l'écart des autres types est donc imputable à
   leur équipement, bonus intrinsèque des objets compris. C'est ce qui rend ce dernier mesurable.

   Même vérification côté dégâts : pour un type sans équipement, `(base + plats) × (1 + %)` tombe
   à 1 % près sur la valeur servie par le jeu. */

const STORE_VERSION = 1;

/* Effets rencontrés dans `ul.tree-fx`. `stat` est la clé interne, `flat` dit si le bonus s'ajoute
   avant le pourcentage, `combat` s'il entre dans le simulateur. Les libellés sont servis dans la
   langue du compte : on reconnaît sur un motif, pas sur une traduction. */
const EFFECTS = [
    { re: /^\+?([\d.]+)%\s*damage$/i, stat: 'dmgPct', combat: true, fr: 'dégâts' },
    { re: /^\+?([\d.]+)\s*damage per hit$/i, stat: 'dmgFlat', combat: true, flat: true, fr: 'dégâts par coup' },
    { re: /^\+?([\d.]+)\s*pts? crit$/i, stat: 'critPts', combat: true, flat: true, fr: 'points de critique' },
    { re: /^\+?([\d.]+)%\s*critical damage$/i, stat: 'critDmgPct', combat: true, fr: 'dégâts critiques' },
    { re: /^\+?([\d.]+)%\s*attack speed$/i, stat: 'speedPct', combat: true, fr: 'vitesse d’attaque' },
    { re: /^\+?([\d.]+)%\s*health$/i, stat: 'hpPct', combat: true, fr: 'vie' },
    { re: /^\+?([\d.]+)%\s*counterattack strength$/i, stat: 'counterPct', combat: true, fr: 'force de riposte' },
    { re: /^\+?([\d.]+)\s*pts? riposte$/i, stat: 'counterPts', combat: true, flat: true, fr: 'points de riposte' },
    { re: /^\+?([\d.]+)\s*health per unit$/i, stat: 'hpFlat', combat: true, flat: true, fr: 'vie par unité' },
    // Le jeu écrit la réduction avec un vrai signe moins (U+2212), pas un trait d'union.
    { re: /^[-−]([\d.]+)%\s*damage taken$/i, stat: 'takenPct', combat: true, fr: 'dégâts subis' },
    { re: /^\+?([\d.]+)%\s*recovery$/i, stat: 'recoveryPct', fr: 'récupération' },
    { re: /^[-−]([\d.]+)%\s*travel time$/i, stat: 'travelPct', fr: 'temps de trajet' },
    { re: /^[-−]([\d.]+)%\s*arrest time$/i, stat: 'arrestTimePct', fr: 'temps d’arrestation' },
    { re: /^Arrest risk reduced by ([\d.]+)%/i, stat: 'arrestRiskPct', fr: 'risque d’arrestation' },
    { re: /^\+?([\d.]+)%\s*troop XP$/i, stat: 'troopXpPct', fr: 'XP de troupe' },
    { re: /^\+?([\d.]+)%\s*fight XP$/i, stat: 'fightXpPct', fr: 'XP de combat' },
    { re: /^\+?([\d.]+)%\s*loot$/i, stat: 'lootPct', fr: 'butin' },
    { re: /^\+?([\d.]+)%\s*production.*$/i, stat: 'productionPct', fr: 'production' },
    { re: /^\+?([\d.]+)%\s*carrying capacity$/i, stat: 'carryPct', fr: 'capacité de transport' },
];

const BRANCHES = { off: 'Offense', def: 'Défense', eco: 'Économie' };

export async function syncSkills(session, { keepRaw = false } = {}) {
    log.title('Arbre de talents');

    const html = await session.view('skills');
    if (keepRaw) await writeText(`${config.paths.raw}/view-skills.html`, html);

    const previous = await readJson(config.paths.skills);
    const store = parseSkills(html);
    store.version = STORE_VERSION;
    store.updatedAt = new Date().toISOString();
    store.account = session.boot?.player?.name || null;
    store.firstSeenAt = previous?.firstSeenAt || store.updatedAt;
    // Historique des répartitions : un talent se remet à zéro contre des gemmes, ça se suit.
    store.history = [...(previous?.history || [])];
    const signature = store.nodes.filter((n) => n.points > 0).map((n) => `${n.key}:${n.points}`).join('|');
    if (store.history[store.history.length - 1]?.signature !== signature) {
        store.history.push({ at: store.updatedAt, charLevel: store.char.level, spent: store.spent, signature });
    }
    store.history = store.history.slice(-50);

    await writeJson(config.paths.skills, store);

    const b = store.bonuses;
    log.pass(`${store.spent} point(s) dépensés sur ${store.nodes.filter((n) => n.points > 0).length} talents `
        + `→ ${rel(config.paths.skills)}`);
    log.info(`en combat : +${b.dmgPct} % de dégâts, +${b.dmgFlat} dégâts par coup, +${b.critPts} pts de critique, `
        + `+${b.speedPct} % de vitesse, +${b.hpPct} % de vie, +${b.critDmgPct} % de dégâts critiques`);
    if (!b.hpPct) {
        log.dim('aucun bonus de vie venant des talents : tout l’écart de PV d’un type vient donc de son équipement.');
    }
    if (store.toSpend) log.warn(`${store.toSpend} point(s) de talent non dépensé(s).`);

    return { spent: store.spent, toSpend: store.toSpend, nodes: store.nodes.length, bonuses: b };
}

/* ---------- Lecture ---------- */

export function parseSkills(html) {
    const nodes = [];

    /* Chaque nœud a un bouton (points et nom) et un panneau `div.tree-detail[data-detail=clé]`
       qui porte son effet exact. On lit les deux, le panneau faisant foi pour l'effet. */
    for (const m of html.matchAll(/<button[^>]*class="tree-node ([^"]*)"[^>]*data-node="([a-z_]+)"[^>]*data-req="([^"]*)"[^>]*aria-label="([^"]*)"([\s\S]*?)<\/button>/g)) {
        const [, classes, key, req, label, inner] = m;
        const pts = /tree-pts">([^<]*)</.exec(inner)?.[1] || '';
        const [spent, max] = pts.split('/').map((s) => s.trim());
        nodes.push({
            key,
            branch: key.split('_')[0],
            branchFr: BRANCHES[key.split('_')[0]] || key.split('_')[0],
            name: decode(label),
            points: Number(spent) || 0,
            max: /^\d+$/.test(max) ? Number(max) : null, // « ∞ » pour les talents sans plafond
            unlimited: !/^\d+$/.test(max),
            requires: req ? req.split(/\s+/).filter(Boolean) : [],
            unlocked: /is-on\b/.test(classes),
            maxed: /is-max\b/.test(classes),
            rare: /t-rare\b/.test(classes),
            effects: [],
            locked: null,
        });
    }

    const byKey = new Map(nodes.map((n) => [n.key, n]));
    /* Le panneau contient lui-même des `div.tree-detail-main` / `-head` : on exige donc une
       espace ou un guillemet après « tree-detail » pour ne pas s'arrêter sur un enfant. */
    for (const m of html.matchAll(/<div class="tree-detail[ "][^>]*data-detail="([a-z_]+)"([\s\S]*?)(?=<div class="tree-detail[ "]|<\/section>|$)/g)) {
        const node = byKey.get(m[1]);
        if (!node) continue;
        const panel = m[2];
        const type = text(grab(panel, /<p class="tree-detail-type">([\s\S]*?)<\/p>/));
        node.kind = /rare/i.test(type) ? 'rare' : 'bonus';
        for (const li of panel.matchAll(/<li><b>([\s\S]*?)<\/b>\s*(?:<small>([\s\S]*?)<\/small>)?/g)) {
            const raw = text(li[1]);
            const perPoint = Boolean(li[2] && /point/i.test(text(li[2])));
            const hit = EFFECTS.find((e) => e.re.test(raw));
            node.effects.push({
                raw,
                perPoint,
                stat: hit?.stat || null,
                fr: hit?.fr || null,
                flat: Boolean(hit?.flat),
                combat: Boolean(hit?.combat),
                value: hit ? Number(hit.re.exec(raw)[1]) : null,
            });
        }
        // Un nœud encore fermé explique pourquoi (niveau requis, points de branche manquants).
        const why = text(grab(panel, /<p class="tree-req[^"]*">([\s\S]*?)<\/p>/));
        if (why) node.locked = why;
    }

    const char = {
        level: num(grab(html, /<span class="skill-xp-lv">[^<]*?(\d+)\s*<\/span>/)),
        xp: num(grab(html, /<span>([\d,.\s  ]+)\s*\/\s*[\d,.\s  ]+\s*XP<\/span>/)),
        xpNext: num(grab(html, /<span>[\d,.\s  ]+\s*\/\s*([\d,.\s  ]+)\s*XP<\/span>/)),
    };
    char.xpPct = char.xp && char.xpNext ? Math.round((1000 * char.xp) / char.xpNext) / 10 : null;

    const spentPerBranch = {};
    for (const n of nodes) spentPerBranch[n.branch] = (spentPerBranch[n.branch] || 0) + n.points;

    return {
        char,
        toSpend: num(grab(html, /(\d+)\s*point\(s\) to spend/i)) || 0,
        resetCost: text(grab(html, /<span class="skill-reset-cost">([\s\S]*?)<\/span>/)) || null,
        spent: nodes.reduce((a, n) => a + n.points, 0),
        spentPerBranch,
        nodes,
        bonuses: totalBonuses(nodes),
    };
}

/** Somme des effets de combat réellement achetés : c'est ce que le simulateur doit appliquer. */
export function totalBonuses(nodes) {
    const out = {
        dmgPct: 0, dmgFlat: 0, critPts: 0, critDmgPct: 0, speedPct: 0, hpPct: 0, hpFlat: 0,
        counterPct: 0, counterPts: 0, takenPct: 0, recoveryPct: 0, troopXpPct: 0, fightXpPct: 0,
        lootPct: 0, productionPct: 0, carryPct: 0, travelPct: 0, arrestTimePct: 0, arrestRiskPct: 0,
    };
    for (const n of nodes) {
        if (!n.points) continue;
        for (const e of n.effects) {
            if (!e.stat || e.value == null) continue;
            out[e.stat] = (out[e.stat] || 0) + e.value * (e.perPoint ? n.points : 1);
        }
    }
    for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
    return out;
}

/**
 * Multiplicateur appliqué à un coup critique, talents compris.
 *
 * Le jeu part de ×1,5 (règles officielles) et le talent « Executioner » annonce `+50% critical
 * damage`. Le libellé est ambigu : il peut vouloir dire que la *prime* passe de +50 % à +100 %
 * (→ ×2,0) ou que les dégâts critiques eux-mêmes gagnent 50 % (→ ×2,25). On tranche par le rejeu
 * de l'historique plutôt que par l'interprétation — voir `calibrateCritMode()` dans sim.mjs.
 */
export function critMultiplier(bonuses, { base = 1.5, mode = 'bonus' } = {}) {
    const pct = (bonuses?.critDmgPct || 0) / 100;
    return mode === 'total' ? base * (1 + pct) : base + pct;
}

/* ---------- Utilitaires ---------- */

function grab(html, re) {
    const m = re.exec(String(html || ''));
    return m ? m[1] : null;
}

function text(html) {
    return decode(String(html || '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function num(raw) {
    if (raw == null) return null;
    const n = Number(String(raw).replace(/[\s  ,]/g, '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function decode(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', times: '×' };
    return String(s)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (full, name) => (name.toLowerCase() in named ? named[name.toLowerCase()] : full));
}

const rel = (p) => p.replace(`${config.root}/`, '');
