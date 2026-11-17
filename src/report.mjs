import { config } from './config.mjs';
import { readJson } from './util.mjs';
import { loadAnalysis, ABILITY_FR, ROLE_FR } from './analyse.mjs';
import { backtest, recommend, typeParams } from './sim.mjs';
import { measureCritMultiplier, measureCritRates } from './fightlog.mjs';
import { RESOURCES } from './hq.mjs';

/* Compte rendu complet, en Markdown, destiné à être collé dans une conversation avec un agent IA
   pour lui demander conseil.

   Deux exigences, et elles tirent dans des sens opposés : il faut **tout** le contexte utile
   (sinon le conseil est générique) et il faut que ça reste lisible par un modèle (donc pas de
   vidage brut de 2 Mo de JSON). Le parti pris :

   — des chiffres déjà agrégés plutôt que des données brutes — c'est le travail qu'un modèle ferait
     mal et qu'on a déjà fait ici ;
   — ce qui est **mesuré** est annoncé comme tel, ce qui est **modélisé** aussi, et les limites
     connues sont écrites noir sur blanc. Un agent qui ne sait pas ce qu'il ignore donne de mauvais
     conseils avec aplomb ;
   — une section de questions ouvertes à la fin, pour orienter sans contraindre. */

export async function buildReport({ full = false } = {}) {
    const [hq, troops, skills, items, enemies, fights] = await Promise.all([
        readJson(config.paths.hq),
        readJson(config.paths.troops),
        readJson(config.paths.skills),
        readJson(config.paths.items),
        readJson(config.paths.enemies),
        readJson(config.paths.fights),
    ]);
    const analysis = await loadAnalysis();
    const empty = analysis.empty ? null : analysis;

    const out = [];
    const H = (level, title) => out.push(`${'#'.repeat(level)} ${title}`, '');
    const P = (...lines) => out.push(...lines, '');
    const T = (head, rows, align = []) => {
        if (!rows.length) return;
        out.push(`| ${head.join(' | ')} |`);
        out.push(`| ${head.map((_, i) => (align[i] === 1 ? '---:' : '---')).join(' | ')} |`);
        for (const r of rows) out.push(`| ${r.join(' | ')} |`);
        out.push('');
    };

    /* ---------- En-tête ---------- */
    H(1, `Sand Sea Sun — état du compte ${hq?.account?.name || troops?.account || '?'}`);
    P(`*Compte rendu généré le ${stamp()} par [sss-play-check]. Tout ce qui suit vient du jeu :`
        + ' rapports de combat, vue du shop, arbre de talents et état de la ville. Rien n’est inventé.*');

    P('> **À l’agent qui lit ceci.** Je cherche des conseils concrets : quoi améliorer en priorité,'
        + ' quoi changer dans ma composition de troupes, quoi arrêter de faire. Les sections'
        + ' « mesuré » sont des faits ; les sections « modélisé » viennent d’un simulateur dont la'
        + ' fiabilité est chiffrée plus bas. Les limites connues sont listées à la fin — merci de ne'
        + ' pas conseiller sur ce qui n’y est pas mesurable.');

    /* ---------- Le personnage ---------- */
    if (hq) {
        H(2, 'Le personnage');
        const lv = hq.level;
        P(`- **Niveau ${lv.level}** — ${fr(lv.xp)} / ${fr(lv.xpTo)} XP (${lv.pct} %), il reste ${fr(lv.xpLeft)} XP`
            + ' avant le niveau suivant, qui donnera un point de compétence.',
        `- **Points de compétence libres : ${hq.skillPoints}**${hq.skillPoints ? ' ← à dépenser' : ''}`,
        `- **Classement : ${fr(hq.rating)}** · rang ${hq.rank.city ?? '?'} dans la ville`
            + (hq.family ? ` · famille « ${hq.family.name || hq.family.id} » (rôle ${hq.rank.role || '?'})` : ' · sans famille'),
        `- Attaques : ${hq.attacks ? `${hq.attacks.used} / ${hq.attacks.max} utilisées` : '?'}`
            + ` · bouclier ${hq.defense.shield || 'aucun'} · réparations ${hq.defense.repairs ?? '?'}`,
        hq.account.premium ? `- Premium actif, ${hq.account.premiumDays} jour(s) restants` : '- Pas de premium');

        /* ---------- Ressources ---------- */
        H(2, 'Ressources — mesuré');
        T(['Ressource', 'Stock', 'Capacité', 'Remplissage', 'Production / tour', 'Dépensé en tout'],
            hq.resources.filter((r) => r.value != null).map((r) => [
                `**${r.fr}**`, fr(r.value), r.cap != null ? fr(r.cap) : '—',
                r.pct != null ? `${String(r.pct).replace('.', ',')} %${r.full ? ' ⚠️ **plein**' : ''}` : '—',
                r.perTurn != null ? `+${fr(r.perTurn)}` : '—',
                r.spent != null ? fr(r.spent) : '—',
            ]), [0, 1, 1, 1, 1, 1]);
        const turn = hq.turn?.every ? `Un tour dure ${hq.turn.every / 60} minutes.` : '';
        const full = hq.resources.filter((r) => r.full);
        P(`${turn}${full.length ? ` **${full.map((r) => r.fr).join(', ')} au plafond : la production correspondante est perdue.**` : ''}`);

        /* ---------- Les bâtiments ---------- */
        H(2, 'Les bâtiments — mesuré');
        P(`${hq.summary.total} bâtiments, ${hq.summary.levels} niveaux cumulés, ${hq.summary.atMax} au maximum,`
            + ` ${fr(hq.summary.hp)} PV de structures.`
            + ` Terrain : rayon ${hq.city.radius}/${hq.city.maxRadius}, ${fr(hq.city.areaM2)} m², ${hq.city.buildingSlots} emplacements.`);
        T(['Bâtiment', 'Nb', 'Niveau max atteint', 'Niveaux cumulés', 'À quoi il sert'],
            hq.summary.byType.map((b) => [
                `**${esc(b.name)}** (\`${b.type}\`)`, String(b.count), String(b.max), String(b.levels),
                b.role ? b.role.replace(/^[^—]*— /, '') : '—',
            ]), [0, 1, 1, 1, 0]);

        const works = hq.buildings.filter((b) => b.works);
        if (works.length) {
            P(`**Chantiers en cours :** ${works.map((b) => `${esc(b.name)} niveau ${b.level}`
                + `${b.works.becomes ? ` → ${esc(b.works.becomes)}` : ''} (${hours(b.works.secondsLeft)})`).join(' · ')}`);
        }
        const notMax = hq.buildings.filter((b) => b.maxLevel && !b.atMax && !b.works);
        if (notMax.length) {
            P(`**Améliorables tout de suite** (ni au maximum, ni en chantier) : `
                + `${[...new Set(notMax.map((b) => `${esc(b.typeName)} niv. ${b.level}/${b.maxLevel}`))].join(' · ')}`);
        }
    } else {
        H(2, 'Les bâtiments');
        P('*Non relevés : lance `npm run hq`.*');
    }

    /* ---------- Les talents ---------- */
    if (skills) {
        H(2, 'Arbre de talents — mesuré');
        const b = skills.bonuses;
        P(`${skills.spent} point(s) dépensés`
            + `${skills.toSpend ? `, **${skills.toSpend} non dépensé(s)**` : ''}`
            + ` — ${Object.entries(skills.spentPerBranch || {}).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
        T(['Talent', 'Points', 'Effet total'],
            skills.nodes.filter((n) => n.points > 0).map((n) => [
                `**${esc(n.name)}** (\`${n.key}\`)`, `${n.points}/${n.max ?? '∞'}`,
                esc(n.effects.map((e) => (e.perPoint ? `${e.raw} × ${n.points}` : e.raw)).join(', ')),
            ]), [0, 1, 0]);
        P(`**Total appliqué en combat :** +${b.dmgPct} % de dégâts, +${b.dmgFlat} dégâts plats par coup,`
            + ` +${b.critPts} pts de critique, +${b.critDmgPct} % de dégâts critiques, +${b.speedPct} % de vitesse,`
            + ` +${b.hpPct} % de vie, +${b.counterPts || 0} pts de riposte.`);
        const next = skills.nodes.filter((n) => !n.points && n.locked).slice(0, 8);
        if (next.length) {
            P('**Talents encore fermés (raison donnée par le jeu) :**',
                ...next.map((n) => `- ${esc(n.name)} — ${esc(n.locked)}`), '');
        }
        P('> Conséquence importante : avec 0 point en branche Défense, **les talents n’apportent aucun'
            + ' bonus de vie**. Tout l’écart entre les PV « de base » et les PV « réels » d’un type vient'
            + ' donc de son équipement.');
    }

    /* ---------- Les troupes ---------- */
    if (troops) {
        H(2, 'Les troupes — mesuré');
        const crew = troops.crew || {};
        P(`**${fr(crew.used ?? crew.inService)} / ${fr(crew.slots)} places** occupées,`
            + ` **${crew.typesUsed ?? '?'} / ${crew.typeSlots ?? '?'} types** engagés,`
            + ` réserve ${fr(crew.reserve ?? 0)}.`
            + ` Une capacité ne s’active qu’à partir de **${fr(crew.abilityNeed)} unités** du même type (10 % des places).`);

        const units = Object.values(troops.units || {}).filter((u) => u.cat === 'troops' && u.detailed);
        T(['Type', 'Possédées', 'Niv. type', 'XP avant palier', 'Rôle', 'Capacité', 'PV/u.', 'Dégâts', 'Crit.', 'Riposte', 'Vitesse', 'Coût unitaire'],
            units.map((u) => {
                const s = u.stats || {};
                const dmg = s.damage?.effective || s.damage?.base;
                return [
                    `**${esc(u.fr || u.name)}** (\`${u.key}\`)`,
                    fr(u.owned || 0),
                    String(u.typeLevel ?? '—'),
                    u.typeXp?.next ? `${fr(u.typeXp.remaining)} (${u.typeXp.pct} %)` : '—',
                    esc(u.role?.fr || u.role?.name || '—'),
                    esc(u.ability?.fr || u.ability?.name || '—'),
                    fr(s.hp?.effective ?? s.hp?.base),
                    dmg && typeof dmg === 'object' ? `${fr(dmg.min)}–${fr(dmg.max)}` : fr(dmg),
                    `${s.crit?.effective ?? s.crit?.base ?? '—'} %`,
                    `${s.counter?.effective ?? s.counter?.base ?? '—'} %`,
                    `${s.speed?.effective ?? s.speed?.base ?? '—'} s`,
                    cost(u.cost),
                ];
            }), [0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0]);
        P('*« PV/u. », « Dégâts », « Crit. » etc. sont les stats **réelles** : talents et équipement du'
            + ' moment compris. Le niveau de type ajoute +2 % de vie et de dégâts par palier, de façon'
            + ' **additive** (vérifié : `base × (1 + 2 % × (n − 1))`).*');
    }

    /* ---------- L'équipement ---------- */
    if (items && empty) {
        H(2, 'L’équipement — mesuré');
        const g = empty.opponents.gear;
        P('Chaque troupe porte trois pièces : une arme, une protection, un porte-bonheur. Les bonus'
            + ' ci-dessous sont les **affixes** que le jeu chiffre explicitement, en moyenne par pile engagée.');
        T(['Stat d’affixe', 'Moi', 'Mes adversaires', 'Écart'],
            ['dmg', 'hp', 'speed', 'crit', 'riposte'].map((k) => {
                const mine = g.mineBonuses[k] || 0;
                const theirs = g.bonuses[k] || 0;
                const unit = k === 'crit' || k === 'riposte' ? ' pts' : ' %';
                return [
                    ({ dmg: 'Dégâts', hp: 'Vie', speed: 'Vitesse', crit: 'Critique', riposte: 'Riposte' })[k],
                    `+${mine}${unit}`, `+${theirs}${unit}`,
                    `${mine - theirs >= 0 ? '+' : ''}${Math.round((mine - theirs) * 100) / 100}${unit}`,
                ];
            }), [0, 1, 1, 1]);
        P('> **Ce que le jeu ne publie pas.** Chaque objet apporte aussi un bonus *intrinsèque*, lié à'
            + ' la pièce et à sa rareté, écrit nulle part. Il est pourtant mesurable : à type, niveau et'
            + ' affixes constants, changer de protection déplace les PV unitaires. Sur mes types équipés,'
            + ' il vaut aujourd’hui entre +19 % et +31,5 % de PV. **Il n’est pas modélisé** dans les'
            + ' simulations ci-dessous.');

        const byRarity = {};
        for (const it of Object.values(items.items || {})) {
            for (const r of Object.values(it.rarities)) {
                byRarity[r.fr] = (byRarity[r.fr] || 0) + r.seen;
            }
        }
        P(`Catalogue relevé : **${items.counts.items} objets** distincts`
            + ` (${Object.entries(items.counts.bySlot || {}).map(([k, n]) => `${n} ${k}`).join(', ')}),`
            + ` raretés croisées : ${Object.entries(byRarity).map(([k, n]) => `${k} ×${n}`).join(', ')}.`);
        P('Nombre d’affixes par rareté, **observé** : Peu commun 0, Rare 1, Épique 2, Légendaire 3.');
    }

    /* ---------- Le bilan de combat ---------- */
    if (empty) {
        const r = empty.record;
        H(2, 'Bilan de combat — mesuré');
        P(`**${r.fights} combats archivés** : ${r.wins} victoires, ${r.losses} défaites (${r.winRate} %).`,
            `- En **attaque** : ${r.attack.wins} / ${r.attack.fights} (${r.attack.winRate} %)`,
            `- En **défense** : ${r.defense.wins} / ${r.defense.fights} (${r.defense.winRate} %)`,
            `- Points : ${empty.points.net >= 0 ? '+' : ''}${empty.points.net} au total, ${empty.points.perFight} par combat`,
            `- Série en cours : ${r.streak.n} ${r.streak.kind}`,
            `- Armée adverse médiane : ×${(r.armyGap || 1).toFixed(2)} mes PV`);

        const readiness = defenseReadiness(empty);
        P(`> **Le fait le plus important de cet historique.** En défense, mes piles démarrent à`
            + ` **${Math.round(readiness * 100)} % de leurs PV** en médiane, parce que l’attaque arrive avant la`
            + ' fin de la récupération ; un attaquant part toujours à 100 %. C’est la première cause des'
            + ' défaites en défense, devant la composition.');

        H(3, 'Rendement de mes types');
        T(['Type', 'Combats', 'Qté méd.', 'Part des dégâts', 'Dégâts / unité', 'Subis / unité', 'Échange', 'Capacité active'],
            empty.myTypes.map((t) => [
                `**${esc(t.fr)}**`, String(t.fights), fr(t.qtyMedian), `${t.damageShare} %`,
                fr(t.dealtPerUnit), fr(t.takenPerUnit), String(t.trade),
                `${t.abilityFireRate} %`,
            ]), [0, 1, 1, 1, 1, 1, 1, 1]);

        if (empty.abilities.wasted.length) {
            H(3, 'Capacités payées pour rien');
            T(['Capacité', 'Type qui la porte', 'Combats sans effet', 'Unités engagées (méd.)', 'Requises', 'Manquantes'],
                empty.abilities.wasted.map((w) => [
                    `**${esc(w.fr)}**`, `\`${w.type}\``, String(w.fights), fr(w.qtyMedian), fr(w.needMedian), fr(w.missing),
                ]), [0, 0, 1, 1, 1, 1]);
        }

        H(3, 'Le vivier que j’affronte');
        P(`Écart de niveau médian : ${empty.opponents.levelGap >= 0 ? '+' : ''}${empty.opponents.levelGap}.`
            + ` Fortification médiane en face quand j’attaque : ${empty.opponents.fortMedian ?? 0} %.`);
        T(['Type adverse', 'Rencontré', 'Qté méd.', 'PV / unité', 'Niv. type', 'Cadence mesurée', 'Capacité'],
            empty.opponents.pool.map((o) => [
                `\`${o.key}\``, `${o.fights} piles`, fr(o.qtyMedian), fr(o.unitHpMedian),
                o.typeLevel ? `${o.typeLevel.last}${o.typeLevel.min !== o.typeLevel.max ? ` (${o.typeLevel.min}→${o.typeLevel.max})` : ''}` : '—',
                o.intervalMedian ? `${o.intervalMedian} s` : '—', esc(o.abilityFr || '—'),
            ]), [0, 1, 1, 1, 1, 1, 0]);

        if (enemies) {
            const foes = Object.values(enemies.players).filter((p) => !p.isMe)
                .sort((a, b) => b.record.fights - a.record.fights).slice(0, 10);
            H(3, 'Les adversaires les plus fréquents');
            T(['Adversaire', 'Niveau', 'Classement', 'Combats', 'Mon bilan', 'Fortif.', 'Son armée au dernier combat'],
                foes.map((p) => [
                    `**${esc(p.name)}**`,
                    p.level.first === p.level.last ? String(p.level.last) : `${p.level.first} → ${p.level.last}`,
                    String(p.rating.last ?? '—'), String(p.record.fights),
                    `${p.record.myWins}V / ${p.record.myLosses}D`,
                    p.fort.last != null ? `${p.fort.last} %` : '—',
                    p.latest ? p.latest.piles.map((x) => `${esc(x.fr)} ×${fr(x.qty)}`).join(', ') : '—',
                ]), [0, 1, 1, 1, 0, 1, 0]);
        }
    }

    /* ---------- Le simulateur ---------- */
    if (empty && troops) {
        const crit = measureCritMultiplier(fights, empty.account?.id);
        const bt = backtest(empty, troops, { skills, critMult: crit.mine || undefined });
        H(2, 'Simulations — modélisé');
        P('Le moteur rejoue les **mécaniques exactes du jeu**, rétro-conçues depuis les frises de'
            + ' coups : intervalles de frappe déterministes (round(vitesse × 100) centièmes),'
            + ' dégâts = vivants × tirage uniforme(min…max) × crit × (1 − fort), vivants ='
            + ' ceil(PV ÷ PV unitaire), riposte = min(vivants cible, vivants attaquant) × 0,6,'
            + ' bouclier en pool commun de 8 % des PV de départ, seuils et amplitudes mesurés'
            + ' des capacités. Les talents adverses (invisibles dans les stats servies) sont'
            + ' mesurés par joueur dans les journaux et appliqués. **Sa fiabilité, en'
            + ' leave-one-out :**',
        `- il retrouve le bon vainqueur dans **${bt.accuracy} %** des ${bt.fights} combats`,
        `- pouvoir de classement (AUC) **${bt.separation}** — 1 = parfait, 0,5 = hasard`,
        bt.brier != null ? `- score de Brier **${bt.brier}** — 0 = parfait, 0,25 = pile ou face` : '',
        `- référence « tout perdu » : ${bt.baseline} %`,
        `- multiplicateur de critique **mesuré dans les journaux du jeu** : ×${crit.mine} pour moi`
            + ` (talent Executioner), ×${crit.theirs} en face (valeur de base des règles)`);
        P('*Le jeu tire les dégâts au hasard : un verdict est une **probabilité** (Monte-Carlo),'
            + ' pas une promesse.*');

        const slots = troops.crew?.slots || 875;
        const rec = recommend({
            analysis: empty, troops, slots,
            maxTypes: troops.crew?.typeSlots || 4,
            keep: 5, threshold: bt.threshold,
            readiness: { attack: 1, defense: defenseReadiness(empty) },
            critMult: bt.critMult,
        });
        if (!rec.empty) {
            H(3, 'Compositions les mieux classées');
            P(`${fr(rec.screened)} compositions passées en revue contre les ${rec.scenarios} adversaires réels`
                + ` de l’historique, sur ${fr(slots)} places et ${rec.maxTypes} types.`);
            T(['Composition', 'Combats gagnés', 'Taux', 'Capacités actives'],
                rec.best.map((b) => [
                    b.types.map((t) => `${esc(t.fr)} ×${fr(t.qty)}`).join(' + '),
                    `${b.wins} / ${b.fights}`, `${b.winRate} %`,
                    esc(b.abilitiesOn.join(', ')) || '—',
                ]), [0, 1, 1, 0]);
            if (rec.current) {
                P(`**Ma composition actuelle** — ${rec.current.types.map((t) => `${esc(t.fr)} ×${fr(t.qty)}`).join(' + ')}`
                    + ` → ${rec.current.wins} / ${rec.current.fights} (${rec.current.winRate} %).`);
            }
        }
    }

    /* ---------- Ce qui n'est pas su ---------- */
    H(2, 'Limites connues — à ne pas ignorer');
    P('- **Bonus intrinsèque des objets** : non publié par le jeu. Il est capté indirectement (PV servis,'
        + ' cadence mesurée, facteur de dégâts appris par joueur), mais « forge telle pièce » ne peut pas'
        + ' être chiffré a priori.',
    '- **Coûts d’amélioration des bâtiments** : non relevés. Les niveaux et les maximums le sont.',
    '- **Capacités jamais croisées en combat** (gel du temps, intimidation, forteresse, dernier carré,'
        + ' coup de grâce, renvoi, corruption) : encodées depuis les règles officielles, amplitudes non'
        + ' vérifiées sur des combats réels.',
    '- **Onde de choc** : loi mesurée (≈ 10 % des PV courants du camp lanceur, répartis au prorata des'
        + ' PV adverses) avec un résidu de ±20 % non expliqué.',
    '- **Renforts de famille** : présents dans les combats, exclus des compositions (ils ne se choisissent pas).',
    '- **Le seed du serveur** : chaque rapport en contient un, mais le générateur n’a pas été identifié ;'
        + ' un combat futur reste donc une distribution, pas un déroulé exact.',
    '- **Portée de l’historique** : le jeu n’expose qu’une fenêtre d’environ 30 combats par onglet.'
        + ' L’archive locale accumule, mais tout combat antérieur à son premier passage est absent.');

    H(2, 'Ce sur quoi j’aimerais un avis');
    P('1. **Priorité d’amélioration** : quel bâtiment faire monter en premier, et pourquoi ?',
        '2. **Composition** : garder la composition actuelle ou basculer sur une des propositions ?'
        + ' Le coût de recrutement et les capacités éteintes comptent.',
        '3. **Talents** : la répartition actuelle est-elle cohérente avec ma façon de jouer'
        + ' (ratio attaque/défense ci-dessus) ?',
        '4. **Défense** : mes troupes encaissent à PV réduits. Qu’est-ce qui corrige ça le plus vite ?',
        '5. **Ce que je devrais arrêter de faire** — c’est souvent le conseil qui manque.');

    P('---', '', `*Généré par \`npm run report\` · ${out.length} lignes · sources : data/fights.json,`
        + ' data/troops.json, data/skills.json, data/hq.json, data/items.json, data/enemies.json.*');

    void full;
    void measureCritRates;
    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/* ---------- Le compte rendu d'UN combat, pour un agent IA ----------

   Même philosophie que le rapport global : tout le contexte utile, agrégé, avec le mesuré annoncé
   comme tel et le modélisé chiffré. S'y ajoute ce qu'un combat précis a d'unique : les deux armées
   pile par pile avec leur équipement, la frise des capacités, le journal coup par coup — et l'avis
   du simulateur sur CE duel (probabilité, meilleure composition possible). */

export function buildFightReport({ fight: f, log, learned = null, sim = null }) {
    const out = [];
    const H = (level, title) => out.push(`${'#'.repeat(level)} ${title}`, '');
    const P = (...lines) => out.push(...lines.filter(Boolean), '');
    const T = (head, rows, align = []) => {
        if (!rows.length) return;
        out.push(`| ${head.join(' | ')} |`);
        out.push(`| ${head.map((_, i) => (align[i] === 1 ? '---:' : '---')).join(' | ')} |`);
        for (const r of rows) out.push(`| ${r.join(' | ')} |`);
        out.push('');
    };
    const pc = (x) => `${Math.round((x || 0) * 100)} %`;
    const sec = (cs) => `${(cs / 100).toFixed(2).replace('.', ',')} s`;

    const when = new Date((f.at || 0) * 1000).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
    H(1, `Combat ${f.id} — ${f.role} contre ${f.opponent.name} (${when})`);
    P('*Compte rendu généré par [sss-play-check] pour être analysé par un agent IA. « mesuré » = lu'
        + ' dans les données servies par le jeu ; « modélisé » = simulateur dont la fiabilité est'
        + ' chiffrée plus bas. Je cherche un avis concret : pourquoi cette issue, et quoi changer.*');

    /* ---------- Contexte et issue ---------- */
    H(2, 'Issue — mesuré');
    const myStart = f.myPiles.reduce((a, p) => a + p.hp, 0) / (f.myPiles.reduce((a, p) => a + p.max, 0) || 1);
    P(`- **${f.won ? 'Victoire' : 'Défaite'}** en ${f.seconds.toFixed(2).replace('.', ',')} s · `
        + `${f.delta >= 0 ? '+' : ''}${f.delta} points · rôle : **${f.role}** (adversaire niveau ${f.opponent.level}, moi niveau ${f.myLevel})`,
    `- fortifications : les miennes ${f.fort.mine || 0} %, les siennes ${f.fort.theirs || 0} % `
        + `(la fortification réduit les dégâts REÇUS par son propriétaire ; en attaque seules les siennes comptent)`,
    f.role === 'défense' ? `- plancher du poste de garde : ${f.guard || 0} % · mes troupes ont encaissé à **${pc(myStart)}** de leurs PV (récupération inachevée)` : null,
    f.raid ? `- pillage : ${f.raid} bâtiment(s), butin ${lootText(f.loot)}` : null);

    /* ---------- Les deux armées ---------- */
    const crits = { mine: new Map(), theirs: new Map() };
    const mySide = f.role === 'attaque' ? 'att' : 'def';
    for (const l of log?.lines || []) {
        if (l.kind !== 'hit' || l.riposte) continue;
        const who = l.side === mySide ? 'mine' : 'theirs';
        const k = String(l.from).replace(/@.*/, '');
        const e = crits[who].get(k) || crits[who].set(k, { hits: 0, crits: 0 }).get(k);
        e.hits += 1;
        if (l.crit) e.crits += 1;
    }
    const armyTable = (piles, who, abOn) => T(
        ['Type', 'Rôle', 'Qté', 'Niv. type', 'PV/unité', 'PV départ', 'Cadence', 'Dégâts infligés', 'subis', 'coups', 'crits', 'Capacité'],
        piles.map((p) => {
            const c = crits[who].get(p.base);
            return [
                esc(p.base) + (p.reinforcement ? ' *(renfort)*' : ''),
                ROLE_FR[p.role] || p.role || '—',
                fr(p.qty), p.typeLevel ?? '—', fr(p.unitHp), pc(p.hp / (p.max || 1)),
                p.intervalCs ? sec(p.intervalCs) : '—',
                fr(p.dealt), fr(p.taken), fr(p.hits),
                c ? `${c.crits}/${c.hits}` : '—',
                p.ability
                    ? `${ABILITY_FR[p.ability] || p.ability}${(abOn || []).includes(p.ability) ? ' ✓' : ' (éteinte)'}`
                    : '—',
            ];
        }),
        [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    );
    const gearLines = (piles) => piles
        .filter((p) => (p.gear || []).some((g) => Object.keys(g.affixes || {}).length))
        .map((p) => `- **${p.base}** : ${p.gear.map((g) => `${g.name} (${g.rarityFr || g.rarity}${(g.bonuses || []).length ? ` : ${g.bonuses.join(', ')}` : ''})`).join(' · ')}`);

    H(2, 'Mon armée — mesuré');
    armyTable(f.myPiles, 'mine', f.abOn);
    const myGear = gearLines(f.myPiles);
    if (myGear.length) P('Équipement à affixes :', ...myGear);

    H(2, `Son armée (${f.opponent.name}) — mesuré`);
    armyTable(f.theirPiles, 'theirs', f.abOnTheirs);
    const theirGear = gearLines(f.theirPiles);
    if (theirGear.length) P('Équipement à affixes :', ...theirGear);
    if (learned) {
        P(`**Ce que ses journaux révèlent (mesuré sur ${learned.fights} combat(s) contre lui)** : facteur de`
            + ` dégâts ×${String(learned.factorMedian ?? '?').replace('.', ',')} par rapport à ce que sa carte`
            + ` explique (la signature de ses talents d'attaque, invisibles dans les PV servis)`
            + `${learned.critMult ? ` · multiplicateur critique ×${learned.critMult === 2 ? '2,0 (talent Executioner)' : '1,5'}` : ''}.`
            + ` Détail par type : ${learned.types.map((t) => `${t.base} ×${String(t.factor ?? '?').replace('.', ',')}`).join(', ')}.`);
    }

    /* ---------- Capacités et journal ---------- */
    if (f.abilityEvents?.length || log?.lines?.some((l) => l.kind === 'ability')) {
        H(2, 'Capacités déclenchées — mesuré');
        for (const l of (log?.lines || []).filter((x) => x.kind === 'ability')) {
            out.push(`- ${sec(l.t)} · ${esc(l.text)}`);
        }
        out.push('');
    }

    if (log?.lines?.length) {
        H(2, 'Journal coup par coup — mesuré (rédigé par le jeu)');
        P(`${log.counts.hits} coups, ${log.counts.crits} critiques (${Math.round((100 * log.counts.crits) / (log.counts.hits || 1))} %),`
            + ` ${log.counts.ripostes} ripostes, ${fr(log.counts.ko)} unités KO.`);
        out.push('```');
        for (const l of log.lines) {
            if (l.kind === 'ability') { out.push(`${sec(l.t)}  [capacité] ${l.text}`); continue; }
            if (l.kind === 'end') { out.push(`${sec(l.t)}  [fin] ${l.text}`); continue; }
            if (l.kind !== 'hit') continue;
            const who = l.side === mySide ? 'moi ' : 'lui ';
            out.push(`${sec(l.t)}  ${who} ${l.from}${l.fromQty ? ` x${l.fromQty}` : ''} ${l.riposte ? 'riposte sur' : 'frappe'} `
                + `${l.to}${l.toQty ? ` x${l.toQty}` : ''} : ${l.dmg ? fr(l.dmg) : 'absorbé (bouclier)'}`
                + `${l.crit ? ' CRITIQUE' : ''}${l.ko ? ` (${l.ko} KO)` : ''}${l.heal ? ` soin +${fr(l.heal)}` : ''}`);
        }
        out.push('```', '');
    }

    /* ---------- L'avis du simulateur ---------- */
    if (sim) {
        H(2, 'Ce que le simulateur en dit — modélisé');
        P('Le moteur rejoue les mécaniques exactes du jeu (rétro-conçues et vérifiées à l’unité près'
            + ' sur l’archive : tirages uniformes min…max, vivants = ceil(PV ÷ PV unitaire), riposte'
            + ' min(cible, attaquant) × 0,6, bouclier en pool commun de 8 % des PV de départ, seuils'
            + ' mesurés des capacités). Fiabilité sur tout l’historique, informations d’avant-combat'
            + ` seulement (leave-one-out) : ${sim.backtest.accuracy} % de bons vainqueurs, AUC ${sim.backtest.separation},`
            + ` Brier ${sim.backtest.brier}.`);
        if (sim.mc) {
            P(`- **Ce combat rejoué tel quel** (${sim.mc.runs} tirages réels) : je gagne `
                + `**${String(sim.mc.pWin).replace('.', ',')} %** du temps (marge médiane ${String(sim.mc.margin).replace('.', ',')}). `
                + `Issue réelle : ${f.won ? 'victoire' : 'défaite'}.`);
        }
        if (sim.best?.length) {
            P(`- **Meilleure composition trouvée contre ce combat précis** (${fr(sim.screened)} testées, mêmes murs`
                + `${f.role === 'défense' ? ', même forme de troupes' : ''}) :`);
            for (const b of sim.best) {
                out.push(`  - ${b.types.map((t) => `${t.fr} ×${fr(t.qty)}`).join(' + ')} → `
                    + `**${String(b.pWin).replace('.', ',')} % de victoires** (marge ${String(b.margin).replace('.', ',')})`);
            }
            out.push('');
        }
        if (sim.healed) {
            P(`- **Avec des troupes soignées** (100 % des PV au lieu de ${Math.round((sim.readiness || 1) * 100)} %), la`
                + ` meilleure composition gagnerait ${String(sim.healed.pWin).replace('.', ',')} % du temps — le levier`
                + ' était la récupération, pas la composition.');
        }
    }

    /* ---------- Rappels et questions ---------- */
    H(2, 'Limites connues');
    P('- Le jeu tire dégâts et critiques au hasard : la même situation peut basculer dans les deux sens.'
        + ' Toute recommandation doit raisonner en probabilités, pas en certitudes.',
    '- Les renforts de famille (piles marquées *renfort*) ne se choisissent pas : ils ne font pas partie'
        + ' d’une composition recommandable.',
    '- Le bonus intrinsèque des objets n’est pas publié par le jeu ; il est capté indirectement'
        + ' (PV servis, cadence mesurée, facteur de dégâts appris).');

    H(2, 'Questions à l’agent');
    P(`1. Pourquoi cette ${f.won ? 'victoire' : 'défaite'} ? Désigne le facteur dominant (composition,`
        + ' forme des troupes, capacités éteintes, équipement, simple tirage).',
    '2. Qu’est-ce qui aurait le plus changé l’issue, à coût réaliste ?',
    `3. Face à ce joueur précis (${f.opponent.name}), quelle composition et quelles priorités`
        + ' (talents, équipement) recommandes-tu pour la prochaine fois ?',
    '4. Y a-t-il un signal dans le journal coup par coup que je devrais exploiter ?');

    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Le butin, quel que soit son format (tableau de {res, value} ou objet {res: valeur}). */
function lootText(loot) {
    if (Array.isArray(loot)) return loot.map((l) => `${l.value} ${l.res}`).join(', ') || '—';
    if (loot && typeof loot === 'object') {
        return Object.entries(loot).map(([k, v]) => `${fr(v)} ${k}`).join(', ') || '—';
    }
    return '—';
}

/* ---------- Petits utilitaires ---------- */

function defenseReadiness(analysis) {
    const xs = analysis.fights.filter((f) => f.role === 'défense')
        .map((f) => f.myPiles.reduce((a, p) => a + p.hp, 0) / (f.myPiles.reduce((a, p) => a + p.max, 0) || 1))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    return xs.length ? xs[xs.length >> 1] : 1;
}

function cost(c) {
    const labels = { cash: '$', alcohol: 'alcool', weed: 'herbe', powder: 'poudre', gems: 'gemmes' };
    const parts = Object.entries(c || {}).filter(([, v]) => v > 0).map(([k, v]) => `${fr(v)} ${labels[k] || k}`);
    return parts.join(' · ') || 'gratuit';
}

function hours(seconds) {
    if (!Number.isFinite(seconds)) return '?';
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

const fr = (n) => (Number.isFinite(n) ? n.toLocaleString('fr-FR') : String(n ?? '—'));
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const stamp = () => new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

export { RESOURCES };
