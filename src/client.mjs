import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { config, assertCredentials } from './config.mjs';
import { log } from './util.mjs';

/* Le jeu est une SPA : l'état initial arrive dans <script type="application/json" id="boot">
   ({ state: 'guest' | 'onboarding' | 'game', player, csrf, ... }) et toutes les vues/actions
   passent par des requêtes marquées X-Requested-With: fetch. On s'appuie sur ces faits plutôt
   que sur l'apparence des écrans — c'est stable et ça évite de piloter des animations.

   Attention : #boot n'est PAS réécrit après une connexion côté client (il garde state=guest).
   L'état vivant, c'est document.body.dataset.state, et GET /play/state qui renvoie le boot à
   jour ({ ok, boot, stage }) — c'est ce que la SPA elle-même relit après chaque action. */

const FETCH_HEADERS = { 'X-Requested-With': 'fetch' };

export class GameSession {
    constructor({ browser, context, page, diagnostics }) {
        this.browser = browser;
        this.context = context;
        this.page = page;
        this.diagnostics = diagnostics;
        this.boot = null;
    }

    /** Ouvre Chromium, branche la collecte d'erreurs et charge /play (session réutilisée si dispo). */
    static async open({ fresh = false } = {}) {
        const browser = await chromium.launch({ headless: !config.headed });
        const storageState = fresh ? undefined : await loadState();
        const context = await browser.newContext({
            storageState,
            locale: config.locale,
            viewport: { width: 1280, height: 900 },
            // Le jeu sert une interface différente selon la taille : on reste sur le rendu "desktop".
            deviceScaleFactor: 1,
        });
        context.setDefaultTimeout(config.timeoutMs);
        const page = await context.newPage();
        const diagnostics = attachDiagnostics(page);
        const session = new GameSession({ browser, context, page, diagnostics });
        session.firstResponse = null;
        page.once('response', (res) => { session.firstResponse = res; });
        await page.goto(`${config.baseUrl}/play`, { waitUntil: 'domcontentloaded' });
        session.boot = await session.readBoot();
        return session;
    }

    /** État initial injecté par le serveur dans la page (valable au chargement seulement). */
    async readBoot() {
        return this.page.evaluate(() => {
            const el = document.getElementById('boot');
            if (!el) return null;
            try { return JSON.parse(el.textContent); } catch (e) { return null; }
        });
    }

    /** État vivant tenu par la SPA sur <body data-state="…">. */
    async bodyState() {
        return this.page.evaluate(() => document.body.dataset.state || null);
    }

    /** Boot à jour depuis le serveur (GET /play/state) : la référence après une connexion. */
    async fetchState() {
        const res = await this.json('play/state');
        if (res.ok && res.data && res.data.ok && res.data.boot) this.boot = res.data.boot;
        return res;
    }

    get loggedIn() {
        return Boolean(this.boot && this.boot.state !== 'guest' && this.boot.player);
    }

    /** Connecte le compte si besoin. Retourne 'session' (cookie réutilisé) ou 'login'. */
    async login() {
        if (this.loggedIn) return 'session';

        assertCredentials();
        const form = this.page.locator('form[data-form][action="/play/login"]');
        await form.waitFor({ state: 'visible' });
        await form.locator('input[name="email"]').fill(config.email);
        await form.locator('input[name="password"]').fill(config.password);
        await form.locator('button[type="submit"]').click();

        // Deux issues possibles : <body data-state> quitte 'guest' (la SPA a monté le jeu),
        // ou le formulaire affiche son message d'erreur. On attend la première qui vient.
        const errorBox = form.locator('.form-error');
        const onGame = this.page
            .waitForFunction(() => {
                const state = document.body.dataset.state;
                return Boolean(state) && state !== 'guest';
            }, null, { timeout: config.timeoutMs })
            .then(() => 'game', () => null);
        const onError = errorBox
            .waitFor({ state: 'visible', timeout: config.timeoutMs })
            .then(() => 'error', () => null);

        let outcome = await Promise.race([onGame, onError]);
        if (!outcome) outcome = (await Promise.all([onGame, onError])).find(Boolean) || null;

        if (outcome !== 'game') {
            const message = await errorBox.textContent().catch(() => null);
            throw new Error(`Connexion refusée : ${(message || '').trim() || 'aucune réponse de /play/login'}`);
        }

        // #boot est resté sur l'état d'avant connexion : on relit l'état réel côté serveur.
        await this.fetchState();
        await this.saveState();
        return 'login';
    }

    /** Session gardée pour les runs suivants : plus besoin de rejouer le formulaire à chaque fois. */
    async saveState() {
        await fs.mkdir(config.paths.out, { recursive: true });
        await this.context.storageState({ path: config.paths.state });
    }

    /** Vue AJAX du jeu (HTML) : /play/view/<name>?<params> */
    async view(name, params = {}) {
        const qs = new URLSearchParams(params).toString();
        const url = `${config.baseUrl}/play/view/${name}${qs ? `?${qs}` : ''}`;
        const res = await this.page.request.get(url, { headers: FETCH_HEADERS });
        const body = await res.text();
        if (!res.ok()) throw new Error(`GET ${url} → HTTP ${res.status()}`);
        // Le serveur répond en JSON quand il refuse la vue ({ error } ou { view } en 409).
        if ((res.headers()['content-type'] || '').includes('application/json')) {
            const data = JSON.parse(body || '{}');
            throw new Error(`Vue « ${name} » refusée : ${data.error || JSON.stringify(data)}`);
        }
        return body;
    }

    /** Endpoint JSON du jeu (ex. play/fight?id=42, play/pulse). */
    async json(pathAndQuery) {
        const url = `${config.baseUrl}/${pathAndQuery.replace(/^\/+/, '')}`;
        const res = await this.page.request.get(url, { headers: FETCH_HEADERS });
        const body = await res.text();
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch (e) { data = null; }
        return { status: res.status(), ok: res.ok(), data, raw: body };
    }

    async screenshot(name) {
        await fs.mkdir(config.paths.out, { recursive: true });
        const file = `${config.paths.out}/${name}.png`;
        await this.page.screenshot({ path: file, fullPage: false });
        return file;
    }

    async close() {
        await this.context.close().catch(() => {});
        await this.browser.close().catch(() => {});
    }
}

/* ---------- Erreurs console & réseau ---------- */

function attachDiagnostics(page) {
    const diagnostics = { consoleErrors: [], consoleWarnings: [], pageErrors: [], httpErrors: [], failedRequests: [] };

    page.on('console', (msg) => {
        const entry = { text: msg.text(), location: msg.location()?.url || null };
        if (msg.type() === 'error') diagnostics.consoleErrors.push(entry);
        else if (msg.type() === 'warning') diagnostics.consoleWarnings.push(entry);
    });
    page.on('pageerror', (err) => diagnostics.pageErrors.push({ text: String(err && err.message || err) }));
    page.on('requestfailed', (req) => {
        // Les requêtes annulées par la navigation ne sont pas des pannes.
        const failure = req.failure()?.errorText || '';
        if (/ERR_ABORTED/.test(failure)) return;
        diagnostics.failedRequests.push({ url: req.url(), method: req.method(), error: failure });
    });
    page.on('response', (res) => {
        const status = res.status();
        if (status < 400) return;
        // 401/403 avant connexion = normal (le jeu sonde l'état de session).
        diagnostics.httpErrors.push({ url: res.url(), status, method: res.request().method() });
    });

    return diagnostics;
}

/** Résumé exploitable : les sondes de session (401/403) sont comptées à part, pas en panne. */
export function summarizeDiagnostics(diagnostics) {
    const isSessionProbe = (e) => e.status === 401 || e.status === 403;
    return {
        consoleErrors: diagnostics.consoleErrors,
        pageErrors: diagnostics.pageErrors,
        consoleWarnings: diagnostics.consoleWarnings.length,
        httpErrors: diagnostics.httpErrors.filter((e) => !isSessionProbe(e)),
        sessionProbes: diagnostics.httpErrors.filter(isSessionProbe).length,
        failedRequests: diagnostics.failedRequests,
    };
}

async function loadState() {
    try {
        await fs.access(config.paths.state);
        log.dim(`session réutilisée (${config.paths.state})`);
        return config.paths.state;
    } catch (e) {
        return undefined;
    }
}
