import { config } from './config.mjs';
import { GameSession } from './client.mjs';
import { runChecks } from './checks.mjs';
import { syncFights } from './fights.mjs';
import { explore } from './explore.mjs';
import { syncTroops } from './troops.mjs';
import { syncSkills } from './skills.mjs';
import { syncHq } from './hq.mjs';
import { exportRules } from './rules.mjs';
import { serve } from './server.mjs';
import { log } from './util.mjs';

const USAGE = `
Usage : node --env-file-if-exists=.env src/index.mjs <commandes> [options]

Commandes
  check      connexion + vérifications (DOM, API, console, réseau) → out/report.json
  fights     télécharge les combats de la fenêtre courante, nouveaux uniquement → data/fights.json
             (reprojette aussi les adversaires et les objets, sauf avec --no-project)
  enemies    (re)construit les fiches d'adversaires et le catalogue d'objets depuis les combats
             déjà en base → data/enemies.json, data/items.json, docs/objets.md (sans connexion)
  explore    dépose les réponses brutes du jeu dans data/raw/ (debug / calibrage)
  rules      convertit les règles publiques du site en Markdown → docs/regles.md
  troops     relève les stats des 21 types de troupes → data/troops.json + docs/troupes.md
  skills     relève ton arbre de talents → data/skills.json (il sépare talents et équipement)
  hq         relève ton QG : ressources, bâtiments, niveau, points de compétence → data/hq.json
  assets     télécharge les images du jeu (troupes, objets, avatars) → data/assets/ (sans connexion)
  report     compte rendu Markdown complet pour un agent IA → docs/rapport.md (sans connexion)
  analyse    analyse l'historique de combats dans le terminal → out/analysis.json
  ui         ouvre l'interface locale (docs, analyse, compositions) sur http://127.0.0.1:4173

Options
  --locale=xx langue des règles pour « rules » (fr, en, es, de, it ; défaut fr)
  --port=N    port de l'interface « ui » (défaut 4173)
  --fresh     ignore la session enregistrée et rejoue le formulaire de connexion
  --refresh   retélécharge le détail de TOUS les combats, pas seulement les nouveaux
  --raw       garde aussi le HTML des listes dans data/raw/
  --headed    ouvre un navigateur visible
  --no-project  « fights » n'enchaîne pas sur la reprojection des adversaires
  --force     « assets » retélécharge toutes les images, même celles déjà en local
`.trim();

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const commands = argv.filter((a) => !a.startsWith('--'));

if (flags.has('--help') || flags.has('-h') || commands.length === 0) {
    console.log(USAGE);
    process.exit(commands.length === 0 ? 1 : 0);
}
if (flags.has('--headed')) config.headed = true;

const known = new Set(['check', 'fights', 'enemies', 'assets', 'explore', 'rules', 'troops', 'skills', 'hq', 'report', 'analyse', 'ui']);
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

/* `enemies` est une projection des combats déjà en base : ni navigateur, ni compte. On la traite
   avant `analyse` pour qu'un `enemies analyse` enchaîné parte des fiches fraîches. */
if (commands.includes('enemies')) {
    try {
        const { syncEnemies } = await import('./enemies.mjs');
        await syncEnemies();
    } catch (e) {
        log.fail(e.message);
        if (process.env.SSS_DEBUG === '1') console.error(e);
        exitCode = 1;
    }
}

/* `assets` ne tape que des URLs publiques (images, sprite) : pas de navigateur, pas de compte. */
if (commands.includes('assets')) {
    try {
        const { syncAssets } = await import('./assets.mjs');
        await syncAssets({ force: flags.has('--force') });
    } catch (e) {
        log.fail(e.message);
        if (process.env.SSS_DEBUG === '1') console.error(e);
        exitCode = 1;
    }
}

/* `report` agrège tout ce qui est en base en un seul document : pas de réseau non plus. */
if (commands.includes('report')) {
    try {
        const { buildReport } = await import('./report.mjs');
        const { writeText } = await import('./util.mjs');
        const md = await buildReport();
        const file = `${config.paths.docs}/rapport.md`;
        await writeText(file, md);
        log.title('Compte rendu');
        log.pass(`${md.split('\n').length} lignes → ${file.replace(`${config.root}/`, '')}`);
        log.dim('à coller dans une conversation avec un agent IA pour lui demander conseil.');
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

const needsGame = commands.some((c) => !['rules', 'analyse', 'enemies', 'assets', 'report', 'ui'].includes(c));
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
            const res = await syncFights(session, {
                refresh: flags.has('--refresh'),
                keepRaw: flags.has('--raw'),
                project: !flags.has('--no-project'),
            });
            if (res.failed) exitCode = 1;
            // Un trou dans la fenêtre n'est pas une panne du script, mais ça ne doit pas passer
            // inaperçu dans un cron : on le remonte par le code de sortie.
            if (res.holes?.length) exitCode = 1;
        }
        if (command === 'troops') await syncTroops(session, { keepRaw: flags.has('--raw') });
        if (command === 'skills') await syncSkills(session, { keepRaw: flags.has('--raw') });
        if (command === 'hq') await syncHq(session);
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
    const { backtest, recommend, calibrateCrit } = await import('./sim.mjs');
    const { readJson, writeJson } = await import('./util.mjs');

    const analysis = await loadAnalysis();
    if (analysis.empty) throw new Error(analysis.reason);
    const troops = await readJson(config.paths.troops);
    const skills = await readJson(config.paths.skills);

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
        // Le multiplicateur de critique dépend du talent « Executioner », dont le libellé est
        // ambigu : on laisse l'historique choisir l'interprétation plutôt que de la décréter.
        const crit = skills ? calibrateCrit(analysis, troops, skills).best : null;
        const bt = backtest(analysis, troops, { skills, critMult: crit?.critMult });
        log.title('Simulateur');
        log.info(`rejoue l'historique : ${bt.correct}/${bt.fights} bons vainqueurs (${bt.accuracy} %), AUC ${bt.separation}`);
        if (skills) {
            log.dim(`talents appliqués : +${skills.bonuses.dmgPct} % de dégâts, +${skills.bonuses.dmgFlat} par coup, `
                + `+${skills.bonuses.critPts} pts de critique, +${skills.bonuses.speedPct} % de vitesse, `
                + `+${skills.bonuses.hpPct} % de vie · critique ×${crit.critMult}`);
        } else {
            log.warn('arbre de talents inconnu : lance « npm run skills » pour que le simulateur en tienne compte.');
        }

        const slots = troops.crew?.slots || r.fights;
        const rec = recommend({
            analysis, troops, slots,
            maxTypes: troops.crew?.typeSlots || 4,
            keep: 5,
            threshold: bt.threshold,
            readiness: { attack: 1, defense: 0.7 },
            critMult: bt.critMult,
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
