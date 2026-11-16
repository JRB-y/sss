import { config } from './config.mjs';
import { GameSession } from './client.mjs';
import { runChecks } from './checks.mjs';
import { syncFights } from './fights.mjs';
import { explore } from './explore.mjs';
import { syncTroops } from './troops.mjs';
import { exportRules } from './rules.mjs';
import { log } from './util.mjs';

const USAGE = `
Usage : node --env-file-if-exists=.env src/index.mjs <commandes> [options]

Commandes
  check      connexion + vérifications (DOM, API, console, réseau) → out/report.json
  fights     télécharge les combats de la fenêtre courante, nouveaux uniquement → data/fights.json
  explore    dépose les réponses brutes du jeu dans data/raw/ (debug / calibrage)
  rules      convertit les règles publiques du site en Markdown → docs/regles.md
  troops     relève les stats des 21 types de troupes → data/troops.json + docs/troupes.md

Options
  --locale=xx langue des règles pour « rules » (fr, en, es, de, it ; défaut fr)
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

const known = new Set(['check', 'fights', 'explore', 'rules', 'troops']);
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

const needsGame = commands.some((c) => c !== 'rules');
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
