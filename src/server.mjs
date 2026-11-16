import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { GameSession } from './client.mjs';
import { syncFights } from './fights.mjs';
import { syncTroops } from './troops.mjs';
import { exportRules } from './rules.mjs';
import { loadAnalysis } from './analyse.mjs';
import { backtest, recommend } from './sim.mjs';
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
        const restore = captureLog((line) => {
            lines.push(line);
            push('progress', { task: name, line });
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
        const [fights, troops] = await Promise.all([
            readJson(config.paths.fights),
            readJson(config.paths.troops),
        ]);
        const docs = await listDocs();
        return json(res, 200, {
            ok: true,
            busy,
            account: fights?.account || troops?.account || null,
            level: troops?.accountLevel ?? null,
            crew: troops?.crew || null,
            fights: {
                count: Object.keys(fights?.fights || {}).length,
                updatedAt: fights?.updatedAt || null,
                counts: fights?.counts || null,
            },
            troops: {
                count: Object.keys(troops?.units || {}).length,
                detailed: Object.values(troops?.units || {}).filter((u) => u.detailed).length,
                updatedAt: troops?.updatedAt || null,
                locale: troops?.gameLocale || null,
            },
            docs,
        });
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
        const troops = await readJson(config.paths.troops);
        return json(res, 200, { ok: true, analysis, backtest: troops ? backtest(analysis, troops) : null });
    }

    if (route === 'compos') {
        const analysis = await loadAnalysis();
        if (analysis.empty) return json(res, 200, { ok: true, empty: true, reason: analysis.reason });
        const troops = await readJson(config.paths.troops);
        if (!troops) throw httpError(409, 'Aucune fiche de troupe : lance « Relever les troupes » d’abord.');
        const crew = troops.crew || {};
        const slots = Number(url.searchParams.get('slots')) || crew.slots || analysis.fights[0]?.army.mine.qty || 100;
        const maxTypes = Number(url.searchParams.get('types')) || crew.typeSlots || 4;
        const defReadiness = clamp(Number(url.searchParams.get('readiness')) || defaultReadiness(analysis), 0.1, 1);
        const bt = backtest(analysis, troops);
        const result = recommend({
            analysis,
            troops,
            slots,
            maxTypes,
            keep: 8,
            threshold: bt.threshold,
            readiness: { attack: 1, defense: defReadiness },
        });
        return json(res, 200, { ok: true, compos: result, backtest: bt, readiness: defReadiness });
    }

    if (req.method !== 'POST') throw httpError(405, 'Méthode non autorisée.');

    if (route === 'fetch-fights') {
        const refresh = url.searchParams.get('refresh') === '1';
        return json(res, 200, await run('Récupération des combats', () => withGame((s) => syncFights(s, { refresh }))));
    }
    if (route === 'fetch-troops') {
        return json(res, 200, await run('Relevé des troupes', () => withGame((s) => syncTroops(s, {}))));
    }
    if (route === 'fetch-rules') {
        const locale = url.searchParams.get('locale') || 'fr';
        return json(res, 200, await run('Règles officielles', () => exportRules({ locale })));
    }

    throw httpError(404, `Route inconnue : ${route}`);
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

async function statics(url, res, web) {
    const name = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(web, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(web)) throw httpError(403, 'Chemin interdit.');
    const body = await fs.readFile(file).catch(() => null);
    if (!body) throw httpError(404, `${name} introuvable.`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
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
            onLine(`${kind} ${text}`);
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
