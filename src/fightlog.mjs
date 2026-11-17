/* Le journal de combat tel que le jeu le rédige — GET /play/view/fightlog?id=<id>.

   On a déjà `report.events`, la frise brute coup par coup. Pourquoi aller chercher le journal
   rendu en plus ? Parce qu'il porte deux informations que le JSON ne donne **pas** :

   — le marqueur **« Critical hit »** : `events` ne dit jamais si un coup a été critique. C'est la
     seule source directe sur le multiplicateur de critique, qu'on n'avait pu qu'estimer en
     calibrant le rejeu de l'historique ;
   — le nombre d'**unités mises KO** par chaque coup, que le jeu calcule lui-même.

   On ne stocke pas le HTML (72 Ko par combat, trois fois le combat entier) : il est converti en
   lignes structurées, ~9 Ko, et c'est ça qui part en base.

   Balisage, stable et simple :
     <li class="fl-ab is-att">   une capacité déclenchée
     <li class="is-att">         un coup porté par l'attaquant
     <li class="is-def fl-rip-line">  une riposte du défenseur
     <li class="fl-end">         la conclusion
   avec, à l'intérieur : <time>, <b>type</b>, <small class="fl-n">×qté</small>, la valeur des
   dégâts, et les marqueurs .fl-crit / .fl-ko / .fl-heal. */

export const LOG_VERSION = 1;

/**
 * Convertit le journal rendu en lignes exploitables.
 * @param html la vue `fightlog`
 * @param nameToKey table « nom affiché → clé de type », construite depuis le rapport de combat
 */
export function parseFightLog(html, nameToKey = new Map()) {
    const block = between(html, 'fl-lines', '</ul>');
    if (!block) return null;

    const lines = [];
    let lastT = 0;
    for (const m of block.matchAll(/<li class="([^"]*)">([\s\S]*?)<\/li>/g)) {
        const cls = m[1];
        const inner = m[2];
        const side = /is-att/.test(cls) ? 'att' : /is-def/.test(cls) ? 'def' : null;
        // Une riposte n'a pas d'horodatage propre : elle répond au coup qui précède.
        const stamp = grab(inner, /<time>([^<]*)<\/time>/);
        const t = stamp && stamp.trim() ? csOf(stamp) : lastT;
        lastT = t;

        if (/fl-end/.test(cls)) {
            lines.push({ t, kind: 'end', text: text(inner.replace(/<time>[\s\S]*?<\/time>/, '')) });
            continue;
        }
        if (/fl-ab/.test(cls)) {
            lines.push({ t, side, kind: 'ability', text: text(inner.replace(/<time>[\s\S]*?<\/time>/, '')) });
            continue;
        }

        /* Deux formes de coup, et la quantité de la cible n'est pas toujours donnée :
             « <b>Hustler</b> <small>×200</small> hits <b>Scumbag</b> <small>×30</small> : 65 607 »
             « <b>Bandit</b> <small>×67</small> hits back at <b>Thug</b> : 18 412 »     (riposte)
           On lit donc les noms dans l'ordre, la quantité restant optionnelle. */
        const actors = [...inner.matchAll(/<b>([\s\S]*?)<\/b>(?:\s*<small class="fl-n">×([\d\s.,]+)<\/small>)?/g)]
            .map((a) => ({ name: text(a[1]), qty: a[2] == null ? null : num(a[2]) }))
            .filter((a) => a.name);
        if (actors.length < 2) {
            const raw = text(inner.replace(/<time>[\s\S]*?<\/time>/, ''));
            if (raw) lines.push({ t, side, kind: 'note', text: raw });
            continue;
        }

        const [from, to] = actors;
        const heal = num(grab(inner, /class="fl-heal"[^>]*>([^<]*)</));
        const key = (a) => nameToKey.get(a.name) || a.name;
        /* Forme compacte : pas de champ quand il n'apporte rien. Un journal pèse ~10 Ko par
           combat, et il y en aura un par combat archivé — chaque octet compte. */
        lines.push({
            t,
            side,
            kind: 'hit',
            from: key(from),
            ...(from.qty != null ? { fromQty: from.qty } : {}),
            to: key(to),
            ...(to.qty != null ? { toQty: to.qty } : {}),
            dmg: damageOf(inner),
            // Le seul endroit du jeu qui dise qu'un coup a été critique.
            ...(/class="fl-crit"/.test(inner) ? { crit: true } : {}),
            ...(/fl-rip-line/.test(cls) ? { riposte: true } : {}),
            ...(num(grab(inner, /class="fl-ko"[^>]*>([\d\s.,]+)\s*KO</)) ? { ko: num(grab(inner, /class="fl-ko"[^>]*>([\d\s.,]+)\s*KO</)) } : {}),
            ...(heal ? { heal } : {}),
        });
    }

    if (!lines.length) return null;
    const hits = lines.filter((l) => l.kind === 'hit');
    return {
        version: LOG_VERSION,
        cs: lines[lines.length - 1]?.t ?? 0,
        outcome: lines.find((l) => l.kind === 'end')?.text || null,
        counts: {
            lines: lines.length,
            hits: hits.length,
            crits: hits.filter((h) => h.crit).length,
            ripostes: hits.filter((h) => h.riposte).length,
            abilities: lines.filter((l) => l.kind === 'ability').length,
            ko: hits.reduce((a, h) => a + (h.ko || 0), 0),
        },
        lines,
    };
}

/** « Hustler » → « lascar » : le journal nomme les types, le reste du dépôt les indexe par clé. */
export function nameMap(report) {
    const map = new Map();
    for (const side of ['att', 'def']) {
        for (const p of report?.[side]?.piles || []) {
            if (p.name) map.set(p.name, String(p.key).replace(/@.*/, ''));
        }
    }
    return map;
}

/* Les dégâts sont la dernière valeur chiffrée avant les marqueurs : on isole donc le texte en
   retirant d'abord les quantités, le KO et la mention de critique. */
function damageOf(inner) {
    const stripped = inner
        .replace(/<small class="fl-n">[\s\S]*?<\/small>/g, ' ')
        .replace(/<[^>]*class="fl-ko"[^>]*>[\s\S]*?<\/[a-z]+>/g, ' ')
        .replace(/<[^>]*class="fl-crit"[^>]*>[\s\S]*?<\/[a-z]+>/g, ' ')
        .replace(/<[^>]*class="fl-heal"[^>]*>[\s\S]*?<\/[a-z]+>/g, ' ')
        .replace(/<time>[\s\S]*?<\/time>/g, ' ');
    const m = /:\s*([\d\s.,  ]+)/.exec(text(stripped));
    return m ? num(m[1]) : null;
}

/** « 0:12.0 » → 1200 centièmes de seconde, l'unité de temps de tout le dépôt. */
function csOf(raw) {
    const m = /(\d+):(\d+)(?:\.(\d+))?/.exec(String(raw || ''));
    if (!m) return 0;
    return (Number(m[1]) * 60 + Number(m[2])) * 100 + Number((m[3] || '0').padEnd(2, '0'));
}

function between(html, from, to) {
    const i = String(html || '').indexOf(from);
    if (i < 0) return null;
    const j = html.indexOf(to, i);
    return html.slice(i, j < 0 ? undefined : j);
}

function grab(html, re) {
    const m = re.exec(String(html || ''));
    return m ? m[1] : null;
}

function text(html) {
    return String(html || '')
        .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#x27;|&apos;|&#039;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function num(raw) {
    if (raw == null) return null;
    const n = Number(String(raw).replace(/[\s  ,]/g, '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/* ---------- Ce que le journal permet de mesurer ---------- */

/**
 * Multiplicateur des coups critiques, **mesuré** au lieu d'être déduit.
 *
 * Le journal marque les coups critiques, ce que la frise JSON ne fait pas. Pour une même pile
 * dans un même combat, le rapport entre la médiane de ses coups critiques et celle de ses coups
 * normaux donne le multiplicateur directement : l'équipement, les talents, le niveau de type et
 * les capacités en cours s'annulent, puisqu'on compare la pile à elle-même au même moment.
 *
 * Résultat sur l'archive, stable quel que soit le seuil d'échantillon retenu :
 *   — mon camp ×1,98  (talent « Executioner », +50 % de dégâts critiques)
 *   — en face  ×1,50  (la valeur de base des règles)
 *
 * C'est ce qui a corrigé une erreur : le multiplicateur avait d'abord été *calé* sur le rejeu de
 * l'historique, qui préférait ×2,25. Sur 61 combats, le calage sur-ajustait. La mesure tranche.
 */
export function measureCritMultiplier(fights, meId) {
    const sides = { mine: [], theirs: [] };
    for (const entry of Object.values(fights?.fights || {})) {
        const log = entry.log;
        const report = entry.detail?.fight?.report;
        if (!log?.lines || !report) continue;
        const mine = report.att.id === meId ? 'att' : 'def';

        // Une pile, un combat : on la compare à elle-même, rien d'autre ne bouge.
        const per = new Map();
        for (const l of log.lines) {
            if (l.kind !== 'hit' || l.riposte || !l.dmg || !l.fromQty) continue;
            const k = `${l.side}|${l.from}`;
            if (!per.has(k)) per.set(k, { crit: [], plain: [] });
            (l.crit ? per.get(k).crit : per.get(k).plain).push(l.dmg / l.fromQty);
        }
        for (const [k, g] of per) {
            if (g.crit.length < 3 || g.plain.length < 5) continue;
            const ratio = mid(g.crit) / mid(g.plain);
            if (Number.isFinite(ratio)) sides[k.split('|')[0] === mine ? 'mine' : 'theirs'].push(ratio);
        }
    }
    const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
    return {
        mine: round2(mid(sides.mine)),
        theirs: round2(mid(sides.theirs)),
        samples: { mine: sides.mine.length, theirs: sides.theirs.length },
    };
}

/** Taux de critique réellement observé par type et par camp — à comparer aux cartes du shop. */
export function measureCritRates(fights, meId) {
    const acc = new Map();
    for (const entry of Object.values(fights?.fights || {})) {
        const log = entry.log;
        const report = entry.detail?.fight?.report;
        if (!log?.lines || !report) continue;
        const mine = report.att.id === meId ? 'att' : 'def';
        for (const l of log.lines) {
            if (l.kind !== 'hit' || l.riposte) continue;
            const k = `${l.side === mine ? 'mine' : 'theirs'}|${l.from}`;
            const e = acc.get(k) || { side: l.side === mine ? 'mine' : 'theirs', key: l.from, hits: 0, crits: 0 };
            e.hits += 1;
            if (l.crit) e.crits += 1;
            acc.set(k, e);
        }
    }
    return [...acc.values()]
        .filter((e) => e.hits >= 30)
        .map((e) => ({ ...e, rate: Math.round((1000 * e.crits) / e.hits) / 10 }))
        .sort((a, b) => b.hits - a.hits);
}

const mid = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : NaN;
};
