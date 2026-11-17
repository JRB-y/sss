import { config } from './config.mjs';
import { log, readJson, writeJson } from './util.mjs';

/* État du quartier général — ressources, bâtiments, niveau, points de compétence.

   Deux sources, toutes deux déjà ouvertes par la session :
   — `boot.player`, relu via GET /play/state : ressources, capacités, production, niveau et XP du
     personnage, points de compétence non dépensés, attaques restantes, famille, rang ;
   — GET /play/buildings : les bâtiments posés, un par un, avec leur niveau, leur niveau maximum,
     leurs PV, et le chantier en cours s'il y en a un.

   Comme le reste du dépôt, le fichier **accumule** : chaque passage ajoute un point d'historique
   quand une valeur suivie change (niveau, classement, points libres, nombre de bâtiments). On peut
   donc voir sa progression sans avoir rien prévu à l'avance. */

const STORE_VERSION = 1;

/** Ressources du jeu, dans l'ordre où il les présente. */
export const RESOURCES = [
    { key: 'cash', fr: 'Dollars', icon: 'cash' },
    { key: 'alcohol', fr: 'Alcool', icon: 'alcohol' },
    { key: 'weed', fr: 'Herbe', icon: 'weed' },
    { key: 'powder', fr: 'Poudre', icon: 'powder' },
    { key: 'gems', fr: 'Gemmes', icon: 'gems' },
    { key: 'respect', fr: 'Respect', icon: 'respect' },
];

/* Rôle de chaque bâtiment, pour qu'un compte rendu se lise sans connaître le jeu. Les noms
   affichés viennent du serveur (`boot.buildingNames`), dans la langue du compte. */
export const BUILDING_ROLE = {
    hq: 'Quartier général — commande le niveau maximum des autres bâtiments',
    tent: 'Tente — loge des troupes',
    cave: 'Cellier — produit et stocke l’alcool',
    hut: 'Cabane — produit l’herbe et la poudre',
    sandbags: 'Sacs de sable — défense passive de la ville',
    police: 'Poste de police — réduit le risque d’arrestation',
    armory: 'Armurerie — forge et améliore l’équipement',
    bank: 'Banque — met les dollars à l’abri du pillage',
    market: 'Marché noir — échange de ressources',
    embassy: 'Ambassade — renforts de famille',
    hospital: 'Dispensaire — accélère la récupération des troupes',
    guard: 'Poste de garde — plancher d’unités vivantes en défense',
    gym: 'Gym — XP de troupe par heure',
    casino: 'Casino — jeux et gains',
    storage: 'Caisse de stockage — capacité de ressources',
    annex: 'Annexe — ouvre un 5ᵉ emplacement de type de troupe',
    radar: 'Tour radar — repère les attaques entrantes',
};

export async function syncHq(session) {
    log.title('Quartier général');

    // Le boot injecté au chargement date d'avant la connexion : on relit l'état vivant.
    await session.fetchState();
    const player = session.boot?.player;
    if (!player) throw new Error('État du joueur illisible : la session n’est peut-être plus valide.');

    const res = await session.json('play/buildings');
    if (!res.ok || !res.data?.ok) throw new Error(`GET play/buildings → HTTP ${res.status}`);
    const city = res.data;

    const previous = await readJson(config.paths.hq);
    const now = new Date().toISOString();
    const names = session.boot?.buildingNames || {};

    const buildings = (city.buildings || []).map((b) => ({
        id: b.id,
        type: b.type,
        name: b.name || names[b.type] || b.type,
        typeName: names[b.type] || b.type,
        role: BUILDING_ROLE[b.type] || null,
        level: b.level,
        maxLevel: b.maxLevel || null,
        // `maxLevel` vaut 0 sur le QG : c'est lui qui plafonne les autres, rien ne le plafonne.
        atMax: Boolean(b.maxLevel) && b.level >= b.maxLevel,
        sprite: b.sprite || `${b.type}-${b.level}`,
        hp: b.hp,
        hpMax: b.hpMax,
        x: b.x,
        y: b.y,
        works: b.upgradeAt
            ? { endsAt: b.upgradeAt, becomes: b.nextName || null, secondsLeft: Math.max(0, Math.round(b.upgradeAt - (city.now || Date.now() / 1000))) }
            : null,
    })).sort((a, b) => a.type.localeCompare(b.type) || b.level - a.level);

    const store = {
        version: STORE_VERSION,
        updatedAt: now,
        firstSeenAt: previous?.firstSeenAt || now,
        account: {
            id: player.id,
            name: player.name,
            avatar: player.avatar || null,
            city: player.city || null,
            premium: Boolean(player.premium),
            premiumDays: player.premiumDays ?? null,
            timezone: player.timezone || null,
        },
        level: {
            level: player.level?.level ?? null,
            xp: player.level?.xp ?? null,
            xpFrom: player.level?.from ?? null,
            xpTo: player.level?.to ?? null,
            pct: player.level?.pct ?? null,
            // Ce qu'il reste à gagner avant le prochain point de compétence.
            xpLeft: player.level?.to != null && player.level?.xp != null ? player.level.to - player.level.xp : null,
        },
        skillPoints: player.skillPoints ?? 0,
        rating: player.rating ?? null,
        rank: { family: player.rank ?? null, role: player.role || null, city: player.cityRank ?? null },
        resources: RESOURCES.map((r) => ({
            ...r,
            value: player.res?.[r.key] ?? null,
            cap: player.cap?.[r.key] ?? null,
            perTurn: player.prod?.[r.key] ?? null,
            spent: player.spend?.[r.key] ?? null,
            // Le stock plein, c'est de la production jetée : c'est la seule alerte qui compte ici.
            full: player.cap?.[r.key] != null && player.res?.[r.key] >= player.cap[r.key],
            pct: player.cap?.[r.key] ? Math.round((1000 * player.res[r.key]) / player.cap[r.key]) / 10 : null,
        })),
        turn: session.boot?.turn || null,
        crew: player.crew || null,
        attacks: player.atk ? { used: player.atk.n, max: player.atk.max, nextAt: player.atk.next } : null,
        defense: {
            shield: player.shield || 0,
            repairs: player.repairs ?? null,
            hideout: player.hideout || null,
            buffs: player.buffs || [],
        },
        family: player.family || null,
        city: {
            key: player.city || null,
            areaM2: player.areaM2 ?? null,
            radius: city.radius ?? null,
            maxRadius: city.maxRadius ?? null,
            buildingSlots: city.slots ?? null,
            militia: { level: city.mil ?? null, troops: city.milTroops ?? null, max: city.milMax ?? null, free: city.milFree ?? null },
        },
        buildings,
        summary: summarize(buildings),
        history: [...(previous?.history || [])],
    };

    /* Un point d'historique seulement quand quelque chose de suivi bouge : sinon un passage
       toutes les six heures remplirait le fichier de doublons. */
    const signature = [
        store.level.level, store.skillPoints, store.rating,
        store.summary.total, store.summary.levels, store.city.radius,
    ].join('|');
    if (store.history[store.history.length - 1]?.signature !== signature) {
        store.history.push({
            at: now,
            signature,
            level: store.level.level,
            skillPoints: store.skillPoints,
            rating: store.rating,
            buildings: store.summary.total,
            buildingLevels: store.summary.levels,
            radius: store.city.radius,
        });
    }
    store.history = store.history.slice(-200);

    await writeJson(config.paths.hq, store);

    const s = store.summary;
    log.pass(`niveau ${store.level.level} · classement ${store.rating} · ${store.skillPoints} point(s) de compétence libre(s)`);
    log.pass(`${s.total} bâtiments, ${s.levels} niveaux cumulés, ${s.atMax} au maximum${s.works ? `, ${s.works} chantier(s) en cours` : ''}`);
    const full = store.resources.filter((r) => r.full);
    if (full.length) log.warn(`stock plein : ${full.map((r) => r.fr.toLowerCase()).join(', ')} — la production est perdue`);
    if (store.skillPoints) log.warn(`${store.skillPoints} point(s) de compétence non dépensé(s).`);
    log.dim(`→ ${config.paths.hq.replace(`${config.root}/`, '')}`);

    return {
        level: store.level.level,
        skillPoints: store.skillPoints,
        buildings: s.total,
        works: s.works,
        full: full.map((r) => r.key),
    };
}

function summarize(buildings) {
    const byType = {};
    for (const b of buildings) {
        const e = byType[b.type] || { type: b.type, name: b.typeName, role: b.role, count: 0, levels: 0, max: 0, hp: 0, atMax: 0 };
        e.count += 1;
        e.levels += b.level || 0;
        e.max = Math.max(e.max, b.level || 0);
        e.hp += b.hpMax || 0;
        if (b.atMax) e.atMax += 1;
        byType[b.type] = e;
    }
    return {
        total: buildings.length,
        levels: buildings.reduce((a, b) => a + (b.level || 0), 0),
        atMax: buildings.filter((b) => b.atMax).length,
        works: buildings.filter((b) => b.works).length,
        hp: buildings.reduce((a, b) => a + (b.hpMax || 0), 0),
        byType: Object.values(byType).sort((a, b) => b.levels - a.levels),
    };
}
