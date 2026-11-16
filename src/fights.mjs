import { config } from './config.mjs';
import { log, readJson, writeJson, writeText, sleep } from './util.mjs';

/* Export de l'historique de combats.

   Deux étapes, en s'appuyant sur l'API interne du jeu :
     1. la liste   : GET /play/view/fights?dir=<sent|received>  → HTML ; chaque ligne (li.fh-row)
                     porte data-fight-replay="<id>" (les refs « tmp: » / « share: » sont des
                     combats volatils, on ne garde que les ids numériques) ;
     2. le détail  : GET /play/fight?id=<id>  → JSON { ok, fight, names, imgs, res }, le combat
                     complet tel que le rejeu l'utilise.

   Le jeu n'expose PAS de pagination : la vue renvoie une fenêtre fixe des combats récents
   (page / offset / before sont ignorés par le serveur — vérifié). On télécharge donc ce qui est
   listé, et data/fights.json accumule : chaque combat déjà en base y reste même quand il sort de
   la fenêtre. Un run ne retélécharge que les ids absents (ou tous avec --refresh), si bien que
   relancer régulièrement la commande constitue l'archive complète au fil du temps. */

const STORE_VERSION = 1;
const FALLBACK_DIRS = ['sent', 'received'];

export async function syncFights(session, { refresh = false, keepRaw = false } = {}) {
    log.title('Historique de combats');

    const store = (await readJson(config.paths.fights, null)) || {
        version: STORE_VERSION, createdAt: new Date().toISOString(), fights: {},
    };
    if (!store.fights) store.fights = {};
    const knownBefore = Object.keys(store.fights).length;

    const dirs = await resolveDirections(session);
    log.info(`directions : ${dirs.join(', ')}`);

    // 1. Listes (fenêtre fixe, pas de pagination côté serveur) → ids + contexte affiché.
    const listed = new Map(); // id → { id, dirs, row }
    for (const dir of dirs) {
        let html;
        try {
            html = await session.view('fights', { dir });
        } catch (e) {
            log.warn(`liste ${dir} : ${e.message}`);
            continue;
        }
        if (keepRaw) await writeText(`${config.paths.raw}/fights-${dir}.html`, html);

        const rows = await parseRows(session.page, html);
        for (const row of rows) {
            const entry = listed.get(row.id) || { id: row.id, dirs: [], row };
            if (!entry.dirs.includes(dir)) entry.dirs.push(dir);
            // Le résumé de ligne dépend de la direction (envoyé/reçu) : on garde celui du bon onglet.
            if (dir === 'sent' || !entry.row) entry.row = { ...row, dir };
            listed.set(row.id, entry);
        }
        log.info(`${dir} : ${rows.length} combat(s) dans la fenêtre`);
        await sleep(config.requestDelayMs);
    }

    // 2. Détails manquants seulement.
    const toFetch = [...listed.values()].filter((e) => refresh || !store.fights[e.id] || !store.fights[e.id].detail);
    log.info(`${listed.size} combat(s) listé(s), ${toFetch.length} à télécharger${refresh ? ' (--refresh)' : ''}`);

    let ok = 0;
    let failed = 0;
    for (const [i, entry] of toFetch.entries()) {
        const res = await session.json(`play/fight?id=${encodeURIComponent(entry.id)}`);
        if (!res.ok || !res.data || res.data.ok === false || !res.data.fight) {
            failed += 1;
            log.warn(`combat ${entry.id} : HTTP ${res.status}${res.data && res.data.error ? ` — ${res.data.error}` : ''}`);
        } else {
            const previous = store.fights[entry.id] || {};
            store.fights[entry.id] = {
                id: entry.id,
                dirs: entry.dirs,
                summary: summarize(entry.row, res.data.fight),
                list: entry.row || null,
                firstSeenAt: previous.firstSeenAt || new Date().toISOString(),
                fetchedAt: new Date().toISOString(),
                detail: {
                    fight: res.data.fight,
                    names: res.data.names || {},
                    imgs: res.data.imgs || {},
                    res: res.data.res || {},
                },
            };
            ok += 1;
        }
        if ((i + 1) % 10 === 0 || i + 1 === toFetch.length) log.dim(`détails : ${i + 1}/${toFetch.length}`);
        await sleep(config.requestDelayMs);
    }

    // Les combats déjà connus gardent leur détail, mais on rafraîchit leur appartenance aux listes.
    for (const entry of listed.values()) {
        const stored = store.fights[entry.id];
        if (stored && !refresh) stored.dirs = [...new Set([...(stored.dirs || []), ...entry.dirs])];
    }

    store.version = STORE_VERSION;
    store.updatedAt = new Date().toISOString();
    store.account = (session.boot && session.boot.player && session.boot.player.name) || null;
    store.counts = countByDir(store.fights);
    await writeJson(config.paths.fights, store);

    const total = Object.keys(store.fights).length;
    log.pass(`${ok} combat(s) téléchargé(s), ${failed} en échec`);
    log.pass(`${total} combat(s) en base (+${total - knownBefore} depuis le dernier run) → ${config.paths.fights}`);
    log.dim(`répartition : ${JSON.stringify(store.counts)}`);

    return { listed: listed.size, downloaded: ok, failed, total, store };
}

/** Onglets de la vue : on lit les directions proposées par le serveur plutôt que de les deviner. */
async function resolveDirections(session) {
    if (process.env.SSS_DIRS) return process.env.SSS_DIRS.split(',').map((s) => s.trim()).filter(Boolean);
    try {
        const html = await session.view('fights', {});
        const dirs = await session.page.evaluate((raw) => {
            const tpl = document.createElement('template');
            tpl.innerHTML = raw;
            const out = [];
            tpl.content.querySelectorAll('[data-params]').forEach((el) => {
                try {
                    const p = JSON.parse(el.dataset.params);
                    if (p && typeof p.dir === 'string' && !out.includes(p.dir)) out.push(p.dir);
                } catch (e) { /* data-params non JSON */ }
            });
            return out;
        }, html);
        if (dirs.length) return dirs;
    } catch (e) {
        log.warn(`directions non détectées (${e.message}) : repli sur ${FALLBACK_DIRS.join(', ')}`);
    }
    return FALLBACK_DIRS;
}

/** Lignes de combat d'une liste. Le DOM du navigateur fait l'analyse (pas de regex sur du HTML).
   Markup d'une ligne : li.fh-row(.is-win|.is-loss) › bouton profil (data-view=profile,
   data-params={id}) › .fh-main (fh-name, fh-result, fh-delta, fh-ago, fh-loot) › fh-btns. */
async function parseRows(page, html) {
    return page.evaluate((raw) => {
        const tpl = document.createElement('template');
        tpl.innerHTML = raw;
        const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null);
        const rows = [];

        tpl.content.querySelectorAll('li.fh-row, [data-fight-replay]').forEach((node) => {
            const li = node.matches('li.fh-row') ? node : node.closest('li.fh-row') || node.parentElement;
            const replay = li.querySelector('[data-fight-replay]');
            const ref = replay && replay.getAttribute('data-fight-replay');
            // « tmp: » / « share: » (combats volatils) ne sont pas des entrées d'historique.
            if (!ref || !/^\d+$/.test(ref)) return;

            // Adversaire : le lien de profil de la ligne.
            let opponentId = null;
            const prof = li.querySelector('[data-view="profile"][data-params]');
            if (prof) { try { opponentId = JSON.parse(prof.dataset.params).id ?? null; } catch (e) { /* non JSON */ } }

            // Butin / pertes : une entrée par ressource affichée.
            const loot = [];
            li.querySelectorAll('.fh-loot > span').forEach((s) => {
                const img = s.querySelector('img.fh-res');
                const key = img ? (img.getAttribute('src') || '').match(/res\/([a-z]+)\./)?.[1] : null;
                const land = s.classList.contains('fh-land') || s.querySelector('.fh-land');
                loot.push({ res: land ? 'land' : (key || null), value: text(s) });
            });

            rows.push({
                id: Number(ref),
                outcome: li.classList.contains('is-win') ? 'win' : li.classList.contains('is-loss') ? 'loss' : null,
                opponent: { id: opponentId, name: text(li.querySelector('.fh-name')) },
                result: text(li.querySelector('.fh-result')),
                delta: text(li.querySelector('.fh-delta')),
                ago: text(li.querySelector('.fh-ago')),
                loot,
                revenge: Boolean(li.querySelector('.fh-revenge, [data-view="attack"]')),
            });
        });

        // Un id = une entrée (une ligne peut porter plusieurs boutons).
        const seen = new Set();
        return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
    }, html);
}

/** Résumé stable et lisible d'un combat, croisant la ligne listée et le détail serveur. */
function summarize(row, fight) {
    const rep = (fight && fight.report) || {};
    const result = rep.result || {};
    const role = fight && fight.role; // 'att' = j'attaque, 'def' = je défends
    const me = role === 'att' ? rep.att : rep.def;
    const foe = role === 'att' ? rep.def : rep.att;
    const won = result.winner ? result.winner === role : (row && row.outcome === 'win') || null;
    return {
        role: role || null,
        won,
        me: me ? { id: me.id, name: me.name, level: me.level } : null,
        opponent: foe ? { id: foe.id, name: foe.name, level: foe.level } : (row && row.opponent) || null,
        at: rep.at || (fight && fight.arriveAt) || null,
        ago: row && row.ago,
        delta: (row && row.delta) || (result.rating ? result.rating.delta : null),
        loot: (row && row.loot) || [],
        buildingsRaided: Array.isArray(result.raid) ? result.raid.length : 0,
    };
}

function countByDir(fights) {
    const counts = {};
    for (const f of Object.values(fights)) {
        for (const dir of f.dirs || ['?']) counts[dir] = (counts[dir] || 0) + 1;
    }
    return counts;
}
