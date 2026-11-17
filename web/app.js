/* Interface du poste de commandement.
   Le serveur local sert les données ; cette page ne fait que lire, afficher et déclencher.
   Le rendu Markdown est fait maison : les documents sont générés par ce dépôt, on connaît donc
   exactement le sous-ensemble utilisé (titres, listes, tableaux, citations, gras, liens, code). */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
    analysis: null, backtest: null, compos: null, docs: {}, busy: null,
    enemies: null, enemy: null, hq: null,
};

/* ── Démarrage ─────────────────────────────────────────────────────────────── */

init();

async function init() {
    wireNav();
    wireActions();
    wireConsole();
    listenEvents();
    await refreshState();
    show(location.hash.slice(1) || 'tableau');
}

/* ── Navigation ────────────────────────────────────────────────────────────── */

/* Adresse d'où l'on vient. Le bouton « Retour » d'une sous-page s'en sert pour choisir entre deux
   gestes qui ne se valent pas : si on arrive bien de la liste annoncée sur le bouton,
   `history.back()` la rend **avec sa position de défilement** ; sinon on pose son adresse. Un
   bouton qui dit « Tous les adversaires » doit mener là, pas à la page précédente quelle qu'elle
   soit — sans quoi il ment, et il peut même faire sortir du site. */
let previousRoute = null;
/* Un retour en arrière doit rendre la liste là où on l'avait laissée — sur un tableau de 68
   lignes, repartir du haut annule l'intérêt du bouton. Le navigateur sait restaurer la position
   tout seul sur une navigation d'historique ; il suffit de ne pas la lui écraser. */
let restoringScroll = false;

function wireNav() {
    addEventListener('hashchange', (e) => {
        previousRoute = new URL(e.oldURL).hash.slice(1) || 'tableau';
        show(location.hash.slice(1) || 'tableau');
    });
}

const VIEWS = {
    tableau: { title: 'Tableau de bord' },
    qg: { title: 'Le QG' },
    analyse: { title: 'Analyse des combats' },
    adversaires: { title: 'Adversaires' },
    simulateur: { title: 'Simulateur' },
    compos: { title: 'Compositions' },
    regles: { title: 'Les règles', doc: 'regles.md' },
    troupes: { title: 'Les troupes', doc: 'troupes.md' },
    objets: { title: 'Les objets', doc: 'objets.md' },
    /* Sous-pages : elles ont leur propre adresse (`#combat/11060`), donc le bouton « Retour »
       et celui du navigateur font la même chose, et un lien se partage. `parent` sert à garder
       l'entrée de menu correspondante allumée. */
    combat: { title: 'Combat', parent: 'analyse', arg: true },
    adversaire: { title: 'Adversaire', parent: 'adversaires', arg: true },
};

/* Une vue se remplit toute seule à la première visite : plus de bouton « Analyser » à cliquer
   avant de voir quoi que ce soit. Tout ce qui est affiché ici se calcule hors ligne, à partir de
   data/ — le seul geste qui demande le jeu est « Mettre à jour ». */
async function show(route) {
    const [name, arg] = String(route || '').split('/');
    const view = VIEWS[name] ? name : 'tableau';
    const meta = VIEWS[view];

    for (const el of $$('.view')) el.hidden = el.id !== `view-${view}`;
    // Une sous-page garde allumée l'entrée de menu dont elle dépend.
    const current = meta.parent || view;
    for (const a of $$('.nav a')) {
        if (a.dataset.view === current) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
    document.title = `SSS — ${meta.title}`;

    if (meta.doc) await openDoc(view, meta.doc);
    if (view === 'analyse' && !state.analysis) await runAnalyse({ silent: true });
    if (view === 'adversaires' && !state.enemies) await loadEnemies();
    if (view === 'simulateur' && !simu.types) await loadSimu();
    if (view === 'qg' && !state.hq) await loadHq();
    if (view === 'compos' && !state.compos) await runCompos({ silent: true });
    if (view === 'combat') await openFight(arg);
    if (view === 'adversaire') await openEnemy(arg);
    if (restoringScroll) restoringScroll = false;
    else scrollTo({ top: 0, behavior: 'instant' });
}

/* Bouton « Retour » d'une sous-page. On passe par l'historique du navigateur quand on peut : ça
   rend la position de défilement de la liste, ce qu'un simple changement d'adresse ne ferait pas.
   Si ça n'a pas bougé (page ouverte directement par son lien), on remonte à la vue parente. */
function backLink(to, label) {
    return `<button type="button" class="back-btn" data-back="${esc(to)}">
        <span aria-hidden="true">←</span> ${esc(label)}</button>`;
}

function wireBack(host) {
    for (const b of $$('[data-back]', host)) {
        b.addEventListener('click', () => {
            const to = b.dataset.back;
            if (previousRoute === to) {
                restoringScroll = true;
                history.back();
            } else location.hash = to;
        });
    }
}

/* ── Actions ───────────────────────────────────────────────────────────────── */

function wireActions() {
    for (const btn of $$('[data-action]')) {
        btn.addEventListener('click', () => act(btn.dataset.action, btn));
    }
}

async function act(action, btn) {
    const jobs = {
        'update-all': () => post('update-all'),
        'fetch-fights': () => post('fetch-fights'),
        'fetch-fights-refresh': () => post('fetch-fights?refresh=1'),
        'fetch-troops': () => post('fetch-troops'),
        'fetch-rules': () => post('fetch-rules?locale=fr'),
        'rebuild-enemies': () => post('rebuild-enemies'),
        'fetch-assets': () => post('fetch-assets'),
        'fetch-hq': () => post('fetch-hq'),
    };
    if (!jobs[action]) return;
    const others = $$('[data-action]');
    for (const b of others) b.disabled = true;
    try {
        await jobs[action]();
    } catch (e) {
        toast(e.message, 'bad');
    } finally {
        for (const b of others) b.disabled = false;
        if (btn) btn.blur();
    }
}

async function post(route) {
    openConsole();
    const res = await api(`/api/${route}`, { method: 'POST' });
    await refreshState();
    // Les données ont changé : on invalide ce qui en dépend.
    state.analysis = null;
    state.compos = null;
    state.enemies = null;
    state.enemy = null;
    state.hq = null;
    simu.types = null;
    simu.result = null;
    state.docs = {};
    toast(summarise(route, res.result), 'good');
    return res;
}

function summarise(route, result) {
    if (route.startsWith('update-all')) {
        return [
            fightsLine(result?.fights),
            `${result?.troops?.units ?? '?'} unités`,
            result?.hq ? `QG niveau ${result.hq.level}` : null,
        ].filter(Boolean).join(' · ');
    }
    if (route.startsWith('fetch-fights')) return fightsLine(result);
    if (route.startsWith('fetch-troops')) return `${result?.units ?? '?'} unités relevées.`;
    if (route.startsWith('fetch-rules')) return `Règles régénérées (${result?.sections ?? '?'} sections).`;
    if (route.startsWith('rebuild-enemies')) {
        return `${result?.enemies ?? '?'} adversaires, ${result?.changes ?? '?'} changements de troupes, ${result?.items ?? '?'} objets.`;
    }
    if (route.startsWith('fetch-hq')) {
        return `Niveau ${result?.level ?? '?'} · ${result?.buildings ?? '?'} bâtiments`
            + (result?.skillPoints ? ` · ${result.skillPoints} point(s) de compétence libre(s)` : '');
    }
    if (route.startsWith('fetch-assets')) {
        return result?.downloaded
            ? `${result.downloaded} image(s) téléchargée(s) · ${result.total} en local.`
            : `Rien de neuf : les ${result?.total ?? '?'} images sont déjà en local.`;
    }
    return 'Terminé.';
}

function fightsLine(r) {
    if (!r) return 'Terminé.';
    const n = r.downloaded;
    const head = n
        ? `${n} nouveau(x) combat(s) · ${r.total} en base`
        : `Rien de neuf : les ${r.listed ?? '?'} combats de la fenêtre étaient déjà en base`;
    return r.holes?.length ? `${head} — <strong>trou détecté dans l’historique</strong>` : head;
}

/* ── État global ───────────────────────────────────────────────────────────── */

async function refreshState() {
    const s = await api('/api/state');
    state.server = s;
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
    $('#rail-stats').innerHTML = [
        ['Compte', s.account ? `${s.account} · niv. ${s.level ?? '?'}` : '—'],
        ['Places', s.crew?.slots ? `${s.crew.used ?? '?'} / ${s.crew.slots}` : '—'],
        ['Types', s.crew?.typeSlots ? `${s.crew.typesUsed ?? '?'} / ${s.crew.typeSlots}` : '—'],
        ['Combats', String(s.fights.count)],
        ['Relevé le', fmt(s.troops.updatedAt)],
    ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    renderResBar();
    renderDashSummary();
    return s;
}

/* Barre de ressources, visible depuis n'importe quelle page. Les stocks conditionnent presque
   toutes les décisions du jeu — recruter, construire, améliorer — donc ils ne doivent jamais
   demander un détour par une autre vue. Un stock plein s'y signale : la production est perdue. */
function renderResBar() {
    const bar = $('#resbar');
    const res = state.server?.hq?.resources;
    if (!res?.length) { bar.hidden = true; return; }
    bar.hidden = false;
    const hq = state.server.hq;
    bar.innerHTML = `
        ${res.map((r) => `
            <a class="rb-item${r.full ? ' is-full' : ''}" href="#qg"
                title="${esc(r.fr)}${r.cap ? ` — ${num(r.value)} sur ${num(r.cap)}` : ''}${r.perTurn ? ` · +${num(r.perTurn)} par tour` : ''}${r.full ? ' — stock plein, la production est perdue' : ''}">
                <img src="/assets/res/${esc(r.icon)}.webp" alt="${esc(r.fr)}" width="22" height="22"
                    loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('b'),{className:'rb-fallback',textContent:'${esc(r.fr.slice(0, 1))}'}))">
                <span class="rb-val">${num(r.value)}</span>
                ${r.cap ? `<span class="rb-bar"><i style="width:${Math.min(100, r.pct || 0)}%"></i></span>` : ''}
            </a>`).join('')}
        <span class="rb-sep" aria-hidden="true"></span>
        <a class="rb-item rb-meta" href="#qg" title="Niveau du personnage">
            <span class="rb-key">niv.</span><span class="rb-val">${num(hq.level)}</span></a>
        <a class="rb-item rb-meta" href="#qg" title="Classement">
            <span class="rb-key">pts</span><span class="rb-val">${num(hq.rating)}</span></a>
        ${hq.skillPoints ? `<a class="rb-item rb-alert" href="#qg"
            title="Points de compétence non dépensés"><span class="rb-key">compétence</span>
            <span class="rb-val">${num(hq.skillPoints)}</span></a>` : ''}
        <span class="rb-when" title="Dernier relevé du QG">${hq.updatedAt ? esc(fmtDate(hq.updatedAt)) : ''}</span>`;
}

function renderDashSummary() {
    const s = state.server;
    const box = $('#dash-summary');
    if (!s) return;
    const warn = [];
    if (!s.fights.count) warn.push('Aucun combat en base : clique sur <strong>Mettre à jour</strong>.');
    if (s.hq?.skillPoints) {
        warn.push(`<strong>${s.hq.skillPoints} point(s) de compétence non dépensé(s)</strong> — `
            + 'voir <a href="#qg">Le QG</a>.');
    }
    if (s.hq?.full?.length) {
        warn.push(`Stock plein : <strong>${s.hq.full.join(', ')}</strong>. La production correspondante est perdue.`);
    }
    if (s.fights.count && !s.assets?.count) {
        warn.push('Aucune image en local : les vignettes de troupes, icônes d’objets et photos de profil '
            + 'manqueront dans l’interface. <strong>Mettre à jour</strong> les récupère.');
    }
    else if (!s.troops.detailed) warn.push('Aucune fiche de troupe : <strong>Mettre à jour</strong> les relèvera.');
    if (s.enemies?.stale) {
        warn.push('Les fiches d’adversaires datent d’avant le dernier téléchargement de combats : '
            + '<strong>Reconstruire les fiches</strong> (actions détaillées) les remet à jour.');
    }

    box.innerHTML = `
        <h2 class="block">En base</h2>
        <div class="tiles">
            ${tile('Combats archivés', s.fights.count, s.fights.counts
        ? `${s.fights.counts.attack ?? s.fights.counts.sent ?? 0} en attaque · ${s.fights.counts.defense ?? s.fights.counts.received ?? 0} en défense`
        : 'le jeu n’expose qu’une fenêtre récente')}
            ${tile('Adversaires suivis', s.enemies?.count ?? 0, `${s.enemies?.changes ?? 0} changements de troupes relevés`)}
            ${tile('Objets catalogués', s.items?.count ?? 0, 'armes, protections et porte-bonheur vus en combat')}
            ${tile('Fiches de troupes', `${s.troops.detailed}<small>/ ${s.troops.count}</small>`, 'chiffrées / relevées')}
            ${tile('QG', s.hq?.level ? `niveau ${s.hq.level}` : '—', s.hq
        ? `${s.hq.buildings} bâtiments · classement ${num(s.hq.rating)}${s.hq.skillPoints ? ` · ${s.hq.skillPoints} point(s) libre(s)` : ''}`
        : 'lance « Mettre à jour »', { tone: s.hq?.skillPoints ? 'bad' : null })}
            ${tile('Images en local', s.assets?.count ?? 0, s.assets?.counts
        ? `${s.assets.counts.portrait ?? 0} portraits · ${s.assets.counts.vignette ?? 0} vignettes · ${s.assets.counts.avatar ?? 0} avatars`
        : 'lance « Mettre à jour » pour les récupérer')}
        </div>
        ${resumeCard(s)}
        ${warn.length ? `<div class="stack" style="margin-top:1rem">${warn.map((w) => callout(w, 'bad')).join('')}</div>` : ''}`;
}

/* La reprise incrémentale est la promesse centrale du dépôt : elle doit se vérifier d'un coup
   d'œil, pas se deviner. On montre d'où le prochain run repartira, ce que la fenêtre du jeu
   couvrait au dernier passage, et tout trou constaté. */
function resumeCard(s) {
    const f = s.fights;
    const run = f.lastRun;
    const dirs = Object.entries(f.window || {});
    const holes = f.holes || [];
    const span = f.counts?.firstFightAt && f.counts?.lastFightAt
        ? `du ${when(f.counts.firstFightAt)} au ${when(f.counts.lastFightAt)}`
        : null;

    return `
        <h2 class="block">Reprise de l’historique</h2>
        <div class="cards">
            <div class="card">
                <h3>Où en est l’archive</h3>
                <p>${f.count} combats accumulés${span ? `, ${span}` : ''}.
                    ${run ? `Dernier passage le <strong>${fmtDate(run.at)}</strong> :
                        ${run.listed} combats listés, ${run.downloaded} téléchargés${run.failed ? `, ${run.failed} en échec` : ''}.`
        : 'Aucun passage enregistré par cette version du script : le prochain en posera le repère.'}</p>
                <p class="note">Le prochain passage ne redemandera au jeu que les combats plus récents
                    que ${f.watermark && Object.keys(f.watermark).length
        ? Object.entries(f.watermark).map(([d, id]) => `<code>${esc(d)} &gt; ${id}</code>`).join(', ')
        : '<code>—</code>'}. Les combats déjà en base y restent même quand le jeu ne les montre plus.</p>
            </div>
            <div class="card">
                <h3>La fenêtre du jeu</h3>
                ${dirs.length ? dirs.map(([dir, w]) => `<p><strong>${esc(dir)}</strong> — ${w.size} lignes
                    (ids ${w.oldestId} → ${w.newestId}), dont ${w.alreadyKnown} déjà en base au dernier passage.</p>`).join('')
        : '<p class="note">Mesurée au prochain passage.</p>'}
                <p class="note">Le serveur n’expose pas de pagination : il ne montre qu’une fenêtre fixe
                    des combats récents. Plus tu attends entre deux mises à jour, plus tu risques d’en
                    perdre définitivement — c’est le seul point où l’archive peut avoir des trous.</p>
            </div>
            ${holes.length ? `<div class="card">
                <h3 class="v-bad">Trous constatés</h3>
                ${holes.slice(-5).map((h) => `<p><strong>${esc(h.dir)}</strong> — dernier combat connu
                    ${h.lastKnownId}, la fenêtre ne remontait qu’au ${h.oldestListedId} : les combats entre
                    les deux ne sont plus exposés par le jeu.</p>`).join('')}
                <p class="note">Seule parade : mettre à jour plus souvent (la fenêtre fait
                    ${holes[holes.length - 1].windowSize} lignes par onglet).</p>
            </div>` : ''}
        </div>`;
}

/* ── Analyse ───────────────────────────────────────────────────────────────── */

async function runAnalyse({ silent = false } = {}) {
    const res = await api('/api/analyse');
    if (res.empty) {
        $('#analyse-body').innerHTML = callout(res.reason, 'bad');
        if (!silent) { location.hash = 'analyse'; }
        return;
    }
    state.analysis = res.analysis;
    state.backtest = res.backtest;
    state.learned = res.learned || [];
    state.skills = res.skills || null;
    renderAnalyse();
    if (!silent) location.hash = 'analyse';
}

function renderAnalyse() {
    const a = state.analysis;
    const r = a.record;
    const bt = state.backtest;
    const body = $('#analyse-body');

    const worst = r.attack.winRate > r.defense.winRate ? 'défense' : 'attaque';
    const diag = r.defense.winRate < 40 && r.attack.winRate > 55
        ? `Tes attaques passent (${r.attack.winRate} %) mais ta <strong>défense s’effondre</strong> (${r.defense.winRate} %). `
          + `La cause est mesurable : tes troupes encaissent les attaques à <strong>${pct(readiness(a))}</strong> de leurs PV, `
          + 'parce qu’elles n’ont pas fini de récupérer du combat précédent, alors qu’un attaquant arrive toujours à 100 %.'
        : `Le point faible est en ${worst}.`;

    body.innerHTML = `
        <div class="tiles">
            ${tile('Bilan global', `${r.winRate}<small>%</small>`, `${r.wins} victoires · ${r.losses} défaites`, {
        hero: true, tone: r.winRate >= 50 ? 'good' : 'bad', meter: r.winRate,
    })}
            ${tile('En attaque', `${r.attack.winRate}<small>%</small>`, `${r.attack.wins} / ${r.attack.fights} combats`, {
        tone: r.attack.winRate >= 50 ? 'good' : 'bad', meter: r.attack.winRate,
    })}
            ${tile('En défense', `${r.defense.winRate}<small>%</small>`, `${r.defense.wins} / ${r.defense.fights} combats`, {
        tone: r.defense.winRate >= 50 ? 'good' : 'bad', meter: r.defense.winRate,
    })}
            ${tile('Points', `${a.points.net >= 0 ? '+' : ''}${a.points.net}`, `${a.points.perFight} par combat · ${a.points.attack >= 0 ? '+' : ''}${a.points.attack} en attaque, ${a.points.defense} en défense`, {
        tone: a.points.net >= 0 ? 'good' : 'bad',
    })}
            ${tile('Série en cours', `${r.streak.n}`, r.streak.kind, { tone: r.streak.kind === 'victoires' ? 'good' : 'bad' })}
            ${tile('Armée adverse', `×${(r.armyGap || 1).toFixed(2)}`, 'PV adverses / mes PV, en médiane')}
        </div>

        ${callout(diag, r.defense.winRate < 40 ? 'bad' : null)}

        <h2 class="block">Les ${a.fights.length} combats</h2>
        <p class="note">Clique sur une ligne pour ouvrir le <strong>journal du combat</strong>, tel que le
            jeu l’a rédigé — avec les coups critiques et les unités mises KO, que le rapport JSON ne donne pas.</p>
        ${dataTable(
        ['Quand', 'Rôle', 'Issue', 'Adversaire', 'Niv.', 'Points', 'Ma compo', 'Mes PV au départ', 'Capacités actives'],
        a.fights.map((f) => [
            `<span style="color:var(--text-3)">${esc(when(f.at))}</span>`,
            esc(f.role),
            f.won ? '<span class="chip chip-on">Victoire</span>' : '<span class="chip chip-off">Défaite</span>',
            `<span class="who">${avatarChip(f.opponent.avatar, f.opponent.name, { size: 'sm' })}
                <span>${esc(f.opponent.name)}</span></span>`,
            num(f.opponent.level),
            `<span class="${f.delta >= 0 ? 'v-good' : 'v-bad'}">${f.delta >= 0 ? '+' : ''}${f.delta}</span>`,
            f.myPiles.filter((p) => !p.reinforcement).map((p) => `${esc(p.base)}&nbsp;×${p.qty}`).join(', '),
            pct(f.myPiles.reduce((s, p) => s + p.hp, 0) / (f.myPiles.reduce((s, p) => s + p.max, 0) || 1)),
            f.abOn.length ? f.abOn.length : '<span class="v-bad">0</span>',
        ]),
        [0, 0, 0, 0, 1, 1, 0, 1, 1],
        'wrap-6',
        { rowLink: a.fights.map((f) => `#combat/${f.id}`) },
    )}

        <h2 class="block">Capacités spéciales</h2>
        <p class="note">Une capacité n’agit que si le type engagé atteint <strong>10 % de tes places de troupes</strong>
            (${a.abilities.needMedian} unités en médiane sur cet historique). En dessous, elle ne fait rien — et la place
            est payée pour rien. C’est le serveur lui-même qui indique, combat par combat, celles qui ont fonctionné.</p>
        <div class="cards">
            <div class="card">
                <h3>Ont fonctionné</h3>
                ${a.abilities.fired.length ? a.abilities.fired.map((f) => meterRow(f.fr, f.rate, `${f.fights} combats`, 'good')).join('') : '<p>Aucune.</p>'}
            </div>
            <div class="card">
                <h3>Éteintes</h3>
                ${a.abilities.wasted.length ? a.abilities.wasted.map((w) => `
                    <p><strong>${esc(w.fr)}</strong> — ${w.fights} combats sans effet :
                    ${w.qtyMedian} unités de <code>${esc(w.type)}</code> pour ${w.needMedian} requises,
                    <span class="v-bad">il en manquait ${w.missing}</span>.</p>`).join('')
        : '<p>Aucune : toutes tes capacités se déclenchent.</p>'}
            </div>
            <div class="card">
                <h3>Celles d’en face</h3>
                ${a.abilities.theirs.slice(0, 6).map((t) => meterRow(t.fr, t.rate, `${t.fights} combats`)).join('')}
            </div>
        </div>

        <h2 class="block">Rendement de mes types</h2>
        ${dataTable(
        ['Type', 'Rôle', 'Capacité', 'Niv. type', 'Combats', 'Qté méd.', 'Part des dégâts', 'Dégâts / unité', 'Subis / unité', 'Échange', 'Cap. active'],
        a.myTypes.map((t) => [
            unitChip(t.key, t.fr),
            `<span class="chip chip-role">${esc(t.roleFr)}</span>`,
            esc(t.abilityFr || '—'),
            levelCell(t.typeLevel),
            num(t.fights),
            num(t.qtyMedian),
            barCell(t.damageShare, Math.max(...a.myTypes.map((x) => x.damageShare)), `${t.damageShare} %`),
            num(t.dealtPerUnit),
            num(t.takenPerUnit),
            `<span class="${t.trade >= 1 ? 'v-good' : 'v-bad'}">${t.trade}</span>`,
            t.abilityFireRate >= 99 ? '<span class="chip chip-on">✓ 100 %</span>'
                : `<span class="chip chip-off">${t.abilityFireRate} %</span>`,
        ]),
        [0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0],
    )}
        <p class="note"><strong>Échange</strong> = dégâts infligés ÷ dégâts subis par ce type. Au-dessus de 1, il rend
            plus qu’il ne prend. <strong>Dégâts / unité</strong> cumule tout l’historique : un type souvent engagé en
            petit nombre et balayé tôt y paraît faible même s’il frappe fort.</p>

        <h2 class="block">Le vivier que tu affrontes</h2>
        <p class="note">C’est contre ces armées-là qu’une composition doit gagner — pas contre une cible théorique.
            Écart de niveau médian : ${a.opponents.levelGap >= 0 ? '+' : ''}${a.opponents.levelGap}.
            Fortification médiane en face : ${a.opponents.fortMedian ?? 0} % de dégâts en moins quand tu attaques.</p>
        ${dataTable(
        ['Type adverse', 'Rôle', 'Capacité', 'Niv. type', 'Rencontré', 'Qté méd.', 'PV / unité', 'Dégâts / coup', 'Cadence', 'Bonus d’objets moyens', 'Pièces les plus portées', 'Renforts'],
        a.opponents.pool.map((o) => [
            unitChip(o.key, o.key),
            `<span class="chip chip-role">${esc(o.roleFr)}</span>`,
            esc(o.abilityFr || '—'),
            levelCell(o.typeLevel),
            barCell(o.fights, Math.max(...a.opponents.pool.map((x) => x.fights)), `${o.fights} piles`),
            num(o.qtyMedian),
            num(o.unitHpMedian),
            num(o.dpuPerHit),
            o.intervalMedian ? `${String(o.intervalMedian).replace('.', ',')} s` : '—',
            bonusCell(o.gearBonuses),
            (o.topItems || []).map((i) => esc(i.name)).join(', ') || '—',
            o.reinforcements ? num(o.reinforcements) : '—',
        ]),
        [0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1],
    )}
        ${gearCallout(a.opponents.gear)}

        ${talentsCard(state.skills, bt)}

        ${bt ? backtestCard(bt) : ''}

        ${learnedCard(state.learned)}

        <h2 class="block">Ce que l’historique dit du moteur</h2>
        <p class="note">Les mécaniques ci-dessous ne sont pas supposées : elles sont <strong>mesurées</strong>
            dans les frises de coups et les journaux de tes combats, et c’est exactement ce que le
            simulateur rejoue. La comptabilité (vivants, KO, boucliers, soins) tombe à l’unité près.</p>
        <div class="cards">
            ${[
        ['Formule de dégâts', a.mechanics.damageFormula],
        ['Cadence de frappe', a.mechanics.timing],
        ['Riposte', a.mechanics.counter],
        ['Bouclier', a.mechanics.shield],
        ['Coups critiques', a.mechanics.critMult],
        ['Talents adverses', a.mechanics.opponentTalents],
        ['Triangle des rôles', a.mechanics.roleEffectOnDamage],
        ['Choix de la cible', a.mechanics.targeting],
        ['Durée d’un combat', `${a.mechanics.medianFightSeconds} s en médiane (le temps est compté en centièmes de seconde)`],
    ].filter(([, p]) => p).map(([h, p]) => `<div class="card"><h3>${esc(h)}</h3><p>${p}</p></div>`).join('')}
            <div class="card">
                <h3>Amplitudes des capacités</h3>
                ${Object.entries(a.mechanics.abilityMagnitudes).map(([k, v]) => `<p><code>${esc(k)}</code> — ${esc(v)}</p>`).join('')}
            </div>
            <div class="card">
                <h3>Dégâts selon le rôle visé</h3>
                ${dataTable(['Attaquant', 'Cible', 'Coups', 'Rapport'],
        a.mechanics.matchups.map((m) => [esc(m.fromFr), esc(m.toFr), num(m.hits), m.ratio.toFixed(3)]), [0, 0, 1, 1])}
            </div>
        </div>

        `;

    wireRowLinks(body);
}

/* Les talents sont la troisième source de puissance, à côté du niveau de type et de l'équipement.
   Sans eux, l'écart entre les stats « de base » et les stats « réelles » d'une carte restait un
   trou noir où talents et objets se confondaient. */
function talentsCard(sk, bt) {
    if (!sk) {
        return callout(`<strong>Arbre de talents inconnu.</strong> Lance <strong>Mettre à jour</strong> :
            le simulateur pourra alors séparer ce qui vient de tes talents de ce qui vient de ton
            équipement, au lieu de tout mettre dans le même sac.`, 'bad');
    }
    const b = sk.bonuses;
    const rows = [
        ['Dégâts', `+${b.dmgPct} %`, b.dmgFlat ? `et +${b.dmgFlat} par coup, ajoutés avant le pourcentage` : ''],
        ['Critique', `+${b.critPts} pts`, b.critDmgPct ? `et +${b.critDmgPct} % de dégâts critiques` : ''],
        ['Vitesse d’attaque', `+${b.speedPct} %`, ''],
        ['Vie', `+${b.hpPct} %`, b.hpPct ? '' : 'aucun point en Défense'],
        ['Riposte', `+${b.counterPts || 0} pts`, b.counterPct ? `et +${b.counterPct} % de force` : ''],
    ];
    return `
        <h2 class="block">Tes talents</h2>
        <div class="cards">
            <div class="card">
                <h3>Ce qu’ils apportent en combat</h3>
                <table class="mini">${rows.map(([k, v, note]) => `<tr><th>${esc(k)}</th>
                    <td class="num">${esc(v)}</td><td style="color:var(--text-3)">${esc(note)}</td></tr>`).join('')}</table>
                <p class="note">${sk.spent} point(s) dépensés${sk.toSpend ? `, <strong class="v-bad">${sk.toSpend} non dépensé(s)</strong>` : ''}
                    — ${Object.entries(sk.spentPerBranch || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}.</p>
            </div>
            <div class="card">
                <h3>Pourquoi ça compte ici</h3>
                <p>Une stat réelle vaut <code>(base du type à son niveau + bonus plats) × (1 + talents % + objets %)</code>.
                    Vérifié : les types que tu n’équipes pas ont des PV réels <em>exactement</em> égaux à leurs PV de base,
                    parce que ta branche Défense est à ${sk.spentPerBranch?.def ?? 0} point.</p>
                <p>Conséquence directe : <strong>tout l’écart de PV d’un type équipé vient de son matériel</strong>,
                    bonus intrinsèque compris — celui que le jeu n’écrit nulle part.</p>
                ${bt ? `<p class="note">Le simulateur applique ces bonus et un multiplicateur de critique de
                    <strong>×${bt.critMult}</strong>, retenu parce que c’est celui qui rejoue le mieux ton historique.</p>` : ''}
            </div>
            <div class="card">
                <h3>Talents achetés</h3>
                ${(sk.nodes || []).map((n) => `<p><strong>${esc(n.name)}</strong> ${n.points}/${n.max ?? '∞'}
                    <span style="color:var(--text-3)">— ${esc(n.effects.map((e) => e.raw).join(', '))}</span></p>`).join('') || '<p>Aucun.</p>'}
            </div>
        </div>`;
}

/* Mon équipement contre le leur, affixe par affixe. Ce sont des moyennes par pile engagée : la
   plupart des pièces ne portent pas d'affixe sur une stat donnée, donc une médiane vaudrait 0
   partout et masquerait justement l'écart. */
function gearCallout(gear) {
    if (!gear) return '';
    const rows = Object.keys(AFFIX_FR).filter((k) => (gear.bonuses?.[k] || gear.mineBonuses?.[k]));
    if (!rows.length) return '';
    const behind = rows.filter((k) => (gear.bonuses[k] || 0) > (gear.mineBonuses[k] || 0) + 0.2);
    return callout(`<strong>Équipement : toi contre eux.</strong> Par pile engagée, en moyenne —
        ${rows.map((k) => `${AFFIX_FR[k]} <strong>${fmtAffix(gear.mineBonuses[k], k)}</strong> contre
        <strong>${fmtAffix(gear.bonuses[k], k)}</strong>`).join(' · ')}.
        ${behind.length
        ? `Tu es derrière sur ${behind.map((k) => AFFIX_FR[k]).join(', ')}.`
        : 'Tu es au niveau ou devant sur toutes les stats.'}
        Ces chiffres ne comptent que les affixes que le jeu publie ; le bonus propre à chaque objet,
        lui, n’est écrit nulle part (voir <a href="#objets">Les objets</a>).`,
    behind.length ? 'bad' : 'good');
}

const fmtAffix = (v, k) => `${(v || 0) > 0 ? '+' : ''}${String(v || 0).replace('.', ',')}${AFFIX_UNIT[k] || ''}`;

function readiness(a) {
    const xs = a.fights.filter((f) => f.role === 'défense')
        .map((f) => f.myPiles.reduce((s, p) => s + p.hp, 0) / (f.myPiles.reduce((s, p) => s + p.max, 0) || 1))
        .sort((x, y) => x - y);
    return xs.length ? xs[xs.length >> 1] : 1;
}

/* Les talents adverses, invisibles dans les stats servies, mais mesurés dans les journaux :
   qui tape plus fort que sa carte, qui a le critique amélioré. C'est ce que le simulateur
   applique quand il reconstruit une armée d'en face. */
function learnedCard(learned) {
    if (!learned?.length) return '';
    return `
        <h2 class="block">Talents adverses, mesurés</h2>
        <p class="note">Les PV servis par le jeu contiennent l’équipement d’en face, mais <strong>pas ses
            talents de dégâts</strong>. Le journal de combat, lui, les trahit : le rapport entre les dégâts
            mesurés et ceux que sa carte explique est la signature de ses talents — stable d’un combat à
            l’autre. <strong>×1,00</strong> = conforme à sa carte ; au-dessus, il tape plus fort qu’annoncé.
            Le simulateur applique ces facteurs automatiquement.</p>
        ${dataTable(
        ['Adversaire', 'Facteur de dégâts', 'Critique', 'Détail par type'],
        learned.map((o) => [
            `<span class="who">${avatarChip(o.avatar, o.name, { size: 'sm' })}<span>${esc(o.name)}</span></span>`,
            `<span class="${(o.factorMedian || 1) > 1.1 ? 'v-bad' : (o.factorMedian || 1) < 0.9 ? 'v-good' : ''}">
                ×${String(o.factorMedian ?? '?').replace('.', ',')}</span>`,
            o.critMult != null
                ? (o.critMult >= 2 ? `<span class="chip chip-off">×2,0 — Executioner</span>` : '×1,5')
                : '—',
            o.types.map((t) => `${esc(t.base)} ×${String(t.factor ?? '?').replace('.', ',')}`).join(' · '),
        ]),
        [0, 1, 0, 0],
    )}`;
}

function backtestCard(bt) {
    const b = bt.balanced;
    const rows = ['attaque', 'défense'].map((role) => {
        const r = b[role];
        if (!r || r.balanced == null) return `<p><strong>${role}</strong> — trop peu de cas pour juger.</p>`;
        return `<p><strong>${role}</strong> — classement ${r.auc} (0,5 = hasard) ·
            victoires retrouvées ${r.recallWins} % · défaites retrouvées ${r.recallLosses} %
            <span style="color:var(--text-3)">(${r.wins} V / ${r.losses} D)</span></p>`;
    }).join('');
    return `
        <h2 class="block">Fiabilité du simulateur</h2>
        <div class="cards">
            <div class="card">
                <h3>Rejeu de l’historique</h3>
                <p>Le simulateur rejoue les ${bt.fights} combats à partir des seules informations
                    d’avant-combat et retrouve le bon vainqueur <strong>${bt.correct} fois</strong>
                    (${bt.accuracy} %). Prédire « défaite » à tous les coups donnerait ${bt.baseline} %,
                    donc la comparaison à retenir est le pouvoir de classement : <strong>${bt.separation}</strong>
                    (1 = parfait, 0,5 = hasard)${bt.brier != null ? ` — et la qualité des probabilités,
                    score de Brier <strong>${String(bt.brier).replace('.', ',')}</strong>
                    (0 = parfait, 0,25 = pile ou face)` : ''}.
                    Chaque mesure apprise sur un adversaire est exclue du combat qu’elle sert à rejouer
                    (leave-one-out) : le score n’est pas gonflé par l’auto-apprentissage.</p>
                ${rows}
                <p class="note">Le seuil de bascule est calé sur l’historique
                    (${Object.entries(bt.threshold).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ')}) :
                    le simulateur ignore ce qui ne se mesure pas, son zéro n’est donc pas le bon point d’équilibre.
                    À utiliser pour <em>classer</em> des compositions, pas pour promettre un résultat.</p>
            </div>
            <div class="card">
                <h3>Marges prédites</h3>
                <p class="note">Chaque trait est un combat. Si le modèle vaut quelque chose, les victoires réelles
                    se massent à droite et les défaites à gauche.</p>
                ${marginStrip(bt)}
            </div>
        </div>`;
}

/* Bande 1D facettée par issue réelle : la couleur n'est pas le seul encodage, la ligne l'est. */
function marginStrip(bt) {
    const xs = bt.rows.map((r) => r.margin);
    const lo = Math.min(...xs, -1);
    const hi = Math.max(...xs, 1);
    const x = (v) => ((v - lo) / (hi - lo || 1)) * 100;
    const row = (label, rows, color) => `
        <div class="strip-row">
            <span>${label}</span>
            <svg viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label="${label} : ${rows.length} combats">
                <line x1="0" y1="17" x2="100" y2="17" stroke="var(--line)" stroke-width=".5"/>
                ${['attaque', 'défense'].map((r) => {
        const t = bt.threshold[r];
        return t == null ? '' : `<line x1="${x(t).toFixed(2)}" y1="2" x2="${x(t).toFixed(2)}" y2="32" stroke="var(--text-3)" stroke-width=".4" stroke-dasharray="2 2"/>`;
    }).join('')}
                ${rows.map((r) => `<line x1="${x(r.margin).toFixed(2)}" y1="5" x2="${x(r.margin).toFixed(2)}" y2="29" stroke="${color}" stroke-width="1.4" opacity=".85"/>`).join('')}
            </svg>
        </div>`;
    return `<div class="strip">
        ${row('Gagnés', bt.rows.filter((r) => r.actual), 'var(--d-teal)')}
        ${row('Perdus', bt.rows.filter((r) => !r.actual), 'var(--d-rose)')}
        <p class="note">Traits pointillés : les seuils de bascule calés par rôle.</p>
    </div>`;
}

/* ── Adversaires ───────────────────────────────────────────────────────────── */

async function loadEnemies() {
    const res = await api('/api/enemies');
    if (res.empty) {
        $('#adversaires-body').innerHTML = callout(res.reason, 'bad');
        return;
    }
    state.enemies = res;
    renderEnemies();
}

function renderEnemies() {
    const res = state.enemies;
    const box = $('#adversaires-body');
    const changed = res.players.filter((p) => p.changes > 0);

    box.innerHTML = `
        <div class="tiles">
            ${tile('Adversaires croisés', res.counts.enemies, `${res.counts.observations} relevés d’armée`)}
            ${tile('Ont changé de troupes', changed.length, `${res.counts.changes} changements datés`)}
            ${tile('Relevé le', fmtDate(res.updatedAt), 'reconstruit depuis les combats en base')}
        </div>
        ${callout(`Tout vient des rapports de combat : un rapport donne l’armée <em>complète</em> des deux
            camps — type, quantité, PV unitaires, niveau de type, capacité et les trois pièces
            d’équipement de chaque pile. Rien n’est deviné, et aucune requête supplémentaire n’est faite
            au jeu. Clique sur une ligne pour voir l’armée actuelle et l’historique de ses changements.`)}

        <h2 class="block">Chercher un adversaire</h2>
        <div class="enemy-search"><div id="enemy-picker"></div></div>

        <h2 class="block">Les ${res.players.length} adversaires</h2>
        ${dataTable(
        ['Adversaire', 'Niv.', 'Classement', 'Combats', 'Mon bilan', 'Fortif.', 'Armée connue', 'Types engagés', 'Changements', 'Vu pour la dernière fois'],
        res.players.map((p) => [
            `<span class="who">${avatarChip(p.avatar, p.name, { size: 'sm' })}
                <strong>${esc(p.name)}</strong></span>`,
            p.level.last === p.level.first ? num(p.level.last) : `${num(p.level.first)} → ${num(p.level.last)}`,
            p.rating.last != null ? num(p.rating.last) : '—',
            num(p.record.fights),
            `<span class="${p.record.myWins >= p.record.myLosses ? 'v-good' : 'v-bad'}">${p.record.myWins}V / ${p.record.myLosses}D</span>`,
            p.fort.last != null ? `${p.fort.last} %` : '—',
            p.latest ? `${num(p.latest.army.qty)} unités · ${num(p.latest.army.maxHp)} PV` : '—',
            p.latest ? p.latest.piles.map((x) => `${esc(x.fr)}&nbsp;×${num(x.qty)}`).join(', ') : '—',
            p.changes ? `<span class="chip chip-off">${p.changes}</span>` : '—',
            `<span style="color:var(--text-3)">${esc(when(p.span.to))}</span>`,
        ]),
        [0, 1, 1, 1, 0, 1, 0, 0, 1, 0],
        'wrap-7',
        { rowLink: res.players.map((p) => `#adversaire/${p.id}`) },
    )}`;

    wireRowLinks(box);

    /* Même sélecteur que dans le simulateur : on parcourt ou on tape, et la fiche s'ouvre. */
    picker($('#enemy-picker', box), {
        items: res.players.map((p) => ({
            value: String(p.id),
            name: p.name,
            avatar: p.avatar,
            label: `<strong>${esc(p.name)}</strong> <span style="color:var(--text-3)">niv. ${num(p.level.last)}</span>`,
            sub: `${p.record.fights} combat(s) · ${p.record.myWins}V / ${p.record.myLosses}D`
                + `${p.changes ? ` · ${p.changes} changement(s) de troupes` : ''}`,
            search: `${p.name} ${(p.aka || []).join(' ')} `
                + (p.latest ? p.latest.piles.map((x) => x.fr).join(' ') : ''),
        })),
        placeholder: 'Nom d’adversaire, ou type de troupe qu’il aligne…',
        onPick: (id) => { location.hash = `adversaire/${id}`; },
        empty: 'Aucun adversaire de ce nom dans ton historique.',
    });
}

async function openEnemy(id) {
    const host = $('#adversaire-body');
    if (!/^\d+$/.test(String(id || ''))) {
        host.innerHTML = `${backLink('adversaires', 'Tous les adversaires')}
            ${callout('Adversaire inconnu.', 'bad')}`;
        wireBack(host);
        return;
    }
    host.innerHTML = '<p class="empty">Chargement…</p>';
    let res;
    try {
        res = await api(`/api/enemy?id=${encodeURIComponent(id)}`);
    } catch (e) {
        host.innerHTML = `${backLink('adversaires', 'Tous les adversaires')}${callout(e.message, 'bad')}`;
        wireBack(host);
        return;
    }
    state.enemy = res.player;
    renderEnemy(host, res.player);
    wireBack(host);
}

function renderEnemy(host, p) {
    const latest = p.latest;
    const changes = p.changes.slice().reverse(); // du plus récent au plus ancien

    host.innerHTML = `
        ${backLink('adversaires', 'Tous les adversaires')}
        <h2 class="block enemy-title">${avatarChip(p.avatar, p.name, { size: 'lg' })}
            <span>${esc(p.name)}${p.aka.length > 1 ? ` <small>alias ${p.aka.map(esc).join(', ')}</small>` : ''}</span></h2>
        <div class="tiles">
            ${tile('Niveau', p.level.last, p.level.history.length > 1
        ? `${p.level.first} → ${p.level.last} sur la période`
        : 'inchangé depuis qu’on le croise')}
            ${tile('Classement', p.rating.last ?? '—', p.rating.min != null ? `entre ${p.rating.min} et ${p.rating.max}` : '')}
            ${tile('Mon bilan contre lui', `${p.record.myWins}<small>/${p.record.fights}</small>`,
        `${p.record.asAttacker} fois attaquant · ${p.record.asDefender} fois défenseur`,
        { tone: p.record.myWins * 2 >= p.record.fights ? 'good' : 'bad' })}
            ${tile('Fortifications', p.fort.last != null ? `${p.fort.last}<small>%</small>` : '—',
        p.fort.max ? `maximum vu : ${p.fort.max} %` : 'jamais vu en défense')}
        </div>

        ${latest ? `
            <h3 class="block">Son armée au dernier combat <small>(${esc(when(latest.at))}, combat ${latest.fightId})</small></h3>
            <p class="note">${num(latest.army.qty)} unités, ${num(latest.army.maxHp)} PV au total, ${latest.army.types} types.
                ${latest.reinforcements.length ? `${latest.reinforcements.length} renfort(s) de famille en plus — ils ne font pas partie de sa compo.` : ''}
                ${latest.abOn.length ? `Capacités qui ont fonctionné : ${latest.abOn.map((k) => `<code>${esc(k)}</code>`).join(', ')}.` : 'Aucune capacité n’a fonctionné.'}</p>
            ${dataTable(
        ['Type', 'Rôle', 'Capacité', 'Quantité', 'PV / unité', 'Niv. type', 'Cadence mesurée', 'Arme', 'Protection', 'Porte-bonheur', 'Bonus d’objets'],
        latest.piles.map((x) => [
            unitChip(x.base, x.fr),
            `<span class="chip chip-role">${esc(x.roleFr || '?')}</span>`,
            esc(x.abilityFr || '—'),
            num(x.qty),
            num(x.unitHp),
            num(x.typeLevel),
            x.measured?.intervalS ? `${String(x.measured.intervalS).replace('.', ',')} s` : '—',
            ...['weapon', 'armor', 'charm'].map((slot) => gearCell(x.gear.find((g) => g.slot === slot))),
            bonusCell(x.gearBonuses),
        ]),
        [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],
    )}
            <p class="note">La <strong>cadence mesurée</strong> vient de la frise des coups du combat, pas
                d’une fiche : c’est le délai réel entre deux frappes de cette pile. Les <strong>bonus
                d’objets</strong> ne comptent que les affixes que le jeu chiffre ; chaque pièce apporte en
                plus un bonus intrinsèque que le jeu ne publie pas (voir <a href="#objets">Les objets</a>).</p>
        ` : ''}

        <h3 class="block">Historique de ses troupes</h3>
        ${changes.length ? `<ol class="timeline">
            ${changes.map((c) => `<li>
                <div class="tl-when">${esc(when(c.at))}<small>combat ${c.fightId}</small></div>
                <div class="tl-body">
                    <p class="tl-kinds">${c.kinds.map((k) => `<span class="chip chip-off">${esc(k)}</span>`).join('')}</p>
                    <ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
                </div>
            </li>`).join('')}
        </ol>` : `<p class="note">Aucun changement relevé : son armée est restée identique sur les
            ${p.record.fights} combat(s) où on l’a croisé.</p>`}

        ${p.level.history.length > 1 || p.rating.history.length > 1 ? `
            <h3 class="block">Sa progression</h3>
            ${dataTable(['Quand', 'Niveau', 'Classement'],
        mergeHistory(p.level.history, p.rating.history).map((r) => [
            `<span style="color:var(--text-3)">${esc(when(r.at))}</span>`,
            r.level != null ? num(r.level) : '—',
            r.rating != null ? num(r.rating) : '—',
        ]), [0, 1, 1])}` : ''}`;
}

/* Niveau de type : le dernier connu, et l'amplitude si le type a progressé pendant l'historique.
   Chaque palier vaut +2 % de vie et de dégâts pour toutes les unités du type — additif, pas composé. */
function levelCell(lv) {
    if (!lv) return '—';
    if (lv.min === lv.max) return `<span class="lv">${lv.last}</span>`;
    return `<span class="lv">${lv.last}</span><small style="color:var(--text-3)"> (${lv.min}→${lv.max}, ${lv.spreadPct} %)</small>`;
}

function gearCell(g) {
    if (!g) return '—';
    const bonus = Object.entries(g.affixes || {})
        .map(([k, v]) => `${v > 0 ? '+' : ''}${String(v).replace('.', ',')}${AFFIX_UNIT[k] || ''} ${AFFIX_FR[k] || k}`);
    return `<span class="item r-${g.rarity ?? 0}" title="${esc(g.rarityFr || '')}">
        ${itemIcon(g.item, g.rarity)}
        <span class="item-txt"><b>${esc(g.name)}</b>${bonus.length ? `<small>${esc(bonus.join(' · '))}</small>` : ''}</span></span>`;
}

function bonusCell(b) {
    const parts = Object.entries(b || {}).filter(([, v]) => v)
        .map(([k, v]) => `${v > 0 ? '+' : ''}${String(v).replace('.', ',')}${AFFIX_UNIT[k] || ''} ${AFFIX_FR[k] || k}`);
    return parts.length ? esc(parts.join(' · ')) : '<span style="color:var(--text-3)">aucun</span>';
}

const AFFIX_FR = { dmg: 'dégâts', hp: 'vie', speed: 'vitesse', crit: 'crit.', riposte: 'riposte' };
const AFFIX_UNIT = { dmg: ' %', hp: ' %', speed: ' %', crit: ' pts', riposte: ' pts' };

/** Deux séries datées fondues en un seul tableau chronologique. */
function mergeHistory(levels, ratings) {
    const by = new Map();
    for (const x of levels) by.set(x.at, { at: x.at, level: x.value, rating: null });
    for (const x of ratings) {
        const row = by.get(x.at) || { at: x.at, level: null, rating: null };
        row.rating = x.value;
        by.set(x.at, row);
    }
    return [...by.values()].sort((a, b) => b.at - a.at);
}

/* ── Images du jeu ─────────────────────────────────────────────────────────── */

/* Les images sont copiées en local par `npm run assets` et servies sous /assets/. On ne pointe
   jamais vers le site du jeu depuis la page : l'interface doit rester lisible hors ligne, et une
   image manquante ne doit pas laisser d'icône cassée — d'où le repli sur `onerror`. */

const unitFace = (key) => `/assets/units/face/${encodeURIComponent(key)}.webp`;
const unitPortrait = (key) => `/assets/units/${encodeURIComponent(key)}.webp`;
/** Les avatars portent un condensat dans leur nom : on ne garde que le fichier. */
const avatarFile = (url) => (url ? String(url).split('?')[0].split('/').filter(Boolean).pop() : null);

/** Vignette d'un type, suivie de son nom. L'unité de base de presque tous les tableaux. */
function unitChip(key, label, { size = '' } = {}) {
    return `<span class="u ${size}">
        <img class="u-face" src="${unitFace(key)}" alt="" width="32" height="32" loading="lazy"
            onerror="this.closest('.u').classList.add('no-img')">
        <b>${esc(label ?? key)}</b></span>`;
}

/* Photo de profil. Quand elle manque — joueur jamais croisé en combat, images pas encore
   téléchargées — on retombe sur l'initiale, qui reste identifiable dans une liste. */
function avatarChip(url, name, { size = '' } = {}) {
    const file = avatarFile(url);
    const initial = esc((name || '?').trim().charAt(0).toUpperCase());
    return `<span class="ava ${size}" data-initial="${initial}">
        ${file ? `<img src="/assets/avatars/${encodeURIComponent(file)}" alt="" width="40" height="40" loading="lazy"
            onerror="this.remove()">` : ''}</span>`;
}

/** Icône d'un objet, teintée par sa rareté. Le sprite est monochrome (`fill: currentColor`). */
function itemIcon(item, rarity) {
    if (!item) return '';
    return `<svg class="item-ico r-${rarity ?? 0}" aria-hidden="true" focusable="false">
        <use href="/assets/icons.svg#item-${esc(item)}"/></svg>`;
}


/* ── Recherche ─────────────────────────────────────────────────────────────── */

/* Partout où il y a une liste de joueurs, on doit pouvoir soit parcourir, soit taper un nom.
   Un `<select>` ne sait faire que parcourir, et il devient inutilisable dès qu'il y a 60 entrées.
   D'où ce sélecteur : un champ qui filtre, une liste qui se réduit, le clavier qui marche. */

/** Normalise pour comparer : sans accents, sans casse. « Chengríha » doit sortir sur « chengri ». */
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Vrai si tous les mots de la requête se retrouvent dans le texte. */
function matches(haystack, query) {
    const h = fold(haystack);
    return fold(query).split(/\s+/).filter(Boolean).every((w) => h.includes(w));
}

/**
 * Sélecteur filtrable.
 * @param items  [{ value, label, sub, avatar, name, search }]
 * @param onPick appelée avec la valeur choisie
 */
function picker(host, { items, value, placeholder, onPick, empty = 'Aucun résultat.' }) {
    host.innerHTML = `
        <div class="picker">
            <input type="search" class="picker-input" placeholder="${esc(placeholder)}"
                autocomplete="off" aria-label="${esc(placeholder)}">
            <ol class="picker-list" role="listbox"></ol>
        </div>`;
    const input = $('.picker-input', host);
    const list = $('.picker-list', host);
    let cursor = 0;

    const visible = () => items.filter((it) => !input.value.trim() || matches(it.search || it.label, input.value));

    const draw = () => {
        const xs = visible();
        cursor = Math.max(0, Math.min(cursor, xs.length - 1));
        list.innerHTML = xs.length
            ? xs.map((it, i) => `<li role="option" data-value="${esc(it.value)}"
                class="${it.value === String(value) ? 'is-current' : ''}${i === cursor ? ' is-cursor' : ''}"
                aria-selected="${it.value === String(value)}">
                ${it.avatar !== undefined ? avatarChip(it.avatar, it.name || it.label, { size: 'sm' }) : ''}
                <span class="picker-main">${it.label}</span>
                ${it.sub ? `<span class="picker-sub">${it.sub}</span>` : ''}
            </li>`).join('')
            : `<li class="picker-none">${esc(empty)}</li>`;
        const cur = $('.is-cursor', list);
        if (cur) cur.scrollIntoView({ block: 'nearest' });
    };

    const pick = (v) => { if (v != null) onPick(v); };

    input.addEventListener('input', () => { cursor = 0; draw(); });
    input.addEventListener('keydown', (e) => {
        const xs = visible();
        if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, xs.length - 1); draw(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); e.preventDefault(); }
        else if (e.key === 'Enter') { pick(xs[cursor]?.value); e.preventDefault(); }
        else if (e.key === 'Escape') { input.value = ''; cursor = 0; draw(); }
    });
    list.addEventListener('click', (e) => {
        const li = e.target.closest('[data-value]');
        if (li) pick(li.dataset.value);
    });

    draw();
    return { focus: () => input.focus(), input };
}

/* ── Le quartier général ───────────────────────────────────────────────────── */

async function loadHq() {
    const box = $('#qg-body');
    const res = await api('/api/hq');
    if (res.empty) { box.innerHTML = callout(res.reason, 'bad'); return; }
    state.hq = res;
    renderHq();
}

function renderHq() {
    const h = state.hq;
    const box = $('#qg-body');
    const lv = h.level;
    const works = h.buildings.filter((b) => b.works);
    const full = h.resources.filter((r) => r.full);

    box.innerHTML = `
        <div class="tiles">
            ${tile('Niveau', lv.level, `${num(lv.xp)} / ${num(lv.xpTo)} XP · il reste ${num(lv.xpLeft)}`,
        { hero: true, meter: lv.pct })}
            ${tile('Points de compétence', h.skillPoints, h.skillPoints ? 'à dépenser' : 'tous dépensés',
        { tone: h.skillPoints ? 'bad' : 'good' })}
            ${tile('Classement', num(h.rating), `rang ${h.rank.city ?? '?'} dans la ville`)}
            ${tile('Bâtiments', h.summary.total, `${h.summary.levels} niveaux cumulés · ${h.summary.atMax} au maximum`)}
            ${tile('Attaques', h.attacks ? `${h.attacks.used}<small>/ ${h.attacks.max}</small>` : '—', 'utilisées sur la période')}
        </div>

        ${h.skillPoints ? callout(`<strong>${h.skillPoints} point(s) de compétence non dépensé(s).</strong>
            Chaque niveau en donne un ; les laisser dormir, c’est de la puissance qui ne sert pas.`, 'bad') : ''}

        <h2 class="block">Ressources</h2>
        <div class="res-grid">
            ${h.resources.filter((r) => r.value != null).map(resCard).join('')}
        </div>
        ${full.length ? callout(`<strong>${full.map((r) => r.fr).join(', ')} au plafond.</strong>
            Toute production supplémentaire est perdue : dépense, ou monte la capacité de stockage.`, 'bad')
        : `<p class="note">Un tour dure ${h.turn?.every ? h.turn.every / 60 : '?'} minutes ; la production ci-dessus est par tour.</p>`}

        ${works.length ? `
            <h2 class="block">Chantiers en cours</h2>
            <div class="cards">
                ${works.map((b) => `<div class="card work-card">
                    <img class="bld-img" src="/assets/buildings/${esc(b.sprite)}.webp" alt="" loading="lazy"
                        onerror="this.src='/assets/buildings/${esc(b.type)}.webp'; this.onerror=() => this.remove()">
                    <div>
                        <h3>${esc(b.name)}</h3>
                        <p>Niveau ${b.level}${b.works.becomes ? ` → <strong>${esc(b.works.becomes)}</strong>` : ''}</p>
                        <p class="note">Fin dans ${esc(hoursLeft(b.works.secondsLeft))}</p>
                    </div>
                </div>`).join('')}
            </div>` : ''}

        <h2 class="block">La ville</h2>
        <p class="note">Rayon ${h.city.radius} / ${h.city.maxRadius} · ${num(h.city.areaM2)} m² ·
            ${h.city.buildingSlots} emplacements de construction ·
            milice niveau ${h.city.militia.level ?? '?'} (${num(h.city.militia.troops)} troupes).
            Structures : ${num(h.summary.hp)} PV au total.</p>
        <div class="bld-grid">
            ${h.summary.byType.map((t) => buildingCard(t, h)).join('')}
        </div>

        <h2 class="block">Exporter pour un agent IA</h2>
        ${callout(`Un compte rendu Markdown complet — QG, ressources, bâtiments, troupes, talents, objets,
            bilan de combat et compositions — prêt à coller dans une conversation avec un agent IA pour lui
            demander quoi améliorer. Les faits mesurés y sont séparés de ce qui est modélisé, et les limites
            connues sont écrites noir sur blanc.`)}
        <div class="controls" style="margin-top:.8rem">
            <a class="btn" href="/api/report.md" download="sss-rapport.md">Télécharger le Markdown</a>
            <button class="btn btn-ghost" type="button" data-copy-report>Copier dans le presse-papier</button>
            <a class="btn btn-ghost" href="/api/report.md" target="_blank" rel="noreferrer">Ouvrir dans un onglet</a>
        </div>
        <p class="note" id="copy-note"></p>

        ${h.history.length > 1 ? `
            <h2 class="block">Progression</h2>
            ${dataTable(['Quand', 'Niveau', 'Classement', 'Points libres', 'Bâtiments', 'Niveaux cumulés'],
        h.history.slice().reverse().slice(0, 20).map((p) => [
            `<span style="color:var(--text-3)">${esc(fmtDate(p.at))}</span>`,
            num(p.level), num(p.rating), num(p.skillPoints), num(p.buildings), num(p.buildingLevels),
        ]), [0, 1, 1, 1, 1, 1])}` : ''}`;

    wireCopyReport();
}

function resCard(r) {
    return `<div class="res-card${r.full ? ' is-full' : ''}">
        <img class="res-img" src="/assets/res/${esc(r.icon)}.webp" alt="" width="28" height="28" loading="lazy"
            onerror="this.remove()">
        <div class="res-main">
            <span class="res-name">${esc(r.fr)}</span>
            <strong class="res-value">${num(r.value)}</strong>
            ${r.cap != null ? `<span class="res-cap">/ ${num(r.cap)}</span>` : ''}
        </div>
        ${r.cap != null ? `<span class="meter${r.full ? ' is-bad' : ''}"><i style="width:${Math.min(100, r.pct)}%"></i></span>` : ''}
        <span class="res-prod">${r.perTurn != null ? `+${num(r.perTurn)} / tour` : '—'}</span>
    </div>`;
}

function buildingCard(t, h) {
    const sample = h.buildings.find((b) => b.type === t.type && b.level === t.max) || h.buildings.find((b) => b.type === t.type);
    return `<div class="bld-card">
        <img class="bld-img" src="/assets/buildings/${esc(sample?.sprite || t.type)}.webp" alt="" loading="lazy"
            onerror="this.src='/assets/buildings/${esc(t.type)}.webp'; this.onerror=() => this.remove()">
        <div class="bld-body">
            <strong>${esc(t.name)}</strong>
            <span class="bld-lv">niv. ${t.max}${t.count > 1 ? ` · ×${t.count}` : ''}${t.atMax ? ' · au max' : ''}</span>
            <small>${esc((t.role || '').replace(/^[^—]*— /, ''))}</small>
        </div>
    </div>`;
}

function hoursLeft(seconds) {
    if (!Number.isFinite(seconds)) return '?';
    const hrs = Math.floor(seconds / 3600);
    const min = Math.round((seconds % 3600) / 60);
    return hrs ? `${hrs} h ${String(min).padStart(2, '0')}` : `${min} min`;
}

/* Le presse-papier est le chemin le plus court vers une conversation avec un agent : pas de
   fichier à retrouver, on colle directement. */
function wireCopyReport() {
    const btn = $('[data-copy-report]');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const note = $('#copy-note');
        btn.disabled = true;
        btn.textContent = 'Génération…';
        try {
            const md = await (await fetch('/api/report.md')).text();
            await navigator.clipboard.writeText(md);
            note.innerHTML = `<span class="v-good">Copié — ${num(md.length)} caractères, ${num(md.split('\n').length)} lignes.</span>`;
        } catch (e) {
            note.innerHTML = `<span class="v-bad">Copie impossible (${esc(e.message)}). Utilise le téléchargement.</span>`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Copier dans le presse-papier';
        }
    });
}

/* ── Le journal d'un combat ────────────────────────────────────────────────── */

/* Le déroulé réel, tel que le jeu l'a rédigé. Il porte deux choses que le rapport JSON ne donne
   pas : quels coups ont été critiques, et combien d'unités chaque coup a mises KO. */

async function openFight(id) {
    const host = $('#combat-body');
    if (!/^\d+$/.test(String(id || ''))) {
        host.innerHTML = `${backLink('analyse', 'Tous les combats')}${callout('Combat inconnu.', 'bad')}`;
        wireBack(host);
        return;
    }
    host.innerHTML = '<p class="empty">Chargement du journal…</p>';
    let res;
    try {
        res = await api(`/api/fight?id=${encodeURIComponent(id)}`);
    } catch (e) {
        host.innerHTML = `${backLink('analyse', 'Tous les combats')}${callout(e.message, 'bad')}`;
        wireBack(host);
        return;
    }
    renderFight(host, res);
    wireBack(host);
    wireBestCompo(host);
    wireCopyMd(host);
}

/* ── Export Markdown pour un agent IA ──────────────────────────────────────── */

/* Copier, c'est le geste courant : on colle dans une conversation et on demande conseil.
   Le téléchargement est à côté pour archiver ou joindre. */
function wireCopyMd(host) {
    for (const btn of $$('[data-copy-md]', host)) {
        btn.addEventListener('click', async () => {
            const note = btn.closest('.export-row')?.querySelector('[data-copy-note]');
            btn.disabled = true;
            try {
                const md = await (await fetch(btn.dataset.copyMd)).text();
                await navigator.clipboard.writeText(md);
                if (note) note.innerHTML = `<span class="v-good">Copié — ${num(md.length)} caractères.</span>`;
            } catch (e) {
                if (note) note.innerHTML = `<span class="v-bad">Copie impossible (${esc(e.message)}).</span>`;
            } finally {
                btn.disabled = false;
            }
        });
    }
}

/** Télécharge un texte comme fichier .md, sans rien demander au serveur. */
function downloadMd(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ── La meilleure composition contre CE combat ─────────────────────────────── */

function wireBestCompo(host) {
    const btn = $('[data-bestco]', host);
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const out = $('#bestco-result', host);
        btn.disabled = true;
        btn.textContent = 'Recherche en cours…';
        try {
            const r = await api('/api/best-compo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fightId: Number(btn.dataset.bestco) }),
            });
            out.innerHTML = renderBestCompo(r);
            wireTryButtons(out);
        } catch (e) {
            out.innerHTML = callout(e.message, 'bad');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Trouver la meilleure composition';
        }
    });
}

function renderBestCompo(r) {
    const fmt = (x) => String(x ?? '?').replace('.', ',');
    const top = r.best[0] || null;
    const winnable = top && top.pWin >= 50;
    const closeCall = top && top.pWin >= 25 && top.pWin < 50;

    const compoCard = (b, label, { highlight = false } = {}) => `
        <article class="compo${highlight ? ' is-best' : ''}">
            <div class="compo-rank">${esc(label)}</div>
            <div class="compo-mix">
                ${b.types.map((t) => `
                    <span class="unit ${t.abilityOn === false ? 'is-off' : ''}">
                        <img class="u-face" src="${unitFace(t.key)}" alt="" width="32" height="32" loading="lazy"
                            onerror="this.remove()">
                        <b>${esc(t.fr)}</b><span class="qty">×${num(t.qty)}</span>
                        ${t.abilityFr != null ? `<span class="ab">${t.abilityOn ? esc(t.abilityFr || '') : 'capacité éteinte'}</span>` : ''}
                    </span>`).join('')}
            </div>
            <div class="compo-score">
                ${b.pWin != null ? `<b class="${b.pWin >= 50 ? 'v-good' : 'v-bad'}">${fmt(b.pWin)} %</b>
                <span>de victoires sur ce combat</span>` : ''}
                ${b.margin != null ? `<span>marge ${b.margin > 0 ? '+' : ''}${fmt(b.margin)}</span>` : ''}
            </div>
            <div class="compo-meta">
                <button type="button" class="link"
                    data-try='${esc(JSON.stringify(b.types.map((t) => ({ key: t.key, qty: t.qty }))))}'
                    data-try-fight="${r.fightId}" data-try-run="1">Simuler ce duel maintenant →</button>
                ${b.slotsUsed ? `<span>${num(b.slotsUsed)} places</span>` : ''}
                ${b.abilitiesOn?.length ? `<span>${b.abilitiesOn.length} capacité(s) : ${esc(b.abilitiesOn.join(', '))}</span>` : ''}
            </div>
        </article>`;

    const verdictText = winnable
        ? `<strong>Ce combat était gagnable.</strong> La meilleure composition trouvée le gagne
           <strong>${fmt(top.pWin)} %</strong> du temps (${num(r.runs)} tirages réels par finaliste).`
        : closeCall
            ? `<strong>Jouable, mais serré.</strong> Même la meilleure composition ne dépasse pas
               <strong>${fmt(top.pWin)} %</strong> de victoires : l’issue resterait au tirage.`
            : `<strong>Aucune composition ne gagne ce combat</strong> tel qu’il s’est présenté — la
               meilleure trouvée plafonne à <strong>${fmt(top?.pWin)} %</strong>${r.role === 'défense' && r.readiness < 0.99
                ? `, avec tes troupes à ${Math.round(r.readiness * 100)} % de leurs PV. Le problème
                   n’était pas la composition.` : '.'}`;

    return `
        ${callout(`${verdictText}
            <span style="color:var(--text-3)">Recherche : ${num(r.screened)} compositions sur
            ${num(r.slots)} places et ${r.maxTypes} types, ${esc(r.role)}${r.fort ? ` · fort ${r.fort} %` : ''}${r.foeFort ? ` · ses murs ${r.foeFort} %` : ''}${r.role === 'défense' ? ` · forme ${Math.round(r.readiness * 100)} %` : ''}.
            Ce jour-là : ${r.actual.won ? 'victoire' : 'défaite'}.</span>`,
        winnable ? 'good' : closeCall ? null : 'bad')}

        ${r.best.map((b, i) => compoCard(b, `0${i + 1}`.slice(-2), { highlight: i === 0 })).join('')}

        ${r.historic ? compoCard({ ...r.historic, abilitiesOn: null }, 'ce jour-là') : ''}
        ${r.current ? compoCard(r.current, 'actuelle') : ''}

        ${r.healed && (!top || r.healed.pWin > top.pWin) ? callout(`<strong>Avec des troupes soignées</strong>
            (100 % au lieu de ${Math.round(r.readiness * 100)} %), la meilleure composition gagnerait
            <strong>${fmt(r.healed.pWin)} %</strong> du temps :
            ${r.healed.types.map((t) => `${esc(t.fr)} ×${num(t.qty)}`).join(' + ')}.
            Le levier était la récupération, pas la composition.`, 'good') : ''}`;
}

function renderFight(host, res) {
    const f = res.fight;
    const log = res.log;
    const me = f?.role === 'attaque' ? 'att' : 'def';

    host.innerHTML = `
        ${backLink('analyse', 'Tous les combats')}
        <header class="view-head">
            <p class="kicker">Journal de combat</p>
            <h1>${f ? esc(f.opponent.name) : `Combat ${res.id}`}</h1>
            ${f ? `<p class="lede">${esc(f.role)} · ${esc(when(f.at))} · combat ${res.id}
                ${f.opponent.id ? `· <a href="#adversaire/${f.opponent.id}">voir sa fiche</a>` : ''}</p>` : ''}
        </header>
        ${f ? `
            <div class="verdict ${f.won ? 'is-win' : 'is-loss'}">
                <div class="verdict-main">
                    <span class="verdict-label">${f.won ? 'Victoire' : 'Défaite'}</span>
                    <span class="verdict-sub">${esc(f.role)} contre ${esc(f.opponent.name)} · ${esc(when(f.at))}</span>
                </div>
                <dl class="verdict-stats">
                    <div><dt>Durée</dt><dd>${String(f.seconds).replace('.', ',')} s</dd></div>
                    <div><dt>Points</dt><dd class="${f.delta >= 0 ? 'v-good' : 'v-bad'}">${f.delta >= 0 ? '+' : ''}${f.delta}</dd></div>
                    ${log ? `<div><dt>Coups</dt><dd>${num(log.counts.hits)}</dd></div>
                    <div><dt>Critiques</dt><dd>${num(log.counts.crits)}</dd></div>
                    <div><dt>Unités KO</dt><dd>${num(log.counts.ko)}</dd></div>` : ''}
                </dl>
            </div>

            <h3 class="block">Les deux armées</h3>
            ${dataTable(['Camp', 'Type', 'Quantité', 'Capacité', 'Dégâts infligés', 'Dégâts subis', 'PV au départ', 'PV à la fin'],
        [...f.myPiles.map((p) => ({ ...p, mine: true })), ...f.theirPiles.map((p) => ({ ...p, mine: false }))]
            .map((p) => [
                p.mine ? '<span class="chip chip-on">moi</span>'
                    : `<span class="chip chip-off">${esc(f.opponent.name)}</span>`,
                unitChip(p.base, p.base) + (p.reinforcement ? ' <small style="color:var(--text-3)">renfort</small>' : ''),
                num(p.qty),
                p.ability
                    ? ((p.mine ? f.abOn : f.abOnTheirs).includes(p.ability)
                        ? `<span class="chip chip-on">${esc(ABILITY_FR_UI[p.ability] || p.ability)}</span>`
                        : `<span class="chip chip-off">${esc(ABILITY_FR_UI[p.ability] || p.ability)} éteinte</span>`)
                    : '—',
                num(p.dealt), num(p.taken),
                `<span class="${p.hp / (p.max || 1) >= 0.99 ? '' : 'v-bad'}">${pct(p.hp / (p.max || 1))}</span>`,
                hpLeftCell(p),
            ]), [0, 0, 1, 0, 1, 1, 1, 1])}
        ` : ''}

        <p class="note">« PV au départ » n’est pas toujours 100 % : en défense, une pile qui n’a pas fini
            de récupérer encaisse l’attaque amoindrie. « PV à la fin » est ce qu’il en restait.</p>

        ${f ? `
            <div class="export-row">
                <button type="button" class="btn" data-copy-md="/api/fight.md?id=${res.id}">Copier pour un agent IA</button>
                <a class="btn" href="/api/fight.md?id=${res.id}" download="sss-combat-${res.id}.md">Télécharger .md</a>
                <span class="note" style="margin:0">Tout le combat en Markdown — armées, équipement, journal
                    coup par coup, avis du simulateur — prêt à coller dans une conversation avec un agent IA
                    pour lui demander pourquoi, et quoi changer.</span>
                <span data-copy-note></span>
            </div>

            <h3 class="block">Gagner ce combat</h3>
            <div id="bestco">
                <p class="note">Cherche la composition qui a le plus de chances de gagner <strong>ce
                    combat précis</strong> — même adversaire, mêmes fortifications${f.role === 'défense'
        ? ', et tes troupes dans l’état où elles étaient ce jour-là' : ''}. Toutes les combinaisons
                    de types sont passées en revue, puis les finalistes sont départagés au Monte-Carlo
                    (vrais tirages).</p>
                <button class="btn" data-bestco="${res.id}">Trouver la meilleure composition</button>
                <div id="bestco-result"></div>
            </div>` : ''}

        ${log ? `
            <h3 class="block">Le journal, coup par coup</h3>
            <p class="note">Rédigé par le jeu lui-même (<code>view/fightlog</code>), pas reconstruit : c’est la
                seule source qui dise quels coups ont été <strong>critiques</strong> et combien d’unités chaque
                coup a mises <strong>KO</strong>. ${num(log.counts.lines)} lignes,
                ${num(log.counts.crits)} critiques sur ${num(log.counts.hits)} coups
                (${Math.round((100 * log.counts.crits) / (log.counts.hits || 1))} %),
                ${num(log.counts.ripostes)} ripostes.</p>
            <ol class="fightlog">${log.lines.map((l) => logLine(l, me, f)).join('')}</ol>
        ` : callout(`Le journal de ce combat n’a pas encore été récupéré. Il arrive au prochain
            <strong>Mettre à jour</strong> — ils sont rattrapés par lots, du plus récent au plus ancien.`)}`;
}

/* Ce qu'il restait à la pile à la fin du combat. `end` est servi par le serveur ; sans lui on
   n'affiche rien plutôt qu'un chiffre faux. */
function hpLeftCell(p) {
    if (p.end == null) return '—';
    const left = p.end / (p.max || 1);
    return `<span class="${left > 0.3 ? 'v-good' : 'v-bad'}">${pct(left)}</span>`;
}

function logLine(l, me, f) {
    const mine = l.side === me;
    const who = mine ? 'moi' : (f ? f.opponent.name : 'adversaire');
    const t = `<span class="lg-t">${(l.t / 100).toFixed(2).replace('.', ',')} s</span>`;

    if (l.kind === 'end') {
        return `<li class="lg-end">${t}<span class="lg-body">${esc(l.text)}</span></li>`;
    }
    if (l.kind === 'ability') {
        return `<li class="lg-ab ${mine ? 'is-mine' : 'is-theirs'}">${t}
            <span class="lg-body"><strong>${esc(l.text)}</strong></span></li>`;
    }
    if (l.kind !== 'hit') {
        return `<li class="${mine ? 'is-mine' : 'is-theirs'}">${t}<span class="lg-body">${esc(l.text || '')}</span></li>`;
    }
    return `<li class="${mine ? 'is-mine' : 'is-theirs'}${l.crit ? ' is-crit' : ''}${l.riposte ? ' is-rip' : ''}">
        ${t}
        <span class="lg-body">
            <span class="lg-who">${esc(who)}</span>
            ${unitChip(l.from, l.from, { size: 'sm' })}
            ${l.fromQty ? `<small class="lg-n">×${num(l.fromQty)}</small>` : ''}
            <span class="lg-verb">${l.riposte ? 'riposte sur' : 'frappe'}</span>
            ${unitChip(l.to, l.to, { size: 'sm' })}
            ${l.toQty ? `<small class="lg-n">×${num(l.toQty)}</small>` : ''}
        </span>
        <span class="lg-dmg">${l.dmg ? num(l.dmg)
        : '<span class="lg-absorbed" title="coup entièrement encaissé par un bouclier">absorbé</span>'}</span>
        ${l.crit ? '<span class="lg-crit">critique</span>' : ''}
        ${l.ko ? `<span class="lg-ko">${num(l.ko)} KO</span>` : ''}
        ${l.heal ? `<span class="lg-heal">+${num(l.heal)}</span>` : ''}
    </li>`;
}

/* ── Simulateur ────────────────────────────────────────────────────────────── */

/* Deux usages dans un seul écran : rejouer un combat archivé en changeant de composition, ou
   éprouver une composition montée de toutes pièces. Dans les deux cas l'adversaire est réel —
   son armée, son équipement et ses murs viennent du rapport de combat, pas d'une cible théorique. */

const simu = { types: null, scenarios: null, fightId: null, piles: new Map(), source: 'current', result: null, running: false };

async function loadSimu() {
    const box = $('#simu-body');
    try {
        const [types, scenarios] = await Promise.all([api('/api/types'), api('/api/scenarios')]);
        if (types.empty || scenarios.empty) {
            box.innerHTML = callout(types.reason || scenarios.reason, 'bad');
            return;
        }
        simu.types = types;
        simu.scenarios = scenarios.scenarios;
        simu.fightId = simu.scenarios[0]?.fightId ?? null;
        useSource('current');
    } catch (e) {
        box.innerHTML = callout(e.message, 'bad');
        return;
    }
    renderSimu();
}

/** Remplit la composition depuis une origine : l'actuelle, celle du combat visé, ou rien. */
function useSource(source) {
    simu.source = source;
    simu.piles = new Map();
    if (source === 'current') {
        for (const p of simu.types.current) simu.piles.set(p.key, p.qty);
    } else if (source === 'fight') {
        const sc = currentScenario();
        for (const p of sc?.mine || []) simu.piles.set(p.key, p.qty);
    }
}

const currentScenario = () => simu.scenarios.find((s) => s.fightId === simu.fightId) || null;
const simuUsed = () => [...simu.piles.values()].reduce((a, n) => a + n, 0);
const simuTypes = () => [...simu.piles.values()].filter((n) => n > 0).length;

/* Place maximale qu'un type peut prendre, le reste de la composition étant figé. Les places de
   troupes sont un budget **commun** : 875 places, ce n'est pas 875 par type. Chaque curseur est
   donc borné par ce qui reste une fois les autres types servis — quand la composition est pleine,
   un type ne peut plus que baisser, et c'est exactement la contrainte du jeu. */
const roomFor = (key) => Math.max(0, simu.types.slots - (simuUsed() - (simu.piles.get(key) || 0)));

function renderSimu({ keepResult = true } = {}) {
    const box = $('#simu-body');
    const t = simu.types;
    const sc = currentScenario();
    const used = simuUsed();
    const over = used > t.slots;

    box.innerHTML = `
        <div class="simu">
            <section class="simu-setup">
                <h2 class="block">1 · Contre qui</h2>
                <div class="field">
                    <label>Combat archivé — parcours la liste ou tape un nom</label>
                    <div id="simu-foe"></div>
                </div>
                ${sc ? foeCard(sc) : ''}

                <h2 class="block">2 · Avec quoi</h2>
                <div class="seg-row">
                    ${[['current', 'Ma compo actuelle'], ['fight', 'Celle de ce combat'], ['blank', 'Partir de zéro']]
        .map(([k, label]) => `<button type="button" class="seg-btn${simu.source === k ? ' is-on' : ''}" data-source="${k}">${label}</button>`).join('')}
                </div>
                <div class="simu-bar ${over ? 'is-over' : ''}">
                    <span><strong>${num(used)}</strong> / ${num(t.slots)} places${used < t.slots
        ? ` <span style="color:var(--text-3)">· ${num(t.slots - used)} libre${t.slots - used > 1 ? 's' : ''}</span>` : ''}</span>
                    <span class="meter"><i style="width:${Math.min(100, (100 * used) / t.slots)}%"></i></span>
                    <span class="${simuTypes() > t.typeSlots ? 'v-bad' : ''}">${simuTypes()} / ${t.typeSlots} types</span>
                </div>
                ${over ? callout(`Cette composition demande <strong>${num(used - t.slots)}</strong> places de plus
                    que tes ${num(t.slots)} : elle n’est pas alignable en jeu. Elle vient d’un combat où tu avais
                    d’autres places. Touche à n’importe quelle quantité et elle reviendra dans le budget.`, 'bad') : ''}
                <p class="note">Les places sont un budget <strong>commun</strong> : chaque curseur s’arrête à
                    ce qui reste. Pour renforcer un type quand tout est distribué, baisse-en un autre d’abord.
                    Une capacité ne s’allume qu’à partir de <strong>${num(t.need)}</strong> unités (10 % de tes
                    places) — en dessous, le type la porte sans qu’elle agisse.</p>
                <div class="simu-types">${t.types.map(typeRow).join('')}</div>

                <h2 class="block">3 · Dans quelles conditions</h2>
                <div class="controls">
                    <div class="field">
                        <label for="simu-role">Rôle</label>
                        <select id="simu-role">
                            <option value="">celui du combat (${esc(sc?.role || '?')})</option>
                            <option value="attaque">j’attaque</option>
                            <option value="défense">je défends</option>
                        </select>
                    </div>
                    <div class="field">
                        <label for="simu-ready">Forme de mes troupes <output id="simu-ready-out"></output></label>
                        <input id="simu-ready" type="range" min="30" max="100" step="5"
                            value="${Math.round((sc?.readiness ?? 1) * 100)}">
                    </div>
                    <button class="btn" data-simu-run>Lancer le combat</button>
                </div>
                <p class="note">En défense, tes piles démarrent rarement à 100 % : elles récupèrent encore
                    du combat précédent. Le curseur part de la forme réellement mesurée sur ce combat-là.</p>
            </section>

            <section class="simu-result" id="simu-result">
                ${keepResult && simu.result ? renderSimuResult(simu.result) : '<p class="empty">Lance le combat pour voir le déroulé.</p>'}
            </section>
        </div>`;

    wireSimu();
}

function foeCard(sc) {
    return `<div class="foe-card">
        <div class="foe-head">
            ${avatarChip(sc.opponent.avatar, sc.opponent.name, { size: 'sm' })}
            <strong>${esc(sc.opponent.name)}</strong>
            <span class="chip chip-role">niveau ${num(sc.opponent.level)}</span>
            ${sc.fort ? `<span class="chip">${sc.fort} % de fortifications</span>` : ''}
            <span class="${sc.won ? 'v-good' : 'v-bad'}">${sc.won ? 'gagné' : 'perdu'} ce jour-là</span>
        </div>
        <p>${num(sc.army.qty)} unités · ${num(sc.army.hp)} PV ·
            <span class="foe-mix">${sc.army.piles.filter((p) => !p.reinforcement)
        .map((p) => unitChip(p.key, `${p.fr} ×${num(p.qty)}`, { size: 'sm' })).join('')}</span>
            ${sc.army.piles.some((p) => p.reinforcement) ? `<span style="color:var(--text-3)"> + ${sc.army.piles.filter((p) => p.reinforcement).length} renfort(s) de famille</span>` : ''}</p>
    </div>`;
}

function typeRow(t) {
    const qty = simu.piles.get(t.key) || 0;
    const on = qty >= simu.types.need;
    const max = roomFor(t.key);
    return `<div class="type-row${qty ? ' is-in' : ''}">
        <img class="type-face" src="${unitFace(t.key)}" alt="" width="40" height="40" loading="lazy"
            onerror="this.remove()">
        <div class="type-id">
            <strong>${esc(t.fr)}</strong>
            <small>${esc(t.roleFr || '')} · ${esc(t.abilityFr || 'sans capacité')} · niv. ${t.typeLevel}</small>
        </div>
        <div class="type-stats">
            <span title="PV par unité">${num(t.unitHp)} PV</span>
            <span title="dégâts moyens par unité et par coup">${num(t.dmgAvg)} dgt</span>
            <span title="délai entre deux coups">${String(t.speed).replace('.', ',')} s</span>
            <span title="unités possédées aujourd’hui" style="color:var(--text-3)">${num(t.owned)} en stock</span>
        </div>
        <input class="type-range" type="range" min="0" max="${max}" step="1" value="${qty}" data-qty="${t.key}" aria-label="Quantité de ${esc(t.fr)}">
        <input class="type-num" type="number" min="0" max="${max}" value="${qty}" data-qty-num="${t.key}" aria-label="Quantité de ${esc(t.fr)}">
        <span class="type-ab ${qty ? (on ? 'is-on' : 'is-off') : ''}">${qty ? (on ? '✓ capacité' : `−${num(simu.types.need - qty)}`) : ''}</span>
    </div>`;
}

function wireSimu() {
    const box = $('#simu-body');
    const ready = $('#simu-ready');
    const out = $('#simu-ready-out');
    const sync = () => { out.textContent = `${ready.value} %`; };
    sync();
    ready.addEventListener('input', sync);

    picker($('#simu-foe'), {
        items: simu.scenarios.map((s) => ({
            value: String(s.fightId),
            name: s.opponent.name,
            avatar: s.opponent.avatar,
            label: `<strong>${esc(s.opponent.name)}</strong> <span style="color:var(--text-3)">niv. ${num(s.opponent.level)}</span>`,
            sub: `${esc(s.role)} · ${esc(when(s.at))} · ${num(s.army.qty)} unités · ${s.won ? 'gagné' : 'perdu'}`,
            // Le combat se cherche aussi par type engagé : « contre qui j'ai vu des brutes ? »
            search: `${s.opponent.name} ${s.role} ${s.won ? 'gagné victoire' : 'perdu défaite'} `
                + s.army.piles.map((p) => p.fr).join(' '),
        })),
        value: simu.fightId,
        placeholder: 'Chercher un adversaire…',
        onPick: (v) => {
            simu.fightId = Number(v);
            if (simu.source === 'fight') useSource('fight');
            renderSimu({ keepResult: false });
        },
    });

    for (const b of $$('[data-source]', box)) {
        b.addEventListener('click', () => { useSource(b.dataset.source); renderSimu({ keepResult: false }); });
    }

    /* Curseur et champ numérique pilotent la même valeur : on met à jour sans re-rendre toute la
       page, sinon le curseur perdrait le focus à chaque pixel. */
    const setQty = (key, value, from) => {
        // On borne à la place encore libre, pas aux places totales : sans ça, chaque type pouvait
        // prendre le budget entier et la composition dépassait sans le dire.
        const v = Math.max(0, Math.min(roomFor(key), Math.round(Number(value) || 0)));
        simu.piles.set(key, v);
        const range = $(`[data-qty="${key}"]`, box);
        const number = $(`[data-qty-num="${key}"]`, box);
        // Toujours réécrire les deux : si la valeur a été rabotée, le champ saisi doit le montrer.
        range.value = v;
        number.value = v;
        void from;
        range.closest('.type-row').classList.toggle('is-in', v > 0);
        const badge = range.closest('.type-row').querySelector('.type-ab');
        const on = v >= simu.types.need;
        badge.className = `type-ab ${v ? (on ? 'is-on' : 'is-off') : ''}`;
        badge.textContent = v ? (on ? '✓ capacité' : `−${num(simu.types.need - v)}`) : '';
        updateRooms(box);
        updateSimuBar();
    };
    for (const el of $$('[data-qty]', box)) el.addEventListener('input', () => setQty(el.dataset.qty, el.value, 'range'));
    for (const el of $$('[data-qty-num]', box)) el.addEventListener('input', () => setQty(el.dataset.qtyNum, el.value, 'num'));

    $('[data-simu-run]').addEventListener('click', runSimu);
}

/* Donner des unités à un type en retire à tous les autres : leurs bornes suivent. Une ligne dont
   il ne reste rien à donner se signale, au lieu de laisser croire que le curseur est cassé. */
function updateRooms(box) {
    for (const range of $$('[data-qty]', box)) {
        const key = range.dataset.qty;
        const room = roomFor(key);
        const qty = simu.piles.get(key) || 0;
        range.max = String(room);
        const number = $(`[data-qty-num="${key}"]`, box);
        if (number) number.max = String(room);
        range.closest('.type-row').classList.toggle('is-full', room === qty && room > 0);
    }
}

function updateSimuBar() {
    const bar = $('.simu-bar');
    if (!bar) return;
    const used = simuUsed();
    const t = simu.types;
    bar.classList.toggle('is-over', used > t.slots);
    const left = t.slots - used;
    bar.children[0].innerHTML = `<strong>${num(used)}</strong> / ${num(t.slots)} places`
        + (left > 0 ? ` <span style="color:var(--text-3)">· ${num(left)} libre${left > 1 ? 's' : ''}</span>` : '');
    bar.children[1].querySelector('i').style.width = `${Math.min(100, (100 * used) / t.slots)}%`;
    bar.children[2].textContent = `${simuTypes()} / ${t.typeSlots} types`;
    bar.children[2].className = simuTypes() > t.typeSlots ? 'v-bad' : '';
}

async function runSimu() {
    if (simu.running) return;
    simu.running = true;
    const btn = $('[data-simu-run]');
    btn.disabled = true;
    btn.textContent = 'Combat en cours…';
    const host = $('#simu-result');
    try {
        const body = {
            opponent: { fightId: simu.fightId },
            mine: simu.source === 'fight' && !touched()
                ? { mode: 'historic' }
                : { mode: 'custom', piles: [...simu.piles].map(([key, qty]) => ({ key, qty })).filter((p) => p.qty > 0) },
            role: $('#simu-role').value || undefined,
            readiness: Number($('#simu-ready').value) / 100,
            slots: simu.types.slots,
        };
        const res = await api('/api/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        simu.result = res;
        host.innerHTML = renderSimuResult(res);
        wireSimuExport(host, res);
    } catch (e) {
        host.innerHTML = callout(e.message, 'bad');
    } finally {
        simu.running = false;
        btn.disabled = false;
        btn.textContent = 'Lancer le combat';
    }
}

/* « Celle de ce combat » non modifiée = rejeu fidèle : on passe par le mode `historic`, qui
   reconstruit les piles avec leurs PV réels d'alors plutôt qu'avec les stats d'aujourd'hui. */
function touched() {
    const sc = currentScenario();
    if (!sc) return true;
    const was = new Map(sc.mine.map((p) => [p.key, p.qty]));
    if (was.size !== [...simu.piles].filter(([, q]) => q > 0).length) return true;
    for (const [k, q] of simu.piles) {
        if (q > 0 && was.get(k) !== q) return true;
    }
    return false;
}

/* ── Export d'une simulation pour un agent IA ──────────────────────────────── */

function wireSimuExport(host, res) {
    const note = $('[data-copy-note]', host);
    $('[data-simu-copy]', host)?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
            const md = buildSimuMarkdown(res);
            await navigator.clipboard.writeText(md);
            if (note) note.innerHTML = `<span class="v-good">Copié — ${num(md.length)} caractères.</span>`;
        } catch (err) {
            if (note) note.innerHTML = `<span class="v-bad">Copie impossible (${esc(err.message)}).</span>`;
        } finally {
            e.target.disabled = false;
        }
    });
    $('[data-simu-dl]', host)?.addEventListener('click', () => {
        downloadMd(`sss-simulation-${res.setup.fightId}-${Date.now()}.md`, buildSimuMarkdown(res));
    });
}

/* Le compte rendu d'une simulation, en Markdown. Même contrat que les autres exports : le mesuré
   annoncé comme tel, le modélisé chiffré, les limites en clair — un agent qui ignore ce qu'il ne
   sait pas donne de mauvais conseils avec aplomb. */
function buildSimuMarkdown(res) {
    const r = res.result;
    const mc = r.monteCarlo;
    const fmt = (x) => String(x ?? '—').replace('.', ',');
    const o = [];
    const H = (l, t) => o.push(`${'#'.repeat(l)} ${t}`, '');
    const P = (...xs) => o.push(...xs.filter(Boolean), '');
    const T = (head, rows) => {
        o.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
        for (const row of rows) o.push(`| ${row.join(' | ')} |`);
        o.push('');
    };
    const armyT = (a) => T(
        ['Type', 'Qté', 'PV/unité', 'Dégâts moyens/coup', 'Crit %', 'Riposte %', 'Cadence', 'Capacité'],
        a.piles.map((p) => [
            p.fr, num(p.qty), num(p.unitHp), num(p.dmgAvg), fmt(p.crit), fmt(p.counter),
            `${fmt(p.speed)} s`,
            p.abilityFr ? `${p.abilityFr}${p.abilityOn ? ' ✓' : ' (éteinte : sous 10 % des places)'}` : '—',
        ]),
    );

    H(1, `Simulation — ${res.setup.role} contre ${res.setup.opponent.name}`);
    P('*Généré par [sss-play-check]. Le moteur rejoue les mécaniques EXACTES du jeu, rétro-conçues'
        + ' et vérifiées à l’unité près sur mon archive de combats (tirages uniformes min…max,'
        + ' vivants = ceil(PV ÷ PV unitaire), riposte min(cible, attaquant) × 0,6, bouclier en pool'
        + ' commun de 8 % des PV de départ, seuils mesurés des capacités). Le jeu tire les dégâts au'
        + ' hasard : le verdict est une probabilité, pas une promesse. Je cherche un avis : cette'
        + ' composition vaut-elle le coup, et quoi changer ?*');

    H(2, 'Mise en place');
    P(`- adversaire : **${res.setup.opponent.name}** (niveau ${res.setup.opponent.level}), armée relevée`
        + ` dans le combat réel n°${res.setup.fightId} — son équipement, ses fortifications, ses talents mesurés`,
    `- rôle : **${res.setup.role}** · ses murs ${res.setup.fort.theirs || 0} % · les miens ${res.setup.fort.mine || 0} %`
        + `${res.setup.guard ? ` · plancher du poste de garde ${res.setup.guard} %` : ''}`,
    `- ma composition : ${res.setup.source} · ${num(res.mine.qty)} unités sur ${num(res.setup.slots)} places`
        + `${res.setup.role === 'défense' ? ` · forme de mes troupes : ${pct(res.setup.readiness)}` : ''}`,
    `- multiplicateur critique : ×${fmt(res.setup.critMult)} pour moi (mesuré dans mes journaux)`);

    H(2, 'Mon armée — stats réelles (cartes du shop : talents et équipement compris)');
    armyT(res.mine);
    H(2, `Son armée — mesurée (PV servis par le jeu, cadence et talents mesurés dans ses combats)`);
    armyT(res.theirs);

    H(2, 'Résultat — modélisé');
    if (mc) {
        P(`- **${fmt(mc.pWin)} % de victoires** sur ${num(mc.runs)} tirages réels (${num(mc.wins)} gagnés)`,
            `- marge (part de PV restants, moi − lui) : médiane ${fmt(mc.margin.p50)}, de ${fmt(mc.margin.p10)} à ${fmt(mc.margin.p90)} selon les tirages`,
            `- durée : ${fmt(mc.seconds.p50)} s en médiane (${fmt(mc.seconds.p10)}–${fmt(mc.seconds.p90)})`,
            `- PV restants moyens : moi ${pct(mc.left.A)}, lui ${pct(mc.left.B)}`);
    }
    if (r.chance) {
        P(`Lecture historique : parmi mes ${r.chance.sample} combats passés à marge simulée comparable`
            + ` (${fmt(r.chance.span[0])} à ${fmt(r.chance.span[1])}), j'en ai réellement gagné ${r.chance.wins}`
            + ` (${r.chance.pct} %).`);
    }
    if (res.record) {
        P(`La même composition contre TOUS mes ${res.record.fights} combats archivés : ${res.record.wins} victoires`
            + ` (${fmt(res.record.winRate)} %) — ${res.record.attack.wins}/${res.record.attack.fights} en attaque,`
            + ` ${res.record.defense.wins}/${res.record.defense.fights} en défense.`);
    }
    if (res.real) {
        P(`Ce jour-là, en vrai : **${res.real.won ? 'victoire' : 'défaite'}** en ${fmt(res.real.seconds)} s avec `
            + `${res.real.myPiles.map((p) => `${p.fr} ×${num(p.qty)}`).join(', ')} (${res.real.delta >= 0 ? '+' : ''}${res.real.delta} points).`);
    }
    if (r.trace?.abilities?.length) {
        H(2, 'Capacités déclenchées (passe médiane)');
        for (const [t, side, key, amount] of r.trace.abilities) {
            o.push(`- ${(t / 100).toFixed(2).replace('.', ',')} s · ${side === 0 ? 'moi' : res.setup.opponent.name} : `
                + `${ABILITY_FR_UI[key] || key}${amount ? ` (${num(amount)})` : ''}`);
        }
        o.push('');
    }
    H(2, 'Pile par pile (passe médiane)');
    T(['Camp', 'Type', 'Engagées', 'Survivantes', 'Dégâts infligés', 'subis', 'PV restants'],
        [...r.piles.A.map((p) => ['moi', ...pileRow(p)]), ...r.piles.B.map((p) => [res.setup.opponent.name, ...pileRow(p)])]);

    H(2, 'Fiabilité et limites');
    P(`- Sur tout mon historique, ce moteur retrouve le bon vainqueur dans ${fmt(r.accuracy)} % des cas`
        + ' (informations d’avant-combat seulement, leave-one-out).',
    '- Non modélisé : renforts de famille, objets que je pourrais forger, capacités jamais croisées'
        + ' en combat (encodées depuis les règles).',
    '- Raisonne en probabilités : la même situation peut basculer dans les deux sens.');

    H(2, 'Questions à l’agent');
    P('1. Cette composition est-elle la bonne contre cet adversaire ? Sinon, que changer en priorité ?',
        '2. Quelles capacités pèsent vraiment ici, et lesquelles sont payées pour rien ?',
        '3. Si la probabilité est serrée, qu’est-ce qui la ferait basculer durablement de mon côté ?');

    return `${o.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const pileRow = (p) => [p.fr, num(p.qty), num(p.alive ?? '—'), num(p.dealt), num(p.taken), pct(p.left)];

/* ── Le combat, tel qu'il se déroule ───────────────────────────────────────── */

function renderSimuResult(res) {
    const r = res.result;
    const real = res.real;
    // Le rejeu d'un vrai combat a une vérité à côté de laquelle se mesurer : on la montre.
    const replay = res.setup.source.startsWith('ta composition de ce jour-là');

    /* Le verdict est une PROBABILITÉ : le même duel joué des centaines de fois avec de vrais
       tirages (le moteur reproduit les mécaniques exactes du jeu, tirages uniformes min…max,
       critiques, ripostes, capacités). Entre 25 % et 75 %, c'est une pièce qu'on lance. */
    const mc = r.monteCarlo;
    const p = mc ? mc.pWin : (r.iWon ? 100 : 0);
    const won = p >= 50;
    const tossUp = p >= 25 && p <= 75;
    const tone = tossUp ? 'is-close' : (won ? 'is-win' : 'is-loss');
    const label = tossUp ? 'Trop serré' : (won ? 'Victoire probable' : 'Défaite probable');
    const c = r.chance;
    const fmt = (x) => String(x).replace('.', ',');

    return `
        <div class="verdict ${tone}">
            <div class="verdict-main">
                <span class="verdict-label">${label}</span>
                <span class="verdict-sub">contre ${esc(res.setup.opponent.name)} · ${esc(res.setup.role)}</span>
                ${mc ? `<span class="verdict-odds">tu gagnes <strong>${fmt(p)} %</strong> des
                    ${num(mc.runs)} combats simulés avec de vrais tirages (${num(mc.wins)} victoires)</span>` : ''}
            </div>
            <dl class="verdict-stats">
                ${mc ? `
                <div><dt>Probabilité</dt><dd>${fmt(p)} %</dd></div>
                <div><dt>Marge médiane</dt><dd>${mc.margin.p50 > 0 ? '+' : ''}${fmt(mc.margin.p50)}
                    <small style="color:var(--text-3)">(${fmt(mc.margin.p10)} à ${fmt(mc.margin.p90)})</small></dd></div>
                <div><dt>Durée</dt><dd>${fmt(mc.seconds.p50)} s
                    <small style="color:var(--text-3)">(${fmt(mc.seconds.p10)}–${fmt(mc.seconds.p90)})</small></dd></div>
                <div><dt>Mes PV restants</dt><dd>${pct(mc.left.A)}</dd></div>
                <div><dt>Les siens</dt><dd>${pct(mc.left.B)}</dd></div>` : `
                <div><dt>Marge</dt><dd>${r.margin > 0 ? '+' : ''}${fmt(r.margin)}</dd></div>
                <div><dt>Durée</dt><dd>${fmt(r.seconds)} s</dd></div>
                <div><dt>Mes PV restants</dt><dd>${pct(r.left.A)}</dd></div>
                <div><dt>Les siens</dt><dd>${pct(r.left.B)}</dd></div>`}
            </dl>
        </div>

        ${mc && c ? oddsCallout(c, r, tossUp, mc) : ''}

        <div class="export-row">
            <button type="button" class="btn" data-simu-copy>Copier pour un agent IA</button>
            <button type="button" class="btn" data-simu-dl>Télécharger .md</button>
            <span class="note" style="margin:0">Toute la simulation en Markdown — armées, probabilité,
                déroulé — à coller dans une conversation avec un agent IA.</span>
            <span data-copy-note></span>
        </div>

        ${replay
        ? callout(`<strong>Rejeu fidèle.</strong> Avec ta composition de ce jour-là, la réalité a été
            <strong>${real.won ? 'une victoire' : 'une défaite'}</strong> en ${fmt(real.seconds)} s.
            ${tossUp
        ? `Le simulateur donne ${fmt(p)} % de victoires : à ce niveau-là, l’issue se joue sur les
               tirages de dégâts, pas sur la composition.
               ${won === real.won ? 'Il penchait du bon côté cette fois.' : 'C’est le tirage qui a décidé, pas un défaut du modèle.'}`
        : `Le simulateur donne <strong>${fmt(p)} % de victoires</strong> —
               ${won === real.won ? 'il retrouve le bon vainqueur.' : 'il se trompe ici, et à cette probabilité ce n’est pas attendu.'}`}`,
            tossUp ? null : (won === real.won ? 'good' : 'bad'))
        : callout(`<strong>Ce jour-là tu as ${real.won ? 'gagné' : 'perdu'}</strong> avec
            ${real.myPiles.map((p) => `${esc(p.fr)}&nbsp;×${num(p.qty)}`).join(', ')}
            (${fmt(real.seconds)} s, ${real.delta >= 0 ? '+' : ''}${real.delta} points).
            Ci-dessus, le même adversaire affronté par la composition que tu viens de monter.`)}

        <h3 class="block">Le déroulé <small style="color:var(--text-3);font-weight:normal">— la passe
            la plus typique des ${mc ? num(mc.runs) : ''} tirages (issue médiane)</small></h3>
        ${hpChart(r.trace, res)}

        <h3 class="block">Pile par pile</h3>
        ${simuPilesTable(res)}

        ${r.trace.abilities.length ? `
            <h3 class="block">Capacités déclenchées</h3>
            <ol class="ab-list">
                ${r.trace.abilities.map(([t, side, key, amount]) => `<li class="${side === 0 ? 'is-mine' : 'is-theirs'}">
                    <span class="ab-t">${(t / 100).toFixed(2).replace('.', ',')} s</span>
                    <span class="ab-who">${side === 0 ? 'moi' : esc(res.setup.opponent.name)}</span>
                    <span class="ab-key">${esc(ABILITY_FR_UI[key] || key)}</span>
                    ${amount ? `<span class="ab-amount">${num(amount)}</span>` : ''}
                </li>`).join('')}
            </ol>` : ''}

        ${res.record ? `
            <h3 class="block">Et contre tous les autres ?</h3>
            ${callout(`Un duel ne prouve rien tout seul. La même composition, jouée contre
                <strong>les ${res.record.fights} combats</strong> de ton historique, en gagne
                <strong>${res.record.wins}</strong> (${res.record.winRate} %) —
                ${res.record.attack.wins}/${res.record.attack.fights} en attaque,
                ${res.record.defense.wins}/${res.record.defense.fights} en défense.
                <span style="color:var(--text-3)">Les combats défensifs sont rejoués avec la forme
                réglée ci-contre (${pct(res.setup.readiness)}) : baisse-la pour voir ce que donne une
                armée qui n’a pas fini de récupérer.</span>`,
            res.record.winRate >= 50 ? 'good' : null)}` : ''}

        <p class="note">Le moteur rejoue les <strong>mécaniques exactes du jeu</strong>, rétro-conçues
            depuis les frises de coups de ton archive : tirages uniformes min…max, vivants =
            ceil(PV ÷ PV unitaire), riposte min(cible, attaquant) × 0,6, bouclier en pool commun de
            8 % des PV de départ, seuils et amplitudes mesurés des capacités (voir « Ce que
            l’historique dit du moteur » dans l’onglet Analyse). Le jeu tire les dégâts et les
            critiques au hasard — ton historique en contient la preuve : les combats 11055 et 11060
            opposent les mêmes armées, l’un est gagné, l’autre perdu. Le verdict est donc une
            <strong>probabilité</strong>, pas une promesse.
            ${res.result.accuracy ? `Sur l’ensemble de ton historique, le moteur retrouve le bon
            vainqueur dans ${res.result.accuracy} % des cas, en ne partant que des informations
            d’avant-combat.` : ''}</p>`;
}

/* Un simulateur déterministe donne toujours la même réponse pour la même situation. Le jeu, lui,
   tire les dégâts et les critiques au hasard. Afficher « victoire » sans dire à quel point c'est
   joué, c'est transformer une tendance en promesse — et c'est ce qui donne l'impression que le
   simulateur se trompe quand un combat « gagné » est perdu en vrai. */
function oddsCallout(c, r, tossUp, mc) {
    return callout(`<strong>Deux lectures qui se recoupent.</strong>
        Le <strong>Monte-Carlo</strong> rejoue ce duel ${num(mc.runs)} fois avec de vrais tirages
        (dégâts uniformes min…max, critiques, ripostes, cibles au sort) : <strong>${String(mc.pWin).replace('.', ',')} %</strong>
        de victoires, marge de ${String(mc.margin.p10).replace('.', ',')} à ${String(mc.margin.p90).replace('.', ',')}
        selon les tirages. L’<strong>historique</strong> confirme : sur tes ${c.sample} combats passés dont la
        marge simulée était la plus proche (${String(c.span[0]).replace('.', ',')} à
        ${String(c.span[1]).replace('.', ',')}), tu en as réellement gagné ${c.wins}, soit ${c.pct} %.
        ${tossUp
        ? '<strong>Autrement dit : c’est une pièce qu’on lance.</strong> À ce niveau-là, l’issue dépend'
          + ' des tirages, pas de ta composition.'
        : 'Les deux lectures sont assez franches pour que l’issue dépende peu des tirages.'}`,
    tossUp ? null : (mc.pWin >= 50 ? 'good' : 'bad'));
}

/* Courbe des PV des deux camps, avec les capacités en repères. Deux lignes, pas d'aire empilée :
   on compare deux trajectoires, on ne décompose pas un total. */
function hpChart(trace, res) {
    const pts = trace.hp;
    if (pts.length < 2) return '<p class="note">Combat trop court pour tracer une courbe.</p>';
    const W = 100;
    const H = 42;
    const maxT = pts[pts.length - 1][0] || 1;
    const x = (t) => (t / maxT) * W;
    const y = (v) => H - v * H;
    const line = (idx) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(2)} ${y(p[idx]).toFixed(2)}`).join(' ');

    const marks = trace.abilities.map(([t, side, key]) => `
        <line x1="${x(t).toFixed(2)}" y1="0" x2="${x(t).toFixed(2)}" y2="${H}"
            stroke="${side === 0 ? 'var(--d-teal)' : 'var(--d-rose)'}" stroke-width=".25" stroke-dasharray="1.5 1.5" opacity=".55"/>`).join('');

    const seconds = Math.ceil(maxT / 100);
    const ticks = Array.from({ length: seconds + 1 }, (_, i) => i)
        .filter((i) => seconds <= 12 || i % Math.ceil(seconds / 10) === 0);

    return `
        <figure class="chart">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
                aria-label="Part de PV restants au fil du combat, moi contre ${esc(res.setup.opponent.name)}">
                ${[0.25, 0.5, 0.75].map((g) => `<line x1="0" y1="${y(g)}" x2="${W}" y2="${y(g)}" stroke="var(--line-soft)" stroke-width=".2"/>`).join('')}
                ${marks}
                <path d="${line(2)}" fill="none" stroke="var(--d-rose)" stroke-width=".9" vector-effect="non-scaling-stroke"/>
                <path d="${line(1)}" fill="none" stroke="var(--d-teal)" stroke-width="1.1" vector-effect="non-scaling-stroke"/>
            </svg>
            <div class="chart-x">${ticks.map((i) => `<span>${i} s</span>`).join('')}</div>
            <figcaption>
                <span class="key"><i style="background:var(--d-teal)"></i> mes PV</span>
                <span class="key"><i style="background:var(--d-rose)"></i> les siens</span>
                <span class="key"><i class="dash"></i> capacité déclenchée</span>
                <span style="color:var(--text-3)">part des PV maximum de chaque camp</span>
            </figcaption>
        </figure>`;
}

function simuPilesTable(res) {
    const rows = [
        ...res.result.piles.A.map((p) => ({ ...p, side: 'moi' })),
        ...res.result.piles.B.map((p) => ({ ...p, side: res.setup.opponent.name })),
    ];
    return dataTable(
        ['Camp', 'Type', 'Quantité', 'Capacité', 'Dégâts infligés', 'Dégâts subis', 'PV restants'],
        rows.map((p) => [
            p.side === 'moi' ? '<span class="chip chip-on">moi</span>' : `<span class="chip chip-off">${esc(p.side)}</span>`,
            unitChip(p.key.replace(/@.*/, ''), p.fr),
            num(p.qty),
            p.ability
                ? (p.abilityOn ? `<span class="chip chip-on">${esc(p.abilityFr || p.ability)}</span>`
                    : `<span class="chip chip-off">${esc(p.abilityFr || p.ability)} éteinte</span>`)
                : '—',
            num(p.dealt),
            num(p.taken),
            `<span class="${p.left > 0.3 ? 'v-good' : 'v-bad'}">${pct(p.left)}</span>`,
        ]),
        [0, 0, 1, 0, 1, 1, 1],
    );
}

const ABILITY_FR_UI = {
    ambush: 'Embuscade', freeze: 'Gel du temps', frenzy: 'Frénésie', shield: 'Bouclier',
    shockwave: 'Onde de choc', execute: 'Coup de grâce', rage: 'Rage', fortress: 'Forteresse',
    second_wind: 'Second souffle', last_stand: 'Dernier carré', intimidate: 'Intimidation',
    bleed: 'Saignée', reflect: 'Renvoi', corrupt: 'Corruption',
};

/* ── Compositions ──────────────────────────────────────────────────────────── */

async function runCompos({ silent = false } = {}) {
    const s = state.server;
    const slots = $('#f-slots')?.value || s?.crew?.slots || '';
    const types = $('#f-types')?.value || s?.crew?.typeSlots || '';
    const ready = $('#f-ready')?.value;
    const q = new URLSearchParams();
    if (slots) q.set('slots', slots);
    if (types) q.set('types', types);
    if (ready) q.set('readiness', String(Number(ready) / 100));
    // La recherche passe des milliers de compositions contre tout l'historique : quelques secondes.
    $('#compos-body').innerHTML = '<p class="empty">Recherche en cours — chaque composition est jouée contre tous tes combats archivés…</p>';
    let res;
    try {
        res = await api(`/api/compos?${q}`);
    } catch (e) {
        $('#compos-body').innerHTML = callout(e.message, 'bad');
        return;
    }
    if (res.empty) {
        $('#compos-body').innerHTML = callout(res.reason, 'bad');
        if (!silent) location.hash = 'compos';
        return;
    }
    state.compos = res;
    renderCompos();
    if (!silent) location.hash = 'compos';
}

function renderCompos() {
    const box = $('#compos-body');
    const res = state.compos;
    if (!res) {
        const s = state.server;
        box.innerHTML = `${controls({ slots: s?.crew?.slots, maxTypes: s?.crew?.typeSlots }, 70)}
            <p class="empty">Lance la recherche : chaque composition est jouée contre tes
            ${s?.fights?.count ?? 0} combats archivés.</p>`;
        wireControls();
        return;
    }
    const c = res.compos;
    const bt = res.backtest;

    box.innerHTML = `
        ${controls(c, Math.round(res.readiness * 100))}
        ${callout(`${c.screened.toLocaleString('fr-FR')} compositions passées en revue sur ${c.scenarios} adversaires
            réels. Le simulateur retrouve le bon vainqueur dans ${bt.accuracy} % de l’historique
            (pouvoir de classement ${bt.separation}) : ce classement est un ordre de préférence, pas une promesse.`)}

        <h2 class="block">Les meilleures</h2>
        ${c.best.map((b, i) => compoRow(b, i)).join('')}

        ${c.current ? `<h2 class="block">Ta composition actuelle</h2>${compoRow(c.current, null, true)}` : ''}

        ${c.current && c.best[0] ? callout(gainText(c.best[0], c.current, c.need), c.best[0].wins > c.current.wins ? 'good' : null) : ''}
        ${healedCallout(res)}

        <h2 class="block">Pourquoi ces quantités</h2>
        <div class="cards">
            <div class="card">
                <h3>Le seuil des 10 %</h3>
                <p>Une capacité n’agit que si le type atteint <strong>${c.need} unités</strong> (10 % de tes
                    ${c.slots} places). En dessous, elle est éteinte. C’est pour ça que les compositions proposées
                    posent presque toujours exactement ${c.need} unités sur les types « porteurs de capacité »
                    et versent tout le reste sur le type qui frappe le mieux.</p>
            </div>
            <div class="card">
                <h3>L’état de tes troupes</h3>
                <p>En défense, tes piles démarrent à <strong>${Math.round(res.readiness * 100)} %</strong> de leurs PV :
                    c’est la médiane mesurée sur ton historique, parce qu’une attaque arrive avant la fin de la
                    récupération. L’attaquant, lui, part toujours à 100 %. Le curseur ci-dessus permet de voir
                    ce que vaudrait chaque composition si tu défendais avec des troupes soignées.</p>
            </div>
            <div class="card">
                <h3>Comment lire les deux pourcentages</h3>
                <p>Le <strong>classement</strong> (N/68) vient du mode « espérances » : déterministe, deux
                    compositions se comparent sans bruit. Le <strong>% aux tirages réels</strong> rejoue
                    chaque combat des dizaines de fois avec les vrais tirages du moteur (dégâts min…max,
                    critiques, ripostes) : c’est la probabilité, hasard compris. Non modélisé : les renforts
                    de famille et les objets que tu pourrais forger.</p>
            </div>
        </div>`;
    wireControls();
    wireTryButtons(box);
}

/* Depuis une composition proposée, aller la jouer en duel : c'est le chaînon qui manquait entre
   « voilà ce qui gagnerait le plus souvent » et « montre-moi ce que ça donne contre lui ».
   `fightId` précharge l'adversaire exact ; `autorun` lance le combat sans clic supplémentaire. */
async function trySimulator(piles, { fightId = null, autorun = false } = {}) {
    if (!simu.types) await loadSimu();
    if (fightId != null && simu.scenarios?.some((s) => s.fightId === Number(fightId))) {
        simu.fightId = Number(fightId);
    }
    simu.source = 'blank';
    simu.piles = new Map(piles.map((p) => [p.key, p.qty]));
    simu.result = null;
    location.hash = 'simulateur';
    renderSimu({ keepResult: false });
    if (autorun) await runSimu();
}

function wireTryButtons(box) {
    for (const b of $$('[data-try]', box)) {
        b.addEventListener('click', () => trySimulator(JSON.parse(b.dataset.try), {
            fightId: b.dataset.tryFight ?? null,
            autorun: b.dataset.tryRun === '1',
        }));
    }
}

function controls(c, ready) {
    return `
        <div class="controls">
            <div class="field">
                <label for="f-slots">Places de troupes</label>
                <input id="f-slots" type="number" min="10" max="100000" value="${c?.slots ?? ''}">
            </div>
            <div class="field">
                <label for="f-types">Emplacements de types</label>
                <select id="f-types">
                    ${[3, 4, 5].map((n) => `<option value="${n}" ${Number(c?.maxTypes) === n ? 'selected' : ''}>${n}${n === 5 ? ' (Annexe)' : ''}</option>`).join('')}
                </select>
            </div>
            <div class="field">
                <label for="f-ready">Forme en défense <output id="o-ready">${ready} %</output></label>
                <input id="f-ready" type="range" min="30" max="100" step="5" value="${ready}">
            </div>
            <button class="btn" data-recompute>Chercher</button>
        </div>`;
}

function wireControls() {
    const r = $('#f-ready');
    if (r) r.addEventListener('input', () => { $('#o-ready').textContent = `${r.value} %`; });
    const go = $('[data-recompute]');
    if (go) {
        go.addEventListener('click', async () => {
            go.disabled = true;
            go.textContent = 'Calcul…';
            try { await runCompos(); } catch (e) { toast(e.message, 'bad'); } finally { go.disabled = false; go.textContent = 'Chercher'; }
        });
    }
}

function compoRow(b, rank, current = false) {
    const cls = current ? 'compo is-current' : `compo${rank === 0 ? ' is-best' : ''}`;
    const cost = Object.entries(b.cost || {}).filter(([, v]) => v > 0)
        .map(([k, v]) => `${num(v)} ${({ cash: '$', alcohol: 'alcool', weed: 'herbe', powder: 'poudre' })[k] || k}`).join(' · ');
    return `
        <article class="${cls}">
            <div class="compo-rank">${current ? '—' : `0${rank + 1}`.slice(-2)}</div>
            <div class="compo-mix">
                ${b.types.map((t) => `
                    <span class="unit ${t.abilityOn ? '' : 'is-off'}">
                        <img class="u-face" src="${unitFace(t.key)}" alt="" width="32" height="32" loading="lazy"
                            onerror="this.remove()">
                        <b>${esc(t.fr)}</b><span class="qty">×${num(t.qty)}</span>
                        <span class="ab">${t.abilityOn ? esc(t.abilityFr || '') : 'capacité éteinte'}</span>
                    </span>`).join('')}
            </div>
            <div class="compo-score">
                <b class="${b.wins / b.fights >= 0.5 ? 'v-good' : 'v-bad'}">${b.wins}/${b.fights}</b>
                <span>${b.winRate} % des combats archivés</span>
                ${b.pWin != null ? `<span title="Part de victoires quand chaque combat est rejoué avec de vrais tirages (Monte-Carlo)">
                    ${String(b.pWin).replace('.', ',')} % aux tirages réels</span>` : ''}
            </div>
            <div class="compo-meta">
                ${current ? '' : `<button type="button" class="link" data-try='${esc(JSON.stringify(b.types.map((t) => ({ key: t.key, qty: t.qty }))))}'>Essayer dans le simulateur</button>`}
                <span>${num(b.slotsUsed)} places</span>
                <span>DPS ${num(b.dps)}</span>
                <span>PV ${num(b.hp)}</span>
                <span>${b.abilitiesOn.length} capacité(s) : ${esc(b.abilitiesOn.join(', ')) || '—'}</span>
                ${cost ? `<span>recrutement : ${cost}</span>` : ''}
            </div>
        </article>`;
}

/* Le levier le plus lourd n'est pas la composition mais l'état des troupes au moment d'encaisser. */
function healedCallout(res) {
    const best = res.compos.best[0];
    const healed = res.healed;
    if (!best || !healed || healed.wins <= best.wins) return '';
    return callout(`<strong>Le vrai levier est ailleurs.</strong> La même recherche, mais avec des troupes
        <em>soignées</em> au moment d’encaisser (100 % au lieu de ${Math.round(res.readiness * 100)} %),
        trouve <strong>${healed.wins}/${healed.fights} combats gagnés</strong> au lieu de ${best.wins}
        — soit ${healed.winRate} % contre ${best.winRate} %. Aucune composition ne rattrape ça :
        fais évoluer le <strong>Dispensaire</strong> (Clinique puis Hôpital : −30 %, −40 % puis −50 % de temps
        de récupération), soigne au cœur vert avant de te déconnecter, ou passe par la planque le temps de
        remonter. Compo visée dans ce cas : ${healed.types.map((t) => `${esc(t.fr)} ×${num(t.qty)}`).join(' + ')}.`,
    'good');
}

function gainText(best, current, need) {
    const off = current.types.filter((t) => !t.abilityOn);
    const delta = best.wins - current.wins;
    if (delta <= 0) return 'Ta composition actuelle tient déjà la comparaison : aucune des compositions testées ne fait mieux sur ton historique.';
    return `Passer de ta composition actuelle à la première ferait gagner <strong>${delta} combats de plus</strong>
        sur les ${current.fights} de ton historique (${current.winRate} % → ${best.winRate} %).`
        + (off.length ? ` Au passage, ${off.map((t) => `<strong>${esc(t.fr)}</strong>`).join(' et ')}
        ${off.length > 1 ? 'portent' : 'porte'} aujourd’hui une capacité éteinte, faute d’atteindre ${need} unités.` : '');
}

/* ── Documents ─────────────────────────────────────────────────────────────── */

async function openDoc(view, name) {
    const host = $(`#view-${view}`);
    const article = $('.doc', host);
    const toc = $('.toc-inner', host);
    if (state.docs[name]) {
        if (article.dataset.name === name) return;
    }
    article.innerHTML = '<p class="empty">Chargement…</p>';
    let md;
    try {
        md = state.docs[name] || (await api(`/api/doc?name=${encodeURIComponent(name)}`)).markdown;
    } catch (e) {
        article.innerHTML = callout(e.message, 'bad');
        toc.innerHTML = '';
        return;
    }
    state.docs[name] = md;
    article.dataset.name = name;
    article.innerHTML = `<div class="doc-search">
            <input type="search" placeholder="Chercher dans ce document…" aria-label="Chercher dans ce document">
        </div>${renderMarkdown(dropToc(md))}`;
    buildToc(article, toc);
    wireAnchors(article);
    wireDocSearch(article);
}

/* Le document porte son propre « Sommaire » ; le rail de gauche le reprend, inutile de l'afficher
   deux fois. On coupe la section, de son titre jusqu'au suivant de même niveau. */
function dropToc(md) {
    const lines = md.split('\n');
    const start = lines.findIndex((l) => /^##\s+Sommaire\s*$/i.test(l));
    if (start < 0) return md;
    let end = start + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end]) && !/^---+\s*$/.test(lines[end])) end += 1;
    return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/* Les ancres internes du document ne doivent pas écraser le routage de la page : « #les-troupes »
   n'est pas une vue. On intercepte le clic et on fait défiler, sans toucher à location.hash. */
function wireAnchors(article) {
    for (const a of $$('a[href^="#"]', article)) {
        const id = decodeURIComponent(a.getAttribute('href').slice(1));
        if (VIEWS[id]) continue; // lien vers une autre vue : on laisse le routeur faire
        a.addEventListener('click', (e) => {
            const target = document.getElementById(id) || $$('h1, h2, h3', article).find((h) => h.id === id);
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
}

function buildToc(article, toc) {
    const heads = $$('h2, h3', article);
    toc.innerHTML = heads.map((h) => `<a href="#${h.id}" class="lvl-${h.tagName[1]}">${esc(h.textContent)}</a>`).join('');
    for (const a of $$('a', toc)) {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            $(`#${CSS.escape(a.getAttribute('href').slice(1))}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }
    // Surligne la section visible.
    const obs = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            for (const a of $$('a', toc)) a.removeAttribute('aria-current');
            const link = $(`a[href="#${CSS.escape(en.target.id)}"]`, toc);
            if (link) {
                link.setAttribute('aria-current', 'true');
                link.scrollIntoView({ block: 'nearest' });
            }
        }
    }, { rootMargin: '-10% 0px -80% 0px' });
    for (const h of heads) obs.observe(h);
}

function wireDocSearch(article) {
    const input = $('input[type=search]', article);
    const blocks = $$('h2, h3, p, li, tr, blockquote', article);
    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        for (const el of blocks) {
            const hit = !q || el.textContent.toLowerCase().includes(q);
            el.style.opacity = hit ? '' : '.22';
        }
        if (q.length >= 2) {
            const first = blocks.find((el) => el.textContent.toLowerCase().includes(q));
            if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });
}

/* ── Rendu Markdown ────────────────────────────────────────────────────────── */

/* Sous-ensemble produit par src/rules.mjs et src/troops.mjs : titres #/##/###,
   paragraphes, listes - et 1., citations >, tableaux |, règles ---, et en ligne
   **gras**, *italique*, `code`, [lien](url). */
export function renderMarkdown(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const slugs = new Set();
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i += 1; continue; }

        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
            const level = h[1].length;
            const text = h[2].trim();
            const id = uniqueSlug(text, slugs);
            out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
            i += 1;
            continue;
        }

        if (/^---+\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }

        if (line.startsWith('|')) {
            const rows = [];
            while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i]); i += 1; }
            out.push(table(rows));
            continue;
        }

        if (line.startsWith('> ')) {
            const quote = [];
            while (i < lines.length && lines[i].startsWith('> ')) { quote.push(lines[i].slice(2)); i += 1; }
            out.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join('')}</blockquote>`);
            continue;
        }

        if (/^\s*[-*]\s+/.test(line)) {
            const block = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { block.push(lines[i]); i += 1; }
            out.push(nestedList(block, 'ul'));
            continue;
        }

        if (/^\s*\d+\.\s+/.test(line)) {
            const block = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { block.push(lines[i]); i += 1; }
            out.push(nestedList(block, 'ol'));
            continue;
        }

        const para = [];
        while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|[-*]\s|\d+\.\s|\||>\s|---)/.test(lines[i])) {
            para.push(lines[i]);
            i += 1;
        }
        out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return out.join('\n');
}

/* Les sommaires générés imbriquent par l'indentation (deux espaces par niveau). */
function nestedList(block, tag) {
    const items = block.map((l) => ({
        depth: Math.floor((/^\s*/.exec(l)[0].length) / 2),
        text: l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''),
    }));
    const walk = (from, depth) => {
        let html = '';
        let i = from;
        while (i < items.length && items[i].depth >= depth) {
            if (items[i].depth > depth) { i += 1; continue; }
            const child = i + 1 < items.length && items[i + 1].depth > depth;
            html += `<li>${inline(items[i].text)}`;
            if (child) {
                const sub = walk(i + 1, depth + 1);
                html += sub.html;
                i = sub.next;
            } else i += 1;
            html += '</li>';
        }
        return { html: `<${tag}>${html}</${tag}>`, next: i };
    };
    return walk(0, items[0]?.depth ?? 0).html;
}

function table(rows) {
    const cells = (row) => row.replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    const isRule = (row) => /^\|[\s:|-]+\|?$/.test(row.trim());
    const head = rows[0] && rows[1] && isRule(rows[1]) ? cells(rows[0]) : null;
    const body = rows.filter((r, n) => !isRule(r) && !(head && n === 0)).map(cells);
    const th = (c) => `<th>${inline(c)}</th>`;
    // La première colonne sert souvent d'intitulé de ligne : on la marque comme telle.
    const tr = (cs) => `<tr>${cs.map((c, n) => (n === 0 && head && /^\*\*/.test(c) ? th(c) : `<td>${inline(c)}</td>`)).join('')}</tr>`;
    return `<div class="table-wrap"><table>${head ? `<thead><tr>${head.map(th).join('')}</tr></thead>` : ''}<tbody>${body.map(tr).join('')}</tbody></table></div>`;
}

function inline(text) {
    return esc(text)
        .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
        /* Les images avant les liens : `![x](y)` contient `[x](y)`. Seules les sources locales
           sont acceptées — les documents sont générés ici, ils ne pointent pas vers l'extérieur. */
        .replace(/!\[([^\]]*)\]\((\/[^)\s]+)\)/g, (_, alt, src) => `<img class="doc-img" src="${src}" alt="${alt}" loading="lazy" onerror="this.remove()">`)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
            const safe = /^(https?:|#|\/)/i.test(href) ? href : '#';
            const local = /\.md$/i.test(safe);
            const target = local ? `#${safe.replace(/\.md$/i, '').replace(/^.*\//, '') === 'regles' ? 'regles' : 'troupes'}` : safe;
            return `<a href="${target}"${local ? '' : ' target="_blank" rel="noreferrer"'}>${label}</a>`;
        });
}

function uniqueSlug(text, taken) {
    const base = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-') || 'section';
    let slug = base;
    let n = 2;
    while (taken.has(slug)) { slug = `${base}-${n}`; n += 1; }
    taken.add(slug);
    return slug;
}

/* ── Journal et notifications ──────────────────────────────────────────────── */

function wireConsole() {
    const panel = $('[data-console]');
    for (const b of $$('[data-console-toggle]')) {
        b.addEventListener('click', () => (panel.hidden ? openConsole() : closeConsole()));
    }
    $('[data-console-close]').addEventListener('click', closeConsole);
}

/* Déclarations de fonction (et non des const) : `init()` s'exécute en haut du module. */
function openConsole() {
    $('[data-console]').hidden = false;
    for (const b of $$('[data-console-toggle]')) b.setAttribute('aria-expanded', 'true');
}

function closeConsole() {
    $('[data-console]').hidden = true;
    for (const b of $$('[data-console-toggle]')) b.setAttribute('aria-expanded', 'false');
}

function listenEvents() {
    const src = new EventSource('/api/events');
    const lines = $('[data-console-lines]');
    const task = $('[data-console-task]');
    const leds = () => $$('[data-led]');

    const add = (kind, text) => {
        const li = document.createElement('li');
        li.className = `k-${kind}`;
        li.textContent = text;
        lines.append(li);
        lines.scrollTop = lines.scrollHeight;
    };

    src.addEventListener('start', (e) => {
        const { task: name } = JSON.parse(e.data);
        state.busy = name;
        task.textContent = `${name}…`;
        for (const l of leds()) l.dataset.state = 'busy';
        add('title', name);
    });
    src.addEventListener('progress', (e) => {
        const { kind, text } = JSON.parse(e.data);
        add(kind, text);
    });
    src.addEventListener('done', (e) => {
        const { task: name } = JSON.parse(e.data);
        state.busy = null;
        task.textContent = `${name} — terminé`;
        for (const l of leds()) l.dataset.state = 'ok';
    });
    src.addEventListener('error', (e) => {
        if (!e.data) return;
        const { message } = JSON.parse(e.data);
        state.busy = null;
        for (const l of leds()) l.dataset.state = 'err';
        add('fail', message);
        toast(message, 'bad');
    });
}

function toast(message, tone) {
    const el = document.createElement('div');
    el.className = `toast${tone ? ` is-${tone}` : ''}`;
    el.innerHTML = message;
    $('[data-toasts]').append(el);
    setTimeout(() => el.remove(), 7000);
}

/* ── Fabriques de balisage ─────────────────────────────────────────────────── */

function tile(label, value, sub, { hero = false, tone = null, meter = null } = {}) {
    return `<div class="tile${hero ? ' tile-hero' : ''}">
        <div class="tile-label">${esc(label)}</div>
        <p class="tile-value${tone ? ` v-${tone}` : ''}">${value}</p>
        ${sub ? `<p class="tile-sub">${sub}</p>` : ''}
        ${meter != null ? `<div class="meter${tone ? ` is-${tone}` : ''}"><i style="width:${Math.min(100, meter)}%"></i></div>` : ''}
    </div>`;
}

function meterRow(label, value, sub, tone) {
    return `<p style="margin-bottom:.5rem">
        <span style="display:flex;justify-content:space-between;gap:.5rem">
            <span>${esc(label)}</span>
            <span style="font-family:var(--mono);color:var(--text-3)">${value} %<span style="margin-left:.4rem">${esc(sub || '')}</span></span>
        </span>
        <span class="meter${tone ? ` is-${tone}` : ''}" style="display:block"><i style="width:${Math.min(100, value)}%"></i></span>
    </p>`;
}

function barCell(value, max, label) {
    const w = max ? Math.max(2, (100 * value) / max) : 0;
    return `<span class="bar"><span class="bar-track"><i style="width:${w}%"></i></span><span class="bar-val">${esc(label)}</span></span>`;
}

/* `rowLink` rend la ligne entière cliquable : une liste dont seules quelques cellules réagissent
   oblige à viser, et on ne devine pas où. L'adresse est posée sur la ligne, `wireRowLinks` s'occupe
   du clic et du clavier. */
function dataTable(heads, rows, numeric = [], wrapClass = '', { rowLink = null } = {}) {
    const th = heads.map((h, n) => `<th class="${numeric[n] ? 'num' : ''}">${esc(h)}</th>`).join('');
    const tr = rows.map((r, i) => {
        const href = rowLink?.[i];
        const attrs = href ? ` class="is-link" data-row-link="${esc(href)}" tabindex="0" role="link"` : '';
        return `<tr${attrs}>${r.map((c, n) => {
            const cls = [numeric[n] ? 'num' : '', wrapClass === `wrap-${n}` ? 'wrap' : ''].filter(Boolean).join(' ');
            return `<td class="${cls}">${c}</td>`;
        }).join('')}</tr>`;
    }).join('');
    return `<div class="scroller"><table class="data"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

function wireRowLinks(host) {
    for (const tr of $$('[data-row-link]', host)) {
        const go = () => { location.hash = tr.dataset.rowLink.replace(/^#/, ''); };
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
    }
}

function callout(html, tone) {
    const ico = tone === 'bad' ? '!' : tone === 'good' ? '✓' : 'i';
    return `<div class="callout${tone ? ` is-${tone}` : ''}" style="margin-top:1rem">
        <span class="callout-ico">${ico}</span><span>${html}</span></div>`;
}

/* ── Utilitaires ───────────────────────────────────────────────────────────── */

async function api(url, opts) {
    const res = await fetch(url, opts);
    const body = await res.json().catch(() => ({ error: `Réponse illisible (HTTP ${res.status})` }));
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('fr-FR') : '—');
const pct = (x) => `${Math.round(x * 100)} %`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function when(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
