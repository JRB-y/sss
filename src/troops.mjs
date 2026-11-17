import path from 'node:path';
import { config } from './config.mjs';
import { log, readJson, writeJson, writeText, sleep } from './util.mjs';

/* Le shop de recrutement est une vue AJAX : GET /play/view/units?cat=<troops|girls|narcos>.
   Chaque carte `li.unit-card` porte tout ce qui nous intéresse — rôle, capacité et son texte
   complet, stats de base ET stats effectives (tes talents + ton équipement), coût au recrutement.

   Deux limites viennent du serveur, pas du script :
   — les types au-dessus de ton niveau sont servis masqués (`is-secret`) : ni stats, ni capacité.
     Seul le prochain à débloquer est montré en avant-première. On archive donc au fil des
     niveaux, comme pour les combats : chaque run complète data/troops.json sans rien perdre.
   — la langue du jeu suit le réglage du compte (boot.locale), pas l'en-tête Accept-Language ni
     un paramètre d'URL. Les noms servis ici sont ceux de ce réglage ; les noms français viennent
     de ROSTER (relevé sur /fr/regles) pour que le document reste lisible dans les deux cas. */

const CATEGORIES = ['troops', 'girls', 'narcos'];

/* Les 21 types de troupes dans l'ordre du shop. Niveaux de déblocage et rôles relevés sur
   https://ssandsun.com/fr/regles — c'est la seule source pour les types encore verrouillés
   (le jeu, lui, confirme le niveau requis dès qu'une carte est masquée). */
export const ROSTER = [
    { key: 'mauviette', fr: 'Junkie', level: 1, role: 'fast' },
    { key: 'racaille', fr: 'Racaille', level: 1, role: 'guard' },
    { key: 'lascar', fr: 'Lascar', level: 1, role: 'heavy' },
    { key: 'voyou', fr: 'Voyou', level: 5, role: 'fast' },
    { key: 'bandit', fr: 'Bandit', level: 10, role: 'guard' },
    { key: 'brute', fr: 'Brute', level: 15, role: 'heavy' },
    { key: 'diablesse', fr: 'Diablesse', level: 20, role: 'fast' },
    { key: 'braqueur', fr: 'Braqueur', level: 26, role: 'heavy' },
    { key: 'tueur_a_gage', fr: 'Tueur à gages', level: 33, role: 'guard' },
    { key: 'gros_bras', fr: 'Gros Bras', level: 37, role: 'heavy' },
    { key: 'assassin', fr: 'Assassin', level: 41, role: 'fast' },
    { key: 'tony', fr: 'Tony Montagna', level: 44, role: 'allround' },
    { key: 'deathgirl', fr: 'Deathgirl', level: 47, role: 'guard' },
    { key: 'sicario', fr: 'Sicario', level: 50, role: 'fast' },
    { key: 'garde_du_corps', fr: 'Garde du corps', level: 53, role: 'guard' },
    { key: 'hellboy', fr: 'Hellboy', level: 56, role: 'heavy' },
    { key: 'bloody_mary', fr: 'Bloody Mary', level: 59, role: 'fast' },
    { key: 'mastodonte', fr: 'Mastodonte', level: 61, role: 'heavy' },
    { key: 'keyser_soze', fr: 'Keyser Söze', level: 63, role: 'allround' },
    { key: 'golem', fr: 'Le Golem', level: 65, role: 'guard' },
    { key: 'escobarre', fr: 'Pablo Escobarre', level: 68, role: 'allround' },
];

export const ROLE_FR = {
    fast: 'Rapide',
    guard: 'Défenseur',
    heavy: 'Cogneur',
    allround: 'Polyvalent',
};

/* Capacités : clé serveur (vue dans les rapports de combat) → nom et effet français des règles. */
const ABILITIES_FR = {
    ambush: ['Embuscade', 'Avant le combat, chacun de tes groupes frappe une fois, à 40 % de sa puissance.'],
    time_freeze: ['Gel du temps', 'Au début du combat, les troupes adverses sont figées 0,5 s.'],
    frenzy: ['Frénésie', 'Au début du combat, tes troupes frappent 50 % plus vite pendant 2 s.'],
    shield: ['Bouclier', 'Un bouclier absorbe les premiers dégâts : 8 % de la vie de tes troupes.'],
    shockwave: ['Onde de choc', 'Quand l’adversaire a perdu 30 % de sa vie, une onde frappe toute son armée.'],
    coup_de_grace: ['Coup de grâce', 'Quand l’adversaire passe sous 35 % de vie, ses groupes les plus abîmés sont achevés.'],
    rage: ['Rage', 'Sous 50 % de vie, tes troupes font +35 % de dégâts pendant 10 s.'],
    fortress: ['Forteresse', 'Quand ton premier groupe tombe ou sous 40 % de vie, tes troupes encaissent 35 % de dégâts en moins pendant 10 s.'],
    second_wind: ['Second souffle', 'Une fois sous 30 % de vie, tes troupes récupèrent 12 % de leur vie.'],
    last_stand: ['Dernier carré', 'Sous 25 % de vie, tes troupes font +50 % de dégâts et frappent 50 % plus vite jusqu’à la fin.'],
    intimidation: ['Intimidation', 'Au début du combat, l’adversaire inflige 20 % de dégâts en moins pendant 5 s.'],
    bleed: ['Saignée', 'Tes coups critiques font saigner : ils frappent ×2,5 au lieu de ×1,5.'],
    reflect: ['Renvoi', '2 % des dégâts que reçoivent tes troupes reviennent au groupe qui frappe.'],
    corruption: ['Corruption', 'Au début du combat, le plus gros groupe adverse est acheté : il ne frappe pas pendant un moment (jusqu’à 2 s, moins s’il fait presque toute l’armée).'],
};

/** Clé serveur d'une capacité d'après son nom affiché (le HTML ne donne que le libellé). */
const ABILITY_KEY_BY_NAME = {
    ambush: 'ambush', embuscade: 'ambush',
    'time freeze': 'time_freeze', 'gel du temps': 'time_freeze',
    frenzy: 'frenzy', frénésie: 'frenzy',
    shield: 'shield', bouclier: 'shield',
    shockwave: 'shockwave', 'onde de choc': 'shockwave',
    'finishing blow': 'coup_de_grace', 'coup de grâce': 'coup_de_grace',
    rage: 'rage',
    fortress: 'fortress', forteresse: 'fortress',
    'second wind': 'second_wind', 'second souffle': 'second_wind',
    'last stand': 'last_stand', 'dernier carré': 'last_stand',
    intimidation: 'intimidation',
    bleed: 'bleed', bleeding: 'bleed', saignée: 'bleed',
    reflect: 'reflect', payback: 'reflect', renvoi: 'reflect',
    corruption: 'corruption',
};

/* ---------- Collecte ---------- */

export async function syncTroops(session, { keepRaw = false } = {}) {
    log.title('Troupes et unités (data/troops.json)');

    const store = (await readJson(config.paths.troops)) || { version: 1, units: {} };
    const now = new Date().toISOString();
    const seen = { troops: 0, girls: 0, narcos: 0 };
    let fresh = 0;
    let hidden = 0;

    let crew = null;
    for (const cat of CATEGORIES) {
        const html = await session.view('units', { cat });
        if (keepRaw) await writeText(path.join(config.paths.raw, `view-units-${cat}.html`), html);

        if (cat === 'troops') crew = readCrew(html);
        const cards = parseCards(html, cat);
        seen[cat] = cards.length;
        for (const card of cards) {
            const id = `${cat}/${card.key}`;
            const before = store.units[id];
            if (!card.detailed) hidden += 1;
            // Une carte masquée n'écrase jamais un relevé complet d'un run précédent.
            if (!card.detailed && before?.detailed) continue;
            if (card.detailed && !before?.detailed) fresh += 1;
            store.units[id] = {
                ...card,
                cat,
                firstSeenAt: before?.firstSeenAt || now,
                fetchedAt: now,
            };
        }
        log.info(`${cat} : ${cards.length} cartes, ${cards.filter((c) => !c.detailed).length} sans stats`);
        await sleep(Math.max(config.requestDelayMs, 400)); // 5 vues trop rapprochées → HTTP 409
    }

    store.updatedAt = now;
    store.account = session.boot?.player?.name || null;
    store.accountLevel = session.boot?.player?.level?.level ?? null;
    store.gameLocale = session.boot?.locale || null;
    store.counts = seen;
    // Places de troupes et emplacements de types : le simulateur de compos en a besoin, et le
    // seuil d'activation des capacités (10 % des places) en découle directement.
    store.crew = {
        ...(crew || {}),
        ...(session.boot?.player?.crew?.troops
            ? { inService: session.boot.player.crew.troops.n, reserve: session.boot.player.crew.troops.reserve || 0 }
            : {}),
    };
    store.crew.abilityNeed = store.crew.slots ? Math.ceil(store.crew.slots * 0.1) : null;
    await writeJson(config.paths.troops, store);
    log.pass(`${Object.keys(store.units).length} unités en base → ${rel(config.paths.troops)}`);

    const file = path.join(config.paths.docs, 'troupes.md');
    await writeText(file, renderTroopsDoc(store));
    log.pass(`document → ${rel(file)}`);

    if (hidden) {
        log.warn(`${hidden} fiches encore masquées par le jeu (niveau de perso requis) : relance la `
            + 'commande en montant de niveau, le fichier se complète tout seul.');
    }
    return { file, units: Object.keys(store.units).length, fresh, hidden };
}

/* L'en-tête de la vue porte les deux limites qui encadrent une composition :
   « Room: 875 / 875 » (places de troupes) et « Types: 4 / 4 » (emplacements de types). */
function readCrew(html) {
    const head = grab(html, /<div class="sheet-head">([\s\S]*?)<\/div>\s*<div/) || html;
    const nums = [...text(head).matchAll(/(\d[\d\s.,]*)\s*\/\s*(\d[\d\s.,]*)/g)]
        .map((m) => [num(m[1]), num(m[2])]);
    const [used, slots] = nums[0] || [null, null];
    const [typesUsed, typeSlots] = nums[1] || [null, null];
    return { used, slots, typesUsed, typeSlots };
}

/* ---------- Lecture d'une carte ---------- */

function parseCards(html, cat) {
    return splitCards(html).map((card) => readCard(card, cat)).filter(Boolean);
}

function splitCards(html) {
    const out = [];
    const re = /<li class="build-card unit-card[^"]*"[^>]*data-unit="/g;
    const starts = [];
    let m;
    while ((m = re.exec(html))) starts.push(m.index);
    for (let i = 0; i < starts.length; i += 1) {
        const end = html.indexOf('</li>', starts[i]);
        out.push(html.slice(starts[i], end < 0 ? undefined : end + 5));
    }
    return out;
}

function readCard(html, cat) {
    const key = attr(html, 'data-unit');
    if (!key) return null;

    const lockText = text(grab(html, /<div class="locked-info">([\s\S]*?)<\/div>/));
    const requires = lockText ? num(/level\s+(\d+)|niveau\s+(\d+)/i.exec(lockText)?.slice(1).find(Boolean)) : null;
    const secret = /class="[^"]*is-secret/.test(html);
    const stats = readStats(html);

    return {
        key,
        name: text(grab(html, /<h3 data-unit-name>([\s\S]*?)<\/h3>/)),
        fr: ROSTER.find((r) => r.key === key)?.fr || null,
        secret,
        // Le prochain type à débloquer est servi masqué mais stats comprises : c'est une
        // avant-première, et c'est la seule fenêtre sur un type verrouillé.
        detailed: Object.keys(stats).length > 1,
        preview: secret && Object.keys(stats).length > 1,
        requiresLevel: requires ?? (cat === 'troops' ? ROSTER.find((r) => r.key === key)?.level ?? null : null),
        typeLevel: num(grab(html, /<span class="card-lv[^"]*"[^>]*>Lv\.\s*(\d+)/)) ?? (stats.typeLevel?.base ?? null),
        typeXp: readTypeXp(html),
        owned: num(grab(html, /<span class="card-owned"[^>]*>×([\d\s,.]+)</)),
        description: text(grab(html, /<p class="unit-desc" data-unit-desc>([\s\S]*?)<\/p>/)),
        role: readRole(html),
        ability: readAbility(html),
        produces: attr(html, 'data-produces') || null,
        stats,
        cost: readCost(html),
        image: attr(html, 'src'),
    };
}

/* Progression du niveau de type. L'info-bulle de la pastille « Lv. N » porte la seule mesure que
   le jeu donne de l'XP d'un type : « 7 911 / 27 134 XP to level 4 ». Elle permet de savoir
   combien il reste avant le prochain palier — et donc avant les +2 % de vie et de dégâts
   suivants, qui valent pour TOUTES les unités de ce type. */
function readTypeXp(html) {
    const raw = grab(html, /<span class="card-lv[^"]*"[\s\S]*?<span class="stat-tip"[^>]*>([\s\S]*?)<\/span>/);
    if (!raw) return null;
    // L'info-bulle s'ouvre sur « <b>Type level 3</b> » : son chiffre collerait au compteur d'XP.
    const tip = text(raw.replace(/<b>[\s\S]*?<\/b>/, ' '));
    const m = /([\d.,\s  ]+)\s*\/\s*([\d.,\s  ]+)\s*XP/i.exec(tip);
    if (!m) return { maxed: /max/i.test(tip) || null };
    const xp = num(m[1]);
    const next = num(m[2]);
    return {
        xp,
        next,
        remaining: Number.isFinite(xp) && Number.isFinite(next) ? next - xp : null,
        pct: Number.isFinite(xp) && next ? Math.round((1000 * xp) / next) / 10 : null,
        toLevel: num(/to level\s*(\d+)/i.exec(tip)?.[1]),
    };
}

function readRole(html) {
    const m = /<span class="unit-role r-([a-z]+)[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/.exec(html);
    if (!m) return null;
    const inner = m[2];
    const tip = grab(inner, /<span class="stat-tip" role="tooltip">([\s\S]*?)$/) || '';
    return {
        key: m[1],
        name: text(inner.replace(/<span class="stat-tip"[\s\S]*$/, '')),
        fr: ROLE_FR[m[1]] || null,
        note: text(tip.replace(/<b>[\s\S]*?<\/b>/, '')),
    };
}

function readAbility(html) {
    const m = /<span class="unit-ability[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/.exec(html);
    if (!m) return null;
    const inner = m[1];
    const name = text(grab(inner, /<span>([\s\S]*?)<\/span>/));
    const tip = text((grab(inner, /<span class="stat-tip" role="tooltip">([\s\S]*?)$/) || '').replace(/<b>[\s\S]*?<\/b>/, ''));
    const abKey = ABILITY_KEY_BY_NAME[name.toLowerCase()] || null;
    return { key: abKey, name, fr: abKey ? ABILITIES_FR[abKey][0] : null, effect: tip };
}

/* Le dos de la carte (`.unit-back-stats`) porte les libellés les plus explicites et les deux
   colonnes de valeurs : `.v-base` = le type seul, `.v-eff` = avec tes talents et ton matériel. */
const STAT_KEYS = {
    'st-hp': 'hp', 'st-dmg': 'damage', 'st-crit': 'crit', 'st-rip': 'counter',
    'st-spd': 'speed', 'st-lv': 'typeLevel', 'st-risk': 'arrestRisk',
};

function readStats(html) {
    const back = grab(html, /<dl class="unit-stats unit-back-stats[^"]*">([\s\S]*?)<\/dl>/);
    const source = back || grab(html, /<dl class="unit-stats">([\s\S]*?)<\/dl>/) || '';
    const stats = {};
    for (const row of source.split(/<div(?=[\s>])/).slice(1)) {
        const icon = (/class="ico (st-[a-z]+)"/.exec(row) || [])[1];
        const res = (/res\/([a-z]+)\.webp/.exec(row) || [])[1];
        const label = text(grab(row, /<dt>([\s\S]*?)<\/dt>/));
        const dd = grab(row, /<dd>([\s\S]*?)<\/dd>/) || '';
        const eff = pickValue(dd, 'v-eff');
        const base = pickValue(dd, 'v-base');
        const name = STAT_KEYS[icon] || (res ? 'production' : slugKey(label));
        if (!name) continue;
        stats[name] = {
            label,
            ...(res ? { res } : {}),
            base: parseStat(base ?? eff),
            effective: parseStat(eff ?? base),
            text: text(eff ?? base ?? ''),
        };
    }
    return stats;
}

function pickValue(dd, cls) {
    const m = new RegExp(`<span class="${cls}">([\\s\\S]*?)</span>\\s*(?=<span class="v-|$)`).exec(dd);
    if (m) return m[1];
    // Sans bonus, le jeu n'écrit qu'une valeur brute dans <dd>.
    return dd.includes('class="v-') ? null : dd;
}

/** « 3 837 » → 3837 · « 466–497 » → {min,max} · « 12 % » → 12 · « 1 hit / 1,58 s » → 1.58. */
function parseStat(raw) {
    const t = text(raw).replace(/ /g, ' ');
    if (!t) return null;
    const range = /(-?[\d.,\s]+)\s*[–—-]\s*(-?[\d.,\s]+)/.exec(t);
    if (range) return { min: toNumber(range[1]), max: toNumber(range[2]) };
    const seconds = /([\d.,]+)\s*s\b/.exec(t);
    if (seconds) return toNumber(seconds[1]);
    const first = /-?[\d.,\s]*\d/.exec(t);
    if (!first) return 0; // « Never » / « Jamais » : aucun risque d'arrestation
    return toNumber(first[0]);
}

function readCost(html) {
    const block = grab(html, /<div class="back-cost">([\s\S]*?)<\/div>/)
        || grab(html, /<span class="btn-cost">([\s\S]*?)<\/span><\/div>/)
        || html;
    const cost = {};
    for (const m of block.matchAll(/data-res="([a-z]+)" data-price="(\d+)"/g)) cost[m[1]] = Number(m[2]);
    return cost;
}

/* ---------- Document ---------- */

function renderTroopsDoc(store) {
    const byKey = (cat) => (key) => store.units[`${cat}/${key}`];
    const troop = byKey('troops');
    const out = [];

    out.push('# Sand Sea Sun — Les troupes', '');
    out.push('> Les 21 types de troupes : rôle, capacité spéciale, stats, coût de recrutement.', '');
    out.push(`*Relevé dans le jeu (\`/play/view/units?cat=troops\`) le ${day(store.updatedAt)} avec le compte`
        + ` **${store.account}** (niveau ${store.accountLevel}). Règles générales : [docs/regles.md](regles.md).*`, '');
    if (store.gameLocale && store.gameLocale !== 'fr') {
        out.push(`> ⚠️ L'interface de ce compte est réglée en \`${store.gameLocale}\` et le jeu ignore`
            + ' `Accept-Language` comme les paramètres d\'URL : les **noms d\'unité, descriptions et'
            + ' libellés relevés sont dans cette langue**. Les noms et effets français viennent des règles'
            + ' publiques. Passer le compte en français (téléphone › Réglages) ferait tout remonter en français.', '');
    }

    out.push('## Comment lire ces chiffres', '');
    out.push('- **Vie** — ce qu’une unité encaisse avant d’être assommée. Les troupes ne meurent jamais, elles récupèrent.');
    out.push('- **Dégâts** — par coup, tirés au hasard entre le minimum et le maximum.');
    out.push('- **Critique** — chance qu’un coup soit critique : tout le groupe frappe alors ×1,5.');
    out.push('- **Riposte** — chance que le groupe frappé rende le coup à 60 % de ses dégâts (toutes les unités touchées d’un coup).');
    out.push('- **Vitesse** — délai entre deux coups : plus il est court, plus l’unité frappe souvent.');
    out.push('- **Niveau de type** — chaque type gagne de l’XP en combat jusqu’au niveau 50 : **+2 % de dégâts et de vie par niveau**, pour toutes tes unités de ce type. Le bonus est **additif** et non composé : au niveau *n*, une unité vaut `base × (1 + 2 % × (n − 1))`. Vérifié sur l’historique à équipement constant — un modèle composé dérive dès le niveau 3.');
    out.push('');
    out.push('Deux colonnes de valeurs pour chaque stat :', '');
    out.push('- **base** — le type seul, à son niveau de type actuel, sans talents ni équipement (l’interrupteur « Stats de base » du shop) ;');
    out.push('- **réel** — ce que donnent tes unités à toi, bonus d’arbre de talents et d’objets compris.');
    out.push('');

    out.push('## Les 21 types', '');
    out.push('| Nv. | Type | Nom en jeu | Clé | Rôle | Capacité | Stats relevées |');
    out.push('| ---: | --- | --- | --- | --- | --- | --- |');
    for (const r of ROSTER) {
        const u = troop(r.key);
        const ability = u?.ability?.fr || u?.ability?.name || '—';
        const has = !u?.detailed ? '🔒' : (u.preview ? '👁' : '✅');
        out.push(`| ${r.level} | **${r.fr}** | ${u?.name && u.name !== r.fr ? u.name : '—'} | \`${r.key}\` `
            + `| ${ROLE_FR[u?.role?.key || r.role]} | ${ability} | ${has} |`);
    }
    out.push('');
    out.push('✅ relevé complet · 👁 avant-première (type verrouillé mais chiffré par le jeu) · '
        + '🔒 verrouillé : le jeu ne sert **ni stats ni capacité** avant que le personnage atteigne le '
        + 'niveau requis — il ne montre que le prochain type à débloquer. Relancer `npm run troops` en '
        + 'montant de niveau complète le tableau : `data/troops.json` accumule et ne perd jamais un relevé.', '');

    out.push('## Rôles et triangle des forces', '');
    out.push('| Rôle | Profil | Avantage léger contre |');
    out.push('| --- | --- | --- |');
    out.push('| **Rapide** | Frappe vite, mais fragile | Cogneurs |');
    out.push('| **Cogneur** | Frappe fort, mais lentement | Défenseurs |');
    out.push('| **Défenseur** | Solide, rend souvent les coups | Rapides |');
    out.push('| **Polyvalent** | Bon partout (Tony Montagna, Keyser Söze, Pablo Escobarre) | — |');
    out.push('');
    out.push('Tu alignes **4 types** différents au maximum (3 au départ, le 4ᵉ au niveau 5), en quantité libre ; '
        + 'l’**Annexe** (bâtiment du niveau 25) ouvre un **5ᵉ emplacement**.', '');

    out.push('## Les capacités spéciales', '');
    out.push('Une capacité agit sur **toute ton armée**, mais seulement si tu engages au moins **10 % de tes '
        + 'places de troupes** en unités de ce type. En dessous, elle ne fait rien. Deux types qui portent la '
        + 'même capacité ne la cumulent pas : chacun doit atteindre le seuil seul.', '');
    out.push('| Capacité | Effet | Portée par |');
    out.push('| --- | --- | --- |');
    for (const [abKey, [fr, effect]] of Object.entries(ABILITIES_FR)) {
        const carriers = ROSTER
            .filter((r) => troop(r.key)?.ability?.key === abKey)
            .map((r) => r.fr);
        out.push(`| **${fr}** | ${effect} | ${carriers.length ? carriers.join(', ') : '—'} |`);
    }
    out.push('');
    out.push('*Colonne « Portée par » : d’après les cartes relevées. Elle se remplit à mesure que les types se débloquent.*', '');

    out.push('## Fiches détaillées', '');
    const known = ROSTER.map((r) => ({ r, u: troop(r.key) })).filter((x) => x.u?.detailed);
    if (!known.length) out.push('*Aucune carte chiffrée pour ce compte.*', '');
    for (const { r, u } of known) {
        out.push(`### ${r.fr}${u.name && u.name !== r.fr ? ` · *${u.name}*` : ''}`, '');
        out.push(`**Niveau requis** ${r.level} · **Rôle** ${ROLE_FR[u.role?.key || r.role]}`
            + ` · **Capacité** ${u.ability?.fr || u.ability?.name || '—'}`
            + ` · **Niveau de type** ${u.typeLevel ?? '—'}${u.owned ? ` · **Possédées** ${u.owned}` : ''}`, '');
        if (u.typeXp?.next) {
            out.push(`*Progression du type : ${fr(u.typeXp.xp)} / ${fr(u.typeXp.next)} XP (${pct(u.typeXp.pct)} %)`
                + ` avant le niveau ${u.typeXp.toLevel} — il reste ${fr(u.typeXp.remaining)} XP à gagner en combat,`
                + ' et le palier vaudra +2 % de vie et de dégâts pour toutes tes unités de ce type.*', '');
        }
        if (u.preview) {
            out.push('> 👁 **Avant-première** — type encore verrouillé : le jeu en donne les chiffres mais '
                + 'pas le rôle ni la capacité.', '');
        }
        if (u.description) out.push(`*${u.description}*`, '');
        // L'effet servi par le jeu est dans la langue du compte : on préfère le texte français des règles.
        const effect = (u.ability?.key && ABILITIES_FR[u.ability.key]?.[1]) || u.ability?.effect;
        if (effect) out.push(`> **${u.ability.fr || u.ability.name}** — ${effect}`, '');
        out.push('| Stat | Base | Réel (ce compte) |');
        out.push('| --- | --- | --- |');
        for (const [name, label] of [['hp', 'Vie'], ['damage', 'Dégâts'], ['crit', 'Critique'], ['counter', 'Riposte'], ['speed', 'Vitesse d’attaque']]) {
            const s = u.stats[name];
            if (!s) continue;
            out.push(`| ${label} | ${fmtStat(name, s.base)} | ${fmtStat(name, s.effective)} |`);
        }
        out.push('');
        out.push(`**Coût d’un recrutement** — ${fmtCost(u.cost)}`, '');
    }

    for (const [cat, title, lead] of [
        ['girls', 'Les filles', 'Elles rapportent des dollars à chaque tour (toutes les 5 minutes), tant que le stock n’est pas plein.'],
        ['narcos', 'Les narcos', 'Ils fabriquent la marchandise : alcool, herbe, poudre.'],
    ]) {
        const units = Object.values(store.units).filter((u) => u.cat === cat);
        if (!units.length) continue;
        out.push(`## ${title}`, '', lead, '');
        out.push('| Nv. requis | Unité | Produit | Production / tour | Risque d’arrestation | Coût |');
        out.push('| ---: | --- | --- | ---: | ---: | --- |');
        for (const u of units) {
            const prod = u.stats?.production;
            const risk = u.stats?.arrestRisk;
            out.push(`| ${u.requiresLevel ?? '—'} | **${u.name}**${u.detailed ? '' : ' 🔒'} `
                + `| ${u.produces || prod?.res || '—'} | ${prod ? `+${fr(prod.base)}` : '—'} `
                + `| ${risk ? (risk.base ? `${pct(risk.base)} %` : 'jamais') : '—'} | ${u.detailed ? fmtCost(u.cost) : '—'} |`);
        }
        out.push('');
        if (units.some((u) => !u.detailed)) {
            out.push('*🔒 unités dont le jeu ne sert pas encore la fiche (niveau de personnage requis). '
                + '« — » dans la colonne niveau : disponible sans condition de niveau.*', '');
        }
    }

    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function fmtStat(name, value) {
    if (value === null || value === undefined) return '—';
    if (name === 'speed') return `1 coup / ${fr(value)} s`;
    if (name === 'crit' || name === 'counter') return `${fr(value)} %`;
    if (typeof value === 'object') return `${fr(value.min)} – ${fr(value.max)}`;
    return fr(value);
}

function fmtCost(cost) {
    const labels = { cash: '$', alcohol: 'alcool', weed: 'herbe', powder: 'poudre', gems: 'gemmes' };
    const parts = Object.entries(cost || {}).filter(([, v]) => v > 0).map(([res, v]) => `${fr(v)} ${labels[res] || res}`);
    return parts.length ? parts.join(' · ') : 'gratuit';
}

/* ---------- Utilitaires ---------- */

const fr = (n) => (typeof n === 'number' ? n.toLocaleString('fr-FR') : String(n ?? '—'));
const pct = (n) => String(n).replace('.', ',');
const rel = (p) => path.relative(config.root, p);
/** Date locale (le jeu et le joueur ne vivent pas en UTC). */
const day = (iso) => new Date(iso).toLocaleDateString('fr-CA');

function grab(html, re) {
    const m = re.exec(String(html || ''));
    return m ? m[1] : null;
}

function attr(html, name) {
    return grab(html, new RegExp(`${name}="([^"]*)"`));
}

function text(html) {
    return decode(String(html || '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function num(raw) {
    if (raw === null || raw === undefined) return null;
    const n = toNumber(raw);
    return Number.isFinite(n) ? n : null;
}

/** Les nombres arrivent localisés : « 3,837 » (en) ou « 3 837 » / « 1,58 » (fr). */
function toNumber(raw) {
    let s = String(raw).replace(/[\s  ]/g, '');
    if (/,\d{3}(?:\D|$)/.test(s) || /\d,\d{3}$/.test(s)) s = s.replace(/,/g, ''); // séparateur de milliers
    else s = s.replace(',', '.');
    return Number(s.replace(/[^\d.-]/g, ''));
}

function slugKey(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || null;
}

function decode(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', times: '×', rsquo: '’', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', middot: '·', deg: '°' };
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (full, name) => (name.toLowerCase() in named ? named[name.toLowerCase()] : full));
}
