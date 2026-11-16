import { config } from './config.mjs';
import { log, writeJson, writeText } from './util.mjs';

/* Mode debug : dépose les réponses brutes du jeu dans data/raw/ pour inspecter la structure
   réelle (utile si le serveur change le balisage de l'historique ou le nom des paramètres). */
export async function explore(session) {
    log.title('Exploration (data/raw/)');

    await writeJson(`${config.paths.raw}/boot.json`, session.boot);
    log.info('boot.json');

    const views = [['fights', {}], ['fights', { dir: 'sent' }], ['fights', { dir: 'received' }]];
    for (const [name, params] of views) {
        const suffix = Object.entries(params).map(([k, v]) => `-${k}_${v}`).join('');
        try {
            const html = await session.view(name, params);
            await writeText(`${config.paths.raw}/view-${name}${suffix}.html`, html);
            const facts = await inspect(session.page, html);
            log.info(`view-${name}${suffix}.html — ${html.length} car., ${facts.replayRefs.length} réf. de rejeu`);
            if (facts.navParams.length) log.dim(`data-params rencontrés : ${JSON.stringify(facts.navParams)}`);
            if (facts.replayRefs.length) log.dim(`réfs : ${facts.replayRefs.slice(0, 8).join(', ')}${facts.replayRefs.length > 8 ? '…' : ''}`);
            if (facts.dataAttrs.length) log.dim(`attributs data-* des lignes : ${facts.dataAttrs.join(', ')}`);

            // Un détail complet, pour voir la forme exacte du JSON de combat.
            const first = facts.replayRefs.find((r) => /^\d+$/.test(r));
            if (first) {
                const detail = await session.json(`play/fight?id=${first}`);
                await writeJson(`${config.paths.raw}/fight-${first}.json`, detail.data);
                log.info(`fight-${first}.json — HTTP ${detail.status}, clés : ${Object.keys(detail.data || {}).join(', ')}`);
            }
        } catch (e) {
            log.warn(`view ${name} ${JSON.stringify(params)} : ${e.message}`);
        }
    }
}

async function inspect(page, html) {
    return page.evaluate((raw) => {
        const tpl = document.createElement('template');
        tpl.innerHTML = raw;
        const replayRefs = [...tpl.content.querySelectorAll('[data-fight-replay]')]
            .map((el) => el.getAttribute('data-fight-replay'));
        const navParams = [];
        tpl.content.querySelectorAll('[data-params]').forEach((el) => {
            const v = el.getAttribute('data-params');
            if (!navParams.includes(v)) navParams.push(v);
        });
        const dataAttrs = new Set();
        tpl.content.querySelectorAll('[data-fight-replay]').forEach((el) => {
            const row = el.closest('li, tr, article, .card, [class*="fight"]') || el.parentElement;
            for (const a of (row && row.attributes) || []) if (a.name.startsWith('data-')) dataAttrs.add(a.name);
        });
        return { replayRefs, navParams, dataAttrs: [...dataAttrs] };
    }, html);
}
