import { config } from './config.mjs';
import { GameSession } from './client.mjs';
import { runChecks } from './checks.mjs';
import { syncFights } from './fights.mjs';
import { explore } from './explore.mjs';
import { syncTroops } from './troops.mjs';
import { exportRules } from './rules.mjs';
import { serve } from './server.mjs';
import { log } from './util.mjs';

const USAGE = `
Usage : node --env-file-if-exists=.env src/index.mjs <commandes> [options]

Commandes
  check      connexion + vérifications (DOM, API, console, réseau) → out/report.json
  fights     télécharge les combats de la fenêtre courante, nouveaux uniquement → data/fights.json
  explore    dépose les réponses brutes du jeu dans data/raw/ (debug / calibrage)
  rules      convertit les règles publiques du site en Markdown → docs/regles.md
  troops     relève les stats des 21 types de troupes → data/troops.json + docs/troupes.md
  analyse    analyse l'historique de combats dans le terminal → out/analysis.json
  ui         ouvre l'interface locale (docs, analyse, compositions) sur http://127.0.0.1:4173

Options
  --locale=xx langue des règles pour « rules » (fr, en, es, de, it ; défaut fr)
  --port=N    port de l'interface « ui » (défaut 4173)
  --fresh     ignore la session enregistrée et rejoue le formulaire de connexion
  --refresh   retélécharge le détail de TOUS les combats, pas seulement les nouveaux
  --raw       garde aussi le HTML des listes dans data/raw/
  --headed    ouvre un navigateur visible
`.trim();

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const commands = argv.filter((a) => !a.startsWith('--'));

if (flags.has('--help') || flags.has('-h') || commands.length === 0) {
    console.log(USAGE);
    process.exit(commands.length === 0 ? 1 : 0);
}
if (flags.has('--headed')) config.headed = true;

const known = new Set(['check', 'fights', 'explore', 'rules', 'troops', 'analyse', 'ui']);
const unknown = commands.filter((c) => !known.has(c));
if (unknown.length) {
    console.error(`Commande inconnue : ${unknown.join(', ')}\n\n${USAGE}`);
    process.exit(1);
}

let exitCode = 0;

// `rules` lit le site public : pas de navigateur, pas de compte.
if (commands.includes('rules')) {
    const locale = (argv.find((a) => a.startsWith('--locale=')) || '').slice('--locale='.length) || 'fr';
    try {
        await exportRules({ locale });
    } catch (e) {
        log.fail(e.message);
        if (process.env.SSS_DEBUG === '1') console.error(e);
        exitCode = 1;
    }
}

// `analyse` ne lit que les fichiers de données : pas de navigateur non plus.
if (commands.includes('analyse')) {
    try {
        await reportAnalysis();
    } catch (e) {
        log.fail(e.message);
        if (process.env.SSS_DEBUG === '1') console.error(e);
        exitCode = 1;
    }
}

// `ui` garde le processus en vie : c'est toujours la dernière commande traitée.
if (commands.includes('ui')) {
    const port = Number((argv.find((a) => a.startsWith('--port=')) || '').slice('--port='.length)) || 4173;
    await serve({ port });
    await new Promise(() => {}); // le serveur tourne jusqu'au Ctrl+C
}

const needsGame = commands.some((c) => !['rules', 'analyse', 'ui'].includes(c));
if (!needsGame) process.exit(exitCode);

const session = await GameSession.open({ fresh: flags.has('--fresh') });
try {
    log.dim(`${config.baseUrl}/play — ${config.headed ? 'navigateur visible' : 'headless'}`);

    // Les commandes autres que `check` ont quand même besoin d'une session connectée.
    if (!commands.includes('check')) {
        const how = await session.login();
        log.pass(`connecté (${how === 'session' ? 'session réutilisée' : 'formulaire'})`);
    }

    for (const command of commands) {
        if (command === 'check') {
            const { ok } = await runChecks(session);
            if (!ok) exitCode = 1;
        }
        if (command === 'fights') {
            const res = await syncFights(session, { refresh: flags.has('--refresh'), keepRaw: flags.has('--raw') });
            if (res.failed) exitCode = 1;
        }
        if (command === 'troops') await syncTroops(session, { keepRaw: flags.has('--raw') });
        if (command === 'explore') await explore(session);
    }
} catch (e) {
    log.fail(e.message);
    if (process.env.SSS_DEBUG === '1') console.error(e);
    exitCode = 1;
} finally {
    await session.close();
}

process.exit(exitCode);

/* ---------- Analyse en ligne de commande ---------- */

async function reportAnalysis() {
    const { loadAnalysis } = await import('./analyse.mjs');
    const { backtest, recommend } = await import('./sim.mjs');
    const { readJson, writeJson } = await import('./util.mjs');

    const analysis = await loadAnalysis();
    if (analysis.empty) throw new Error(analysis.reason);
    const troops = await readJson(config.paths.troops);

    log.title(`Historique — ${analysis.record.fights} combats`);
    const r = analysis.record;
    log.info(`bilan ${r.wins} V / ${r.losses} D (${r.winRate} %) · attaque ${r.attack.winRate} % · défense ${r.defense.winRate} %`);
    log.info(`points : ${analysis.points.net >= 0 ? '+' : ''}${analysis.points.net} au total (${analysis.points.perFight} par combat)`);

    log.title('Capacités gaspillées');
    if (!analysis.abilities.wasted.length) log.pass('aucune : toutes tes capacités se déclenchent');
    for (const w of analysis.abilities.wasted) {
        log.warn(`${w.fr} (${w.type}) éteinte sur ${w.fights} combats — ${w.qtyMedian} unités pour ${w.needMedian} requises, il en manque ${w.missing}`);
    }

    if (troops) {
        const bt = backtest(analysis, troops);
        log.title('Simulateur');
        log.info(`rejoue l'historique : ${bt.correct}/${bt.fights} bons vainqueurs (${bt.accuracy} %), AUC ${bt.separation}`);

        const slots = troops.crew?.slots || r.fights;
        const rec = recommend({
            analysis, troops, slots,
            maxTypes: troops.crew?.typeSlots || 4,
            keep: 5,
            threshold: bt.threshold,
            readiness: { attack: 1, defense: 0.7 },
        });
        if (!rec.empty) {
            log.title(`Compositions (${slots} places, ${rec.maxTypes} types, seuil de capacité ${rec.need})`);
            for (const b of rec.best) {
                log.info(`${String(b.wins).padStart(2)}/${b.fights} — ${b.types.map((t) => `${t.fr} ×${t.qty}`).join(' + ')}`);
            }
            if (rec.current) log.dim(`actuelle : ${rec.current.wins}/${rec.current.fights} — ${rec.current.types.map((t) => `${t.fr} ×${t.qty}`).join(' + ')}`);
        }
        await writeJson(config.paths.analysis, { analysis, backtest: bt, compos: rec });
        log.pass(`détail complet → ${config.paths.analysis.replace(`${config.root}/`, '')}`);
    }
}
