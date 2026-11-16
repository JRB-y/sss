import { config } from './config.mjs';
import { summarizeDiagnostics } from './client.mjs';
import { log, writeJson } from './util.mjs';

/* Éléments du cadre de jeu (ids utilisés par la SPA : #stage, #map, #layer, #toasts, #assets).
   Ajoute ici tes propres points à vérifier :
     { label: 'Bouton téléphone', selector: '.phone-btn[data-view="phone"]' }
     { label: 'Nom du joueur affiché', text: 'MonPseudo' }                      */
export const PAGE_CHECKS = [
    { label: 'Scène de jeu (#stage)', selector: '#stage' },
    { label: 'Carte (#map)', selector: '#map' },
    { label: 'Calque des fenêtres (#layer)', selector: '#layer' },
    { label: 'Zone des toasts (#toasts)', selector: '#toasts' },
    { label: 'Carte réellement rendue (canvas MapLibre)', selector: '#map canvas' },
];

export async function runChecks(session) {
    const results = [];
    const add = (name, ok, detail = '') => {
        results.push({ name, ok, detail });
        (ok ? log.pass : log.fail)(detail ? `${name} — ${detail}` : name);
        return ok;
    };

    log.title('Checks');

    const status = session.firstResponse ? session.firstResponse.status() : null;
    add('GET /play répond 200', status === 200, status ? `HTTP ${status}` : 'statut inconnu');
    add('Payload de boot lisible', Boolean(session.boot), session.boot ? `state=${session.boot.state}` : 'script #boot absent/illisible');

    // Connexion (ou réutilisation de la session enregistrée).
    let how = null;
    try {
        how = await session.login();
        const live = await session.fetchState();
        add('État serveur (/play/state)', live.ok && Boolean(live.data && live.data.ok), `HTTP ${live.status}`);
        add('Connexion au compte', session.loggedIn,
            `${how === 'session' ? 'session réutilisée' : 'formulaire /play/login'}, state=${session.boot ? session.boot.state : '?'}`);
    } catch (e) {
        add('Connexion au compte', false, e.message);
        return finish(session, results);
    }

    const player = (session.boot && session.boot.player) || {};
    add('Joueur chargé', Boolean(player.name), player.name ? `${player.name}` : 'player null dans le boot');
    add('Au moins une ville', Array.isArray(session.boot.cities) && session.boot.cities.length > 0,
        `${(session.boot.cities || []).length} ville(s)`);

    // Les éléments du cadre de jeu n'existent qu'après le passage en état 'game'.
    for (const check of PAGE_CHECKS) {
        if (check.selector) {
            const count = await session.page.locator(check.selector).count();
            add(check.label, count > 0, count > 0 ? `${count} élément(s)` : `introuvable : ${check.selector}`);
        } else if (check.text) {
            const visible = await session.page.getByText(check.text, { exact: false }).count();
            add(check.label, visible > 0, visible > 0 ? 'texte présent' : `texte absent : « ${check.text} »`);
        }
    }

    // Pouls du jeu : l'endpoint que la SPA interroge en continu pour l'état serveur.
    const pulse = await session.json('play/pulse');
    add('Pouls serveur (/play/pulse)', pulse.ok && pulse.data && pulse.data.ok !== false, `HTTP ${pulse.status}`);

    // Les deux vues d'historique doivent répondre du HTML (c'est la source de l'export).
    for (const dir of ['sent', 'received']) {
        try {
            const html = await session.view('fights', { dir });
            add(`Vue historique (dir=${dir})`, html.trim().length > 0, `${html.length} caractères`);
        } catch (e) {
            add(`Vue historique (dir=${dir})`, false, e.message);
        }
    }

    // Infos utiles au passage : pastilles et attaques subies non vues.
    const badges = player.appBadges || {};
    if (Object.keys(badges).length) log.info(`pastilles : ${JSON.stringify(badges)}`);
    if (Array.isArray(player.defenses)) log.info(`attaques subies récentes dans le boot : ${player.defenses.length}`);
    if (player.march) log.warn('une marche est en cours (combat en route)');

    return finish(session, results);
}

async function finish(session, results) {
    const diag = summarizeDiagnostics(session.diagnostics);
    const add = (name, ok, detail) => {
        results.push({ name, ok, detail });
        (ok ? log.pass : log.fail)(`${name} — ${detail}`);
    };

    log.title('Console & réseau');
    add('Aucune erreur console', diag.consoleErrors.length === 0, `${diag.consoleErrors.length} erreur(s)`);
    add('Aucune exception JS', diag.pageErrors.length === 0, `${diag.pageErrors.length} exception(s)`);
    add('Aucune requête HTTP ≥ 400', diag.httpErrors.length === 0, `${diag.httpErrors.length} réponse(s) en erreur`);
    add('Aucune requête échouée (réseau)', diag.failedRequests.length === 0, `${diag.failedRequests.length} échec(s)`);
    if (diag.consoleWarnings) log.dim(`${diag.consoleWarnings} avertissement(s) console (non bloquants)`);
    if (diag.sessionProbes) log.dim(`${diag.sessionProbes} réponse(s) 401/403 : sondes de session, normal avant connexion`);

    for (const e of diag.consoleErrors.slice(0, 10)) log.dim(`console: ${e.text}${e.location ? ` (${e.location})` : ''}`);
    for (const e of diag.pageErrors.slice(0, 10)) log.dim(`exception: ${e.text}`);
    for (const e of diag.httpErrors.slice(0, 10)) log.dim(`http ${e.status}: ${e.method} ${e.url}`);
    for (const e of diag.failedRequests.slice(0, 10)) log.dim(`réseau: ${e.error} ${e.url}`);

    const shot = session.loggedIn ? await session.screenshot('game') : await session.screenshot('login');
    log.info(`capture : ${shot}`);

    const report = {
        at: new Date().toISOString(),
        baseUrl: config.baseUrl,
        loggedIn: session.loggedIn,
        player: session.boot && session.boot.player
            ? { name: session.boot.player.name, badges: session.boot.player.appBadges || {} }
            : null,
        results,
        diagnostics: diag,
        screenshot: shot,
    };
    await writeJson(config.paths.report, report);
    log.info(`rapport : ${config.paths.report}`);

    const failed = results.filter((r) => !r.ok);
    log.title(failed.length ? `${failed.length} check(s) en échec` : `Tous les checks passent (${results.length})`);
    return { report, ok: failed.length === 0 };
}
