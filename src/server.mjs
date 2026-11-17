import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { GameSession } from './client.mjs';
import { syncFights, countFights, watermarks } from './fights.mjs';
import { syncTroops } from './troops.mjs';
import { syncSkills } from './skills.mjs';
import { exportRules } from './rules.mjs';
import { loadAnalysis } from './analyse.mjs';
import { syncEnemies } from './enemies.mjs';
import { syncAssets } from './assets.mjs';
import { syncHq } from './hq.mjs';
import { buildReport, buildFightReport } from './report.mjs';
import { measureCritMultiplier, measureCritRates } from './fightlog.mjs';
import {
    backtest, recommend, calibrateCrit, typeParams, composeArmy, bestAgainstFight,
    enemyArmyFromFight, myArmyOfFight, simulate, simulateMany, winChance, opponentFactors,
} from './sim.mjs';
import { log, readJson } from './util.mjs';

/* Serveur local : il sert l'interface de web/ et expose les mêmes traitements que la CLI.

   Les boutons qui touchent au jeu (combats, troupes) ouvrent un navigateur et se connectent : ils
   sont donc lents et ne doivent pas se chevaucher. Une seule tâche tourne à la fois (`busy`), et
   son avancement part en Server-Sent Events vers la page pour que l'attente reste lisible.

   Rien n'est exposé en écriture vers le jeu : le serveur lit, analyse et simule. */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
};

export async function serve({ port = 4173, host = '127.0.0.1' } = {}) {
    const web = path.join(config.root, 'web');
    const clients = new Set();
    let busy = null;

    const push = (event, data) => {
        const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) res.write(line);
    };

    /** Exécute une tâche unique, en relayant ses logs vers la page. */
    const run = async (name, fn) => {
        if (busy) throw httpError(409, `« ${busy} » est déjà en cours.`);
        busy = name;
        const lines = [];
        const restore = captureLog((entry) => {
            lines.push(entry);
            push('progress', { task: name, ...entry });
        });
        push('start', { task: name });
        try {
            const result = await fn();
            push('done', { task: name, result });
            return { ok: true, task: name, lines, result };
        } catch (e) {
            push('error', { task: name, message: e.message });
            throw e;
        } finally {
            restore();
            busy = null;
        }
    };

    /** Session de jeu ouverte le temps d'une tâche, puis refermée. */
    const withGame = async (fn) => {
        const session = await GameSession.open({});
        try {
            const how = await session.login();
            log.pass(`connecté (${how === 'session' ? 'session réutilisée' : 'formulaire'})`);
            return await fn(session);
        } finally {
            await session.close();
        }
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        try {
            if (url.pathname === '/api/events') return sse(res, clients);
            if (url.pathname.startsWith('/api/')) return await api(url, req, res, { run, withGame, busy });
            /* Les images du jeu vivent dans data/ avec le reste de l'archive, pas dans le dossier
               source : on les sert depuis là, sous le même préfixe que chez le jeu. */
            if (url.pathname.startsWith('/assets/')) {
                return await statics(url, res, config.paths.assets, '/assets', { immutable: true });
            }
            return await statics(url, res, web);
        } catch (e) {
            const status = e.status || 500;
            if (status >= 500) log.fail(`${url.pathname} : ${e.message}`);
            json(res, status, { ok: false, error: e.message });
        }
    });

    await new Promise((resolve) => server.listen(port, host, resolve));
    const address = `http://${host}:${port}`;
    log.title('Interface locale');
    log.pass(`ouvre ${address}`);
    log.dim('Ctrl+C pour arrêter.');
    return { server, address };
}

/* ---------- API ---------- */

async function api(url, req, res, { run, withGame, busy }) {
    const route = url.pathname.replace(/^\/api\//, '');

    if (route === 'state') {
        const [fights, troops, enemies, items, skills, assets, hq] = await Promise.all([
            readJson(config.paths.fights),
            readJson(config.paths.troops),
            readJson(config.paths.enemies),
            readJson(config.paths.items),
            readJson(config.paths.skills),
            readJson(config.paths.assetsManifest),
            readJson(config.paths.hq),
        ]);
        const docs = await listDocs();
        const lastRun = fights?.runs?.[fights.runs.length - 1] || null;
        return json(res, 200, {
            ok: true,
            busy,
            account: fights?.account || troops?.account || null,
            level: troops?.accountLevel ?? null,
            crew: troops?.crew || null,
            fights: {
                count: Object.keys(fights?.fights || {}).length,
                updatedAt: fights?.updatedAt || null,
                // Un fichier écrit par une version antérieure n'a ni compteurs ni repère de
                // reprise : on les recalcule à la lecture plutôt que d'afficher des trous.
                counts: fights?.counts?.total != null ? fights.counts : countFights(fights?.fights || {}),
                watermark: fights?.watermark || watermarks(fights?.fights || {}),
                window: fights?.window || null,
                // Ce que le dernier run a vu : c'est ce qui rend la reprise lisible depuis la page.
                lastRun: lastRun && {
                    at: lastRun.at, mode: lastRun.mode, listed: lastRun.listed,
                    downloaded: lastRun.downloaded, failed: lastRun.failed, holes: lastRun.holes || [],
                },
                holes: (fights?.runs || []).flatMap((r) => r.holes || []),
            },
            troops: {
                count: Object.keys(troops?.units || {}).length,
                detailed: Object.values(troops?.units || {}).filter((u) => u.detailed).length,
                updatedAt: troops?.updatedAt || null,
                locale: troops?.gameLocale || null,
            },
            enemies: {
                count: enemies?.counts?.enemies ?? 0,
                observations: enemies?.counts?.observations ?? 0,
                changes: enemies?.counts?.changes ?? 0,
                updatedAt: enemies?.updatedAt || null,
                stale: Boolean(enemies && fights && enemies.source?.fightsUpdatedAt !== fights.updatedAt),
            },
            items: { count: items?.counts?.items ?? 0, updatedAt: items?.updatedAt || null },
            assets: assets && { count: Object.keys(assets.files || {}).length, counts: assets.counts, updatedAt: assets.updatedAt },
            hq: hq && {
                level: hq.level?.level, skillPoints: hq.skillPoints, rating: hq.rating,
                buildings: hq.summary?.total, works: hq.summary?.works,
                full: (hq.resources || []).filter((r) => r.full).map((r) => r.key),
                updatedAt: hq.updatedAt,
                /* La barre de ressources est affichée en permanence, donc servie avec l'état
                   global plutôt que par un appel dédié : une requête au lieu de deux. */
                resources: (hq.resources || []).filter((r) => r.value != null).map((r) => ({
                    key: r.key, fr: r.fr, icon: r.icon, value: r.value, cap: r.cap,
                    perTurn: r.perTurn, pct: r.pct, full: r.full,
                })),
                crew: hq.crew ? { troops: hq.crew.troops?.n, troopsCap: hq.crew.troops?.cap } : null,
            },
            skills: skills && {
                spent: skills.spent, toSpend: skills.toSpend, charLevel: skills.char?.level,
                bonuses: skills.bonuses, updatedAt: skills.updatedAt,
            },
            docs,
        });
    }

    /* Liste des adversaires : on ne renvoie jamais les relevés d'armée complets ici (ils pèsent
       l'essentiel du fichier). La page demande le détail d'un seul adversaire à la fois. */
    if (route === 'enemies') {
        const store = await readJson(config.paths.enemies);
        if (!store) {
            return json(res, 200, {
                ok: true,
                empty: true,
                reason: 'Aucune fiche d’adversaire : lance « Récupérer les combats » (la projection suit automatiquement).',
            });
        }
        const players = Object.values(store.players)
            .filter((p) => !p.isMe)
            .map((p) => summarizeEnemy(p))
            .sort((a, b) => b.record.fights - a.record.fights);
        return json(res, 200, {
            ok: true,
            updatedAt: store.updatedAt,
            account: store.account,
            counts: store.counts,
            me: store.players[store.account?.id] ? summarizeEnemy(store.players[store.account.id]) : null,
            players,
        });
    }

    if (route === 'enemy') {
        const id = url.searchParams.get('id');
        if (!/^\d+$/.test(id || '')) throw httpError(400, 'Identifiant d’adversaire invalide.');
        const store = await readJson(config.paths.enemies);
        const player = store?.players?.[id];
        if (!player) throw httpError(404, `Aucune fiche pour l’adversaire ${id}.`);
        return json(res, 200, { ok: true, updatedAt: store.updatedAt, player });
    }

    /* L'état du QG : ressources, bâtiments, niveau, points de compétence. */
    if (route === 'hq') {
        const hq = await readJson(config.paths.hq);
        if (!hq) return json(res, 200, { ok: true, empty: true, reason: 'QG non relevé : lance « Mettre à jour ».' });
        return json(res, 200, { ok: true, ...hq });
    }

    /* Un combat et son journal, pour l'afficher coup par coup. Le journal vient du jeu : lui seul
       marque les coups critiques et compte les unités mises KO. */
    if (route === 'fight') {
        const id = url.searchParams.get('id');
        if (!/^\d+$/.test(id || '')) throw httpError(400, 'Identifiant de combat invalide.');
        const fights = await readJson(config.paths.fights);
        const entry = fights?.fights?.[id];
        if (!entry) throw httpError(404, `Aucun combat ${id} en base.`);
        const analysis = await loadAnalysis();
        const row = analysis.empty ? null : analysis.fights.find((f) => f.id === Number(id));
        return json(res, 200, {
            ok: true,
            id: Number(id),
            summary: entry.summary || null,
            fight: row && {
                at: row.at, role: row.role, won: row.won, seconds: row.seconds, delta: row.delta,
                opponent: row.opponent, fort: row.fort, abOn: row.abOn, abOnTheirs: row.abOnTheirs,
                myPiles: row.myPiles, theirPiles: row.theirPiles, army: row.army, raid: row.raid, loot: row.loot,
            },
            log: entry.log || null,
        });
    }

    /* Le compte rendu Markdown. Servi en texte brut : la page le propose au téléchargement et à la
       copie, un agent IA peut aussi le récupérer directement à cette adresse. */
    if (route === 'report.md') {
        const md = await buildReport();
        res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `inline; filename="sss-rapport-${new Date().toISOString().slice(0, 10)}.md"`,
            'Cache-Control': 'no-store',
        });
        return res.end(md);
    }

    /* Le compte rendu Markdown d'UN combat : tout ce que la fiche affiche, plus l'avis du
       simulateur (probabilité, meilleure compo possible) — à coller dans une conversation avec
       un agent IA pour lui demander pourquoi, et quoi changer. */
    if (route === 'fight.md') {
        const id = url.searchParams.get('id');
        if (!/^\d+$/.test(id || '')) throw httpError(400, 'Identifiant de combat invalide.');
        const [fights, troops, skills] = await Promise.all([
            readJson(config.paths.fights), readJson(config.paths.troops), readJson(config.paths.skills),
        ]);
        const analysis = await loadAnalysis();
        if (analysis.empty) throw httpError(409, analysis.reason);
        const row = analysis.fights.find((f) => f.id === Number(id));
        if (!row) throw httpError(404, `Aucun combat ${id} en base.`);
        const log = fights?.fights?.[id]?.log || null;
        const learned = troops
            ? (learnedSummary(analysis, troops, skills).find((o) => o.id === row.opponent.id) || null)
            : null;

        let sim = null;
        if (troops) {
            const critMult = (await fittedCrit(analysis, troops, skills)) ?? 1.5;
            const params = typeParams(troops, analysis);
            const factors = opponentFactors(analysis, params, { talents: skills?.bonuses || null });
            const mine = myArmyOfFight(row, params, {
                talents: skills?.bonuses || null, critMult, factors, excludeSelf: true,
            });
            const theirs = enemyArmyFromFight(row, params, { role: row.role, factors, excludeSelf: true });
            const mcr = simulateMany(mine, theirs, { runs: 400, seed: row.id });
            const bt = backtest(analysis, troops, { skills, critMult });
            const actualReadiness = row.myPiles.reduce((a, p) => a + p.hp, 0)
                / (row.myPiles.reduce((a, p) => a + p.max, 0) || 1);
            const readiness = row.role === 'défense' ? actualReadiness : 1;
            const common = {
                analysis, troops, fight: row, critMult, skills,
                slots: troops.crew?.slots || 875, maxTypes: troops.crew?.typeSlots || 4,
            };
            const best = bestAgainstFight({ ...common, readiness, keep: 2 });
            let healed = null;
            if (row.role === 'défense' && readiness < 0.99) {
                const h = bestAgainstFight({ ...common, readiness: 1, keep: 1 });
                healed = h.empty ? null : h.best[0] || null;
            }
            sim = {
                mc: {
                    runs: mcr.runs,
                    pWin: Math.round(mcr.pWin * 1000) / 10,
                    margin: Math.round(mcr.margin.p50 * 1000) / 1000,
                },
                best: best.empty ? [] : best.best,
                screened: best.empty ? 0 : best.screened,
                healed,
                readiness,
                backtest: { accuracy: bt.accuracy, separation: bt.separation, brier: bt.brier },
            };
        }

        const md = buildFightReport({ fight: row, log, learned, sim });
        res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `inline; filename="sss-combat-${id}.md"`,
            'Cache-Control': 'no-store',
        });
        return res.end(md);
    }

    if (route === 'items') {
        const store = await readJson(config.paths.items);
        if (!store) return json(res, 200, { ok: true, empty: true, reason: 'Catalogue d’objets non construit.' });
        return json(res, 200, { ok: true, ...store });
    }

    if (route === 'doc') {
        const name = url.searchParams.get('name') || 'regles.md';
        if (!/^[a-z0-9_.-]+\.md$/i.test(name)) throw httpError(400, 'Nom de document invalide.');
        const file = path.join(config.paths.docs, name);
        const text = await fs.readFile(file, 'utf8').catch(() => null);
        if (text === null) throw httpError(404, `${name} n’existe pas encore : lance « Régénérer les règles ».`);
        return json(res, 200, { ok: true, name, markdown: text });
    }

    if (route === 'analyse') {
        const analysis = await loadAnalysis();
        if (analysis.empty) return json(res, 200, { ok: true, empty: true, reason: analysis.reason });
        const [troops, skills] = await Promise.all([readJson(config.paths.troops), readJson(config.paths.skills)]);
        return json(res, 200, {
            ok: true,
            analysis,
            // Ce que les journaux révèlent de chaque adversaire : facteur de dégâts (ses talents,
            // invisibles dans les PV), multiplicateur critique, taux de crit et de riposte mesurés.
            learned: troops ? learnedSummary(analysis, troops, skills) : [],
            skills: skills && { char: skills.char, spent: skills.spent, spentPerBranch: skills.spentPerBranch,
                bonuses: skills.bonuses, toSpend: skills.toSpend, updatedAt: skills.updatedAt,
                nodes: skills.nodes.filter((n) => n.points > 0) },
            backtest: troops ? backtest(analysis, troops, { skills, critMult: await fittedCrit(analysis, troops, skills) }) : null,
        });
    }

    if (route === 'skills') {
        const skills = await readJson(config.paths.skills);
        if (!skills) return json(res, 200, { ok: true, empty: true, reason: 'Arbre de talents non relevé : lance « Mettre à jour ».' });
        return json(res, 200, { ok: true, ...skills });
    }

    if (route === 'compos') {
        const analysis = await loadAnalysis();
        if (analysis.empty) return json(res, 200, { ok: true, empty: true, reason: analysis.reason });
        const [troops, skills] = await Promise.all([readJson(config.paths.troops), readJson(config.paths.skills)]);
        if (!troops) throw httpError(409, 'Aucune fiche de troupe : lance « Relever les troupes » d’abord.');
        const critMult = await fittedCrit(analysis, troops, skills);
        const crew = troops.crew || {};
        const slots = Number(url.searchParams.get('slots')) || crew.slots || analysis.fights[0]?.army.mine.qty || 100;
        const maxTypes = Number(url.searchParams.get('types')) || crew.typeSlots || 4;
        const defReadiness = clamp(Number(url.searchParams.get('readiness')) || defaultReadiness(analysis), 0.1, 1);
        const bt = backtest(analysis, troops, { skills, critMult });
        const search = (defense) => recommend({
            analysis, troops, slots, maxTypes, keep: 8, threshold: bt.threshold,
            readiness: { attack: 1, defense }, critMult,
        });
        const result = search(defReadiness);
        // Combien vaudrait la meilleure compo si tes troupes défendaient à pleine vie ? L'écart
        // chiffre ce que coûte le fait d'être attaqué avant la fin de la récupération.
        const healed = defReadiness >= 0.99 ? null : search(1).best?.[0] || null;
        return json(res, 200, { ok: true, compos: result, backtest: bt, readiness: defReadiness, healed });
    }

    /* Les types alignables, avec les stats qu'ils auraient aujourd'hui (talents et équipement
       compris, puisque ce sont les valeurs « réelles » de la carte). De quoi monter une
       composition dans la page sans rien recalculer côté navigateur. */
    if (route === 'types') {
        const analysis = await loadAnalysis();
        if (analysis.empty) return json(res, 200, { ok: true, empty: true, reason: analysis.reason });
        const troops = await readJson(config.paths.troops);
        if (!troops) throw httpError(409, 'Aucune fiche de troupe : lance « Mettre à jour » d’abord.');
        const params = typeParams(troops, analysis);
        const slots = troops.crew?.slots || null;
        return json(res, 200, {
            ok: true,
            slots,
            typeSlots: troops.crew?.typeSlots || 4,
            need: slots ? Math.ceil(slots * 0.1) : null,
            types: [...params.values()].map((t) => ({
                key: t.key, fr: t.fr, roleFr: t.roleFr, abilityFr: t.abilityFr, ability: t.ability,
                unitHp: Math.round(t.unitHp), dmgAvg: Math.round(t.dmgAvg),
                crit: t.crit, counter: t.counter, speed: t.speed,
                typeLevel: t.typeLevel, cost: t.cost,
                owned: troops.units?.[`troops/${t.key}`]?.owned || 0,
                typeXp: troops.units?.[`troops/${t.key}`]?.typeXp || null,
            })).sort((a, b) => b.dmgAvg / b.speed - a.dmgAvg / a.speed),
            current: Object.values(troops.units || {})
                .filter((u) => u.cat === 'troops' && u.owned > 0)
                .map((u) => ({ key: u.key, qty: u.owned })),
        });
    }

    /* Adversaires jouables : un par combat archivé. C'est contre ces armées-là, exactement telles
       qu'elles étaient, qu'on peut rejouer. */
    if (route === 'scenarios') {
        const analysis = await loadAnalysis();
        if (analysis.empty) return json(res, 200, { ok: true, empty: true, reason: analysis.reason });
        return json(res, 200, {
            ok: true,
            scenarios: analysis.fights.map((f) => ({
                fightId: f.id,
                at: f.at,
                role: f.role,
                won: f.won,
                opponent: f.opponent,
                fort: f.role === 'attaque' ? f.fort.theirs : f.fort.mine,
                army: {
                    qty: f.army.theirs.qty,
                    hp: f.army.theirs.hp,
                    types: f.theirPiles.filter((p) => !p.reinforcement).length,
                    piles: f.theirPiles.map((p) => ({
                        key: p.base, fr: p.base, qty: p.qty, reinforcement: p.reinforcement,
                    })),
                },
                mine: f.myPiles.filter((p) => !p.reinforcement).map((p) => ({ key: p.base, qty: p.qty })),
                readiness: f.myPiles.reduce((a, p) => a + p.hp, 0) / (f.myPiles.reduce((a, p) => a + p.max, 0) || 1),
            })),
        });
    }

    if (req.method !== 'POST') throw httpError(405, 'Méthode non autorisée.');

    /* Le simulateur : un duel joué coup par coup contre un adversaire réel de l'historique.
       Deux usages — rejouer un combat en changeant de composition, ou éprouver une composition
       montée de toutes pièces. Rien n'est envoyé au jeu : tout se calcule ici. */
    if (route === 'simulate') {
        return json(res, 200, await runSimulation(await readBody(req), url));
    }

    /* La meilleure composition contre UN combat précis : même adversaire, mêmes murs, même forme.
       Rendue sur la fiche du combat, avec sa probabilité de victoire au Monte-Carlo. */
    if (route === 'best-compo') {
        return json(res, 200, await runBestCompo(await readBody(req)));
    }

    if (route === 'fetch-fights') {
        const refresh = url.searchParams.get('refresh') === '1';
        // `syncFights` renvoie aussi toute la base en mémoire : inutile de la repousser au navigateur.
        return json(res, 200, await run('Récupération des combats', () => withGame(async (s) => {
            const { store, ...summary } = await syncFights(s, { refresh });
            return summary;
        })));
    }
    if (route === 'fetch-skills') {
        return json(res, 200, await run('Arbre de talents', () => withGame((s) => syncSkills(s, {}))));
    }
    if (route === 'fetch-troops') {
        return json(res, 200, await run('Relevé des troupes', () => withGame((s) => syncTroops(s, {}))));
    }
    if (route === 'fetch-rules') {
        const locale = url.searchParams.get('locale') || 'fr';
        return json(res, 200, await run('Règles officielles', () => exportRules({ locale })));
    }
    if (route === 'fetch-hq') {
        return json(res, 200, await run('Quartier général', () => withGame((s) => syncHq(s))));
    }
    if (route === 'fetch-assets') {
        const force = url.searchParams.get('force') === '1';
        return json(res, 200, await run('Images du jeu', () => syncAssets({ force })));
    }
    if (route === 'rebuild-enemies') {
        return json(res, 200, await run('Fiches d’adversaires', () => syncEnemies()));
    }

    /* Le geste courant : une seule tâche, une seule connexion au jeu, tout remis à jour dans le
       bon ordre (les combats d'abord, puisque les fiches d'adversaires en découlent). */
    if (route === 'update-all') {
        return json(res, 200, await run('Mise à jour complète', () => withGame(async (s) => {
            const { store, ...fights } = await syncFights(s, { project: true });
            const troops = await syncTroops(s, {});
            const skills = await syncSkills(s, {});
            const hq = await syncHq(s);
            // Les images sont publiques : pas besoin de la session, mais autant enchaîner ici.
            const assets = await syncAssets({});
            return { fights, troops, skills, hq, assets };
        })));
    }

    throw httpError(404, `Route inconnue : ${route}`);
}

/* Fiche d'adversaire sans ses relevés d'armée : identité, bilan, dernière composition connue et
   les dates de ses changements de troupes. De quoi remplir une liste sans transporter 1,5 Mo. */
function summarizeEnemy(p) {
    const latest = p.latest || null;
    return {
        id: p.id,
        name: p.name,
        aka: p.aka.length > 1 ? p.aka : [],
        avatar: p.avatar,
        isMe: p.isMe,
        span: p.span,
        level: { first: p.level.first, last: p.level.last, max: p.level.max, changes: p.level.history.length - 1 },
        rating: { last: p.rating.last, min: p.rating.min, max: p.rating.max },
        fort: { last: p.fort.last, max: p.fort.max },
        record: p.record,
        changes: p.changes.length,
        lastChangeAt: p.changes.length ? p.changes[p.changes.length - 1].at : null,
        changeKinds: [...new Set(p.changes.flatMap((c) => c.kinds))],
        latest: latest && {
            at: latest.at, fightId: latest.fightId, side: latest.side, fort: latest.fort,
            army: latest.army,
            abOn: latest.abOn,
            piles: latest.piles.map((x) => ({
                base: x.base, fr: x.fr, qty: x.qty, unitHp: x.unitHp, typeLevel: x.typeLevel,
                roleFr: x.roleFr, abilityFr: x.abilityFr, gear: x.gear, gearBonuses: x.gearBonuses,
                measured: x.measured,
            })),
            reinforcements: latest.reinforcements.length,
        },
    };
}

/* Les mesures apprises par adversaire, résumées pour l'affichage : qui tape plus fort que sa
   carte ne le laisse croire (ses talents de dégâts), qui a le critique amélioré. */
function learnedSummary(analysis, troops, skills) {
    const params = typeParams(troops, analysis);
    const factors = opponentFactors(analysis, params, { talents: skills?.bonuses || null });
    const names = new Map(analysis.fights.map((f) => [String(f.opponent.id), f.opponent]));
    const byOpp = new Map();
    for (const [key, entries] of factors) {
        const m = /^(\d+)\|(.+)$/.exec(key);
        if (!m || !names.has(m[1])) continue;
        const [, oppId, base] = m;
        const o = byOpp.get(oppId) || byOpp.set(oppId, { id: Number(oppId), name: names.get(oppId).name, avatar: names.get(oppId).avatar || null, types: [], critMults: [] }).get(oppId);
        const med = (field) => {
            const xs = entries.map((e) => e[field]).filter(Number.isFinite).sort((a, b) => a - b);
            return xs.length ? xs[xs.length >> 1] : null;
        };
        const factor = med('factor');
        o.types.push({
            base,
            fights: entries.length,
            factor: factor != null ? Math.round(factor * 100) / 100 : null,
            critRate: med('critRate'),
            counterRate: med('counterRate'),
        });
        const cm = med('critMult');
        if (cm != null) o.critMults.push(cm);
    }
    return [...byOpp.values()].map((o) => {
        const cm = o.critMults.sort((a, b) => a - b);
        const critMult = cm.length ? cm[cm.length >> 1] : null;
        const factors2 = o.types.map((t) => t.factor).filter(Number.isFinite);
        return {
            ...o,
            critMult: critMult != null ? (critMult >= 1.75 ? 2.0 : 1.5) : null,
            critMultMeasured: critMult != null ? Math.round(critMult * 100) / 100 : null,
            factorMedian: factors2.length ? Math.round(factors2.sort((a, b) => a - b)[factors2.length >> 1] * 100) / 100 : null,
            fights: Math.max(0, ...o.types.map((t) => t.fights)),
            critMults: undefined,
        };
    }).filter((o) => o.factorMedian != null || o.critMult != null)
        .sort((a, b) => (b.factorMedian || 0) - (a.factorMedian || 0));
}

/* ---------- Le simulateur ---------- */

/* La meilleure composition contre un combat archivé. En défense, la forme par défaut est celle
   que mes troupes avaient RÉELLEMENT ce jour-là : « gagner ce combat », c'est le gagner tel
   qu'il s'est présenté, pas avec une armée miraculeusement soignée. */
async function runBestCompo(body) {
    const analysis = await loadAnalysis();
    if (analysis.empty) throw httpError(409, analysis.reason);
    const [troops, skills] = await Promise.all([readJson(config.paths.troops), readJson(config.paths.skills)]);
    if (!troops) throw httpError(409, 'Aucune fiche de troupe : lance « Mettre à jour » d’abord.');

    const fight = analysis.fights.find((f) => f.id === Number(body.fightId));
    if (!fight) throw httpError(404, 'Combat inconnu dans l’archive.');

    const critMult = (await fittedCrit(analysis, troops, skills)) ?? 1.5;
    const slots = clamp(Number(body.slots) || troops.crew?.slots || 875, 10, 100000);
    const maxTypes = clamp(Number(body.types) || troops.crew?.typeSlots || 4, 1, 6);
    const actualReadiness = fight.myPiles.reduce((a, p) => a + p.hp, 0)
        / (fight.myPiles.reduce((a, p) => a + p.max, 0) || 1);
    const readiness = body.readiness != null
        ? clamp(Number(body.readiness), 0.1, 1)
        : (fight.role === 'défense' ? actualReadiness : 1);

    const result = bestAgainstFight({
        analysis, troops, fight, slots, maxTypes, readiness, critMult, skills,
    });
    if (result.empty) throw httpError(409, result.reason);

    /* En défense avec des troupes entamées, la question jumelle : et si elles avaient été
       soignées ? L'écart entre les deux chiffre ce que coûte la récupération inachevée. */
    let healed = null;
    if (fight.role === 'défense' && readiness < 0.99) {
        const h = bestAgainstFight({
            analysis, troops, fight, slots, maxTypes, readiness: 1, critMult, skills, keep: 1,
        });
        if (!h.empty) healed = h.best[0] || null;
    }

    return { ok: true, ...result, healed, critMult, opponent: fight.opponent, at: fight.at };
}

async function runSimulation(body) {
    const analysis = await loadAnalysis();
    if (analysis.empty) throw httpError(409, analysis.reason);
    const [troops, skills] = await Promise.all([readJson(config.paths.troops), readJson(config.paths.skills)]);
    if (!troops) throw httpError(409, 'Aucune fiche de troupe : lance « Mettre à jour » d’abord.');

    const params = typeParams(troops, analysis);
    const critMult = (await fittedCrit(analysis, troops, skills)) ?? 1.5;
    const slots = clamp(Number(body.slots) || troops.crew?.slots || 875, 10, 100000);

    // L'adversaire : un combat précis, ou le dernier croisé contre ce joueur.
    const fight = pickFight(analysis, body);
    if (!fight) throw httpError(404, 'Aucun combat archivé ne correspond à cet adversaire.');

    const role = body.role === 'attaque' || body.role === 'défense' ? body.role : fight.role;
    const readiness = body.readiness != null
        ? clamp(Number(body.readiness), 0.1, 1)
        : (role === 'défense' ? defaultReadiness(analysis) : 1);

    /* Les mesures apprises par adversaire (talents de dégâts, taux de critique et de riposte,
       multiplicateur critique) s'appliquent aux reconstructions : c'est ce qui a le plus fait
       progresser la justesse du rejeu (AUC 0,80 → 0,91). */
    const factors = opponentFactors(analysis, params, { talents: skills?.bonuses || null });
    const theirs = enemyArmyFromFight(fight, params, { role, factors });
    const mine = buildMine(body, fight, params, skills, {
        slots, critMult, readiness, factors,
        fort: role === 'défense' ? fight.fort.mine : 0,
        guard: role === 'défense' ? fight.guard : 0,
    });
    if (!mine.piles.length) throw httpError(400, 'Composition vide : mets au moins un type en jeu.');

    /* Le même duel, joué 600 fois avec de vrais tirages : la PROBABILITÉ de victoire, la
       distribution des marges et des durées — le jeu tire au hasard, le verdict est une part,
       pas un oui/non. Le déroulé affiché est la passe dont l'issue est la plus médiane. */
    const mc = simulateMany(mine, theirs, { runs: 600, seed: fight.id || 42, trace: true });
    const result = mc.median;

    /* Et la lecture « espérances » : déterministe, comparable d'une compo à l'autre. */
    const expected = simulate(mine, theirs, { trace: false });

    const bt = backtest(analysis, troops, { skills, critMult });
    const chance = winChance(bt.rows, expected.margin);

    /* « Et contre tous les autres ? » — une composition qui gagne un duel peut perdre le reste de
       l'historique. On le dit dans la même réponse, sans trace (ce serait énorme et inutile). */
    let record = null;
    if (body.all !== false && mine.spec) {
        record = scoreEverywhere(analysis, params, mine.spec, {
            slots, critMult, readiness, threshold: bt.threshold, factors,
        });
    }

    return {
        ok: true,
        setup: {
            fightId: fight.id,
            at: fight.at,
            role,
            opponent: fight.opponent,
            fort: { mine: role === 'défense' ? fight.fort.mine : 0, theirs: role === 'attaque' ? fight.fort.theirs : 0 },
            guard: role === 'défense' ? fight.guard : 0,
            readiness,
            slots,
            need: mine.need,
            critMult,
            source: mine.source,
        },
        mine: armySummary(mine, { slots }),
        theirs: armySummary(theirs),
        result: {
            winner: result.winner,
            iWon: result.winner === 'A',
            margin: Math.round(expected.margin * 1000) / 1000,
            seconds: result.seconds,
            timeout: result.timeout,
            left: result.left,
            piles: result.piles,
            abilities: result.abilities,
            trace: result.trace,
            // Le verdict principal : la part de victoires sur 600 tirages réels.
            monteCarlo: {
                runs: mc.runs,
                wins: mc.wins,
                pWin: Math.round(mc.pWin * 1000) / 10,
                margin: {
                    p10: Math.round(mc.margin.p10 * 1000) / 1000,
                    p50: Math.round(mc.margin.p50 * 1000) / 1000,
                    p90: Math.round(mc.margin.p90 * 1000) / 1000,
                },
                seconds: mc.seconds,
                left: { A: Math.round(mc.left.A * 1000) / 1000, B: Math.round(mc.left.B * 1000) / 1000 },
            },
            // Et la lecture historique : la part des combats comparables réellement gagnés.
            chance,
            threshold: bt.threshold[role] ?? 0,
            calibration: bt.calibration,
            accuracy: bt.accuracy,
        },
        // Ce qui s'est réellement passé ce jour-là, quand on rejoue un vrai combat.
        real: {
            won: fight.won,
            seconds: fight.seconds,
            myPiles: fight.myPiles.filter((p) => !p.reinforcement)
                .map((p) => ({ key: p.base, fr: params.get(p.base)?.fr || p.base, qty: p.qty, dealt: p.dealt })),
            delta: fight.delta,
        },
        record,
    };
}

/** Le combat visé : par id, sinon le plus récent contre ce joueur. */
function pickFight(analysis, body) {
    const o = body.opponent || {};
    if (o.fightId != null) return analysis.fights.find((f) => f.id === Number(o.fightId)) || null;
    if (o.playerId != null) {
        return analysis.fights.filter((f) => f.opponent.id === Number(o.playerId))
            .sort((a, b) => b.at - a.at)[0] || null;
    }
    return analysis.fights[0] || null;
}

/* Mon camp, selon trois origines possibles :
   — `custom`   : la composition montée dans la page ;
   — `current`  : ce que j'ai en ligne en ce moment (troupes possédées) ;
   — `historic` : ce que j'avais engagé ce jour-là, reconstruit comme dans le backtest. */
function buildMine(body, fight, params, skills, opts) {
    const mode = body.mine?.mode || (body.mine?.piles ? 'custom' : 'current');

    if (mode === 'historic') {
        const a = myArmyOfFight(fight, params, {
            talents: skills?.bonuses || null, critMult: opts.critMult,
            factors: opts.factors || null, excludeSelf: true,
        });
        a.source = 'ta composition de ce jour-là, avec ses PV réels d’alors';
        a.spec = null; // les PV d'époque ne se rejouent pas ailleurs
        return a;
    }

    const spec = mode === 'custom'
        ? (body.mine.piles || []).map((p) => ({ key: String(p.key), qty: Math.max(0, Number(p.qty) || 0) }))
        : currentSpec(params, body);
    const a = composeArmy(spec, params, opts);
    a.source = mode === 'custom' ? 'composition montée à la main' : 'ta composition actuelle';
    a.spec = spec.filter((p) => p.qty > 0);
    return a;
}

function currentSpec(params, body) {
    return (body.current || []).map((p) => ({ key: String(p.key), qty: Number(p.qty) || 0 }))
        .filter((p) => p.qty > 0 && params.has(p.key));
}

/** La même composition jouée contre tous les combats archivés : le duel ne suffit pas à juger. */
function scoreEverywhere(analysis, params, spec, { slots, critMult, readiness, threshold, factors = null }) {
    let wins = 0;
    const perRole = { attaque: { wins: 0, fights: 0 }, défense: { wins: 0, fights: 0 } };
    for (const f of analysis.fights) {
        const ready = f.role === 'défense' ? readiness : 1;
        const mine = composeArmy(spec, params, {
            slots, critMult, readiness: ready,
            fort: f.role === 'défense' ? f.fort.mine : 0,
            guard: f.role === 'défense' ? f.guard : 0,
        });
        const r = simulate(mine, enemyArmyFromFight(f, params, { role: f.role, factors }));
        const won = r.margin > (threshold?.[f.role] ?? 0);
        if (won) wins += 1;
        perRole[f.role].fights += 1;
        if (won) perRole[f.role].wins += 1;
    }
    const n = analysis.fights.length;
    return {
        wins,
        fights: n,
        winRate: n ? Math.round((1000 * wins) / n) / 10 : 0,
        attack: perRole.attaque,
        defense: perRole.défense,
    };
}

function armySummary(a, { slots = null } = {}) {
    const qty = a.piles.reduce((s, p) => s + p.qty, 0);
    return {
        qty,
        slots,
        // Une composition peut dépasser les places disponibles : le simulateur la joue quand même,
        // mais le résultat n'est alors pas transposable en jeu. On le signale plutôt que de le taire.
        over: slots != null ? Math.max(0, qty - slots) : 0,
        maxHp: Math.round(a.maxHp),
        startHp: Math.round(a.startHp),
        need: a.need,
        fort: a.fort,
        guard: a.guard,
        abilities: a.abilities,
        unknown: a.unknown || [],
        piles: a.piles.map((p) => ({
            key: p.key, fr: p.fr || p.key, qty: p.qty,
            unitHp: Math.round(p.unitHp), maxHp: Math.round(p.max ?? p.maxHp ?? 0),
            dmgAvg: Math.round(p.dmgAvg), crit: p.crit, counter: p.counter, speed: p.speed,
            roleFr: p.roleFr, abilityFr: p.abilityFr, abilityOn: p.abilityOn,
            dps: Math.round((p.qty * p.dmgAvg) / (p.speed || 1)),
        })),
    };
}

/* Multiplicateur des coups critiques de mon camp.

   Le journal rédigé par le jeu marque les coups critiques : on le **mesure** donc, en comparant
   une pile à elle-même (ses coups critiques contre ses coups normaux, dans le même combat). Tant
   qu'aucun journal n'est en base, on retombe sur le calage par rejeu de l'historique — qui, lui,
   sur-ajuste : il préférait ×2,25 là où la mesure donne ×2,0. */
async function fittedCrit(analysis, troops, skills) {
    if (!troops) return undefined;
    const fights = await readJson(config.paths.fights);
    const measured = measureCritMultiplier(fights, analysis.account?.id);
    if (measured.mine && measured.samples.mine >= 10) return measured.mine;
    return skills ? calibrateCrit(analysis, troops, skills).best.critMult : undefined;
}

/** Taux de forme des troupes en défense, mesuré sur l'historique (PV au départ / PV max). */
function defaultReadiness(analysis) {
    const xs = analysis.fights.filter((f) => f.role === 'défense')
        .map((f) => f.myPiles.reduce((a, p) => a + p.hp, 0) / (f.myPiles.reduce((a, p) => a + p.max, 0) || 1))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    return xs.length ? xs[xs.length >> 1] : 1;
}

/* ---------- Transport ---------- */

function sse(res, clients) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.on('close', () => clients.delete(res));
}

async function statics(url, res, root, prefix = '', { immutable = false } = {}) {
    let name = url.pathname === '/' ? '/index.html' : url.pathname;
    if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length) || '/';
    const file = path.join(root, path.normalize(decodeURIComponent(name)).replace(/^(\.\.[/\\])+/, ''));
    // Le séparateur compte : sans lui, un dossier voisin nommé « web-autre » passerait le test.
    if (file !== root && !file.startsWith(root + path.sep)) throw httpError(403, 'Chemin interdit.');
    const body = await fs.readFile(file).catch(() => null);
    if (!body) throw httpError(404, `${name} introuvable.`);
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        /* Les images du jeu ne changent jamais sous un même nom (les avatars portent un condensat),
           donc on les laisse en cache. Le reste est du code qu'on modifie en le regardant tourner :
           sans `no-store`, une feuille de style retouchée ne se verrait qu'après rechargement forcé. */
        'Cache-Control': immutable ? 'public, max-age=604800' : 'no-store',
    });
    res.end(body);
}

/* Le serveur n'avait jamais eu besoin de lire un corps de requête : le simulateur, lui, reçoit
   une composition entière. On plafonne la taille — c'est un serveur local, pas une passoire. */
const MAX_BODY = 256 * 1024;

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw httpError(413, 'Requête trop volumineuse.');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) || {};
    } catch (e) {
        throw httpError(400, `Corps de requête illisible : ${e.message}`);
    }
}

function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
}

async function listDocs() {
    const names = await fs.readdir(config.paths.docs).catch(() => []);
    const docs = [];
    for (const name of names.filter((n) => n.endsWith('.md'))) {
        const st = await fs.stat(path.join(config.paths.docs, name)).catch(() => null);
        if (st) docs.push({ name, size: st.size, updatedAt: st.mtime.toISOString() });
    }
    return docs.sort((a, b) => a.name.localeCompare(b.name));
}

/* Les modules existants écrivent leur avancement avec `log` : on l'intercepte le temps d'une
   tâche pour le renvoyer à la page, tout en le laissant s'afficher dans le terminal. */
function captureLog(onLine) {
    const kinds = ['title', 'info', 'dim', 'pass', 'fail', 'warn'];
    const original = {};
    for (const kind of kinds) {
        original[kind] = log[kind];
        log[kind] = (text) => {
            onLine({ kind, text: String(text) });
            original[kind](text);
        };
    }
    return () => Object.assign(log, original);
}

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
