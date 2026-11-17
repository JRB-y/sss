/* Interface du poste de commandement.
   Le serveur local sert les données ; cette page ne fait que lire, afficher et déclencher.
   Le rendu Markdown est fait maison : les documents sont générés par ce dépôt, on connaît donc
   exactement le sous-ensemble utilisé (titres, listes, tableaux, citations, gras, liens, code). */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { analysis: null, backtest: null, compos: null, docs: {}, busy: null };

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

function wireNav() {
    addEventListener('hashchange', () => show(location.hash.slice(1) || 'tableau'));
}

const VIEWS = {
    tableau: { title: 'Tableau de bord' },
    regles: { title: 'Les règles', doc: 'regles.md' },
    troupes: { title: 'Les troupes', doc: 'troupes.md' },
    analyse: { title: 'Analyse des combats' },
    compos: { title: 'Compositions' },
};

async function show(name) {
    const view = VIEWS[name] ? name : 'tableau';
    for (const el of $$('.view')) el.hidden = el.id !== `view-${view}`;
    for (const a of $$('.nav a')) {
        if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
    document.title = `SSS — ${VIEWS[view].title}`;
    if (VIEWS[view].doc) await openDoc(view, VIEWS[view].doc);
    if (view === 'analyse' && !state.analysis) await runAnalyse({ silent: true });
    if (view === 'compos' && !state.compos) renderCompos();
    scrollTo({ top: 0, behavior: 'instant' });
}

/* ── Actions ───────────────────────────────────────────────────────────────── */

function wireActions() {
    for (const btn of $$('[data-action]')) {
        btn.addEventListener('click', () => act(btn.dataset.action, btn));
    }
}

async function act(action, btn) {
    const jobs = {
        'fetch-fights': () => post('fetch-fights'),
        'fetch-fights-refresh': () => post('fetch-fights?refresh=1'),
        'fetch-troops': () => post('fetch-troops'),
        'fetch-rules': () => post('fetch-rules?locale=fr'),
        analyse: () => runAnalyse(),
        compos: () => runCompos(),
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
    state.docs = {};
    toast(summarise(route, res.result), 'good');
    return res;
}

function summarise(route, result) {
    if (route.startsWith('fetch-fights')) {
        const n = result?.downloaded;
        if (!n) return `Rien de neuf : les ${result?.listed ?? '?'} combats de la fenêtre sont déjà en base.`;
        return `${n} combat(s) téléchargé(s) · ${result.total} en base.`;
    }
    if (route.startsWith('fetch-troops')) return `${result?.units ?? '?'} unités relevées.`;
    if (route.startsWith('fetch-rules')) return `Règles régénérées (${result?.sections ?? '?'} sections).`;
    return 'Terminé.';
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
    renderDashSummary();
    return s;
}

function renderDashSummary() {
    const s = state.server;
    const box = $('#dash-summary');
    if (!s) return;
    const warn = [];
    if (!s.fights.count) warn.push('Aucun combat en base : commence par <strong>Récupérer les combats</strong>.');
    if (!s.troops.detailed) warn.push('Aucune fiche de troupe : lance <strong>Relever les troupes</strong>.');
    if (!s.docs.length) warn.push('Aucun document : lance <strong>Régénérer les règles</strong>.');

    box.innerHTML = `
        <h2 class="block">En base</h2>
        <div class="tiles">
            ${tile('Combats archivés', s.fights.count, s.fights.counts
        ? `${s.fights.counts.sent ?? 0} envoyés · ${s.fights.counts.received ?? 0} reçus`
        : 'le jeu n’expose qu’une fenêtre récente')}
            ${tile('Fiches de troupes', `${s.troops.detailed}<small>/ ${s.troops.count}</small>`, 'chiffrées / relevées')}
            ${tile('Seuil de capacité', s.crew?.abilityNeed ?? '—', '10 % de tes places de troupes')}
            ${tile('Documents', s.docs.length, s.docs.map((d) => d.name).join(' · ') || '—')}
        </div>
        ${warn.length ? `<div class="stack" style="margin-top:1rem">${warn.map((w) => callout(w, 'bad')).join('')}</div>` : ''}`;
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
        ['Type', 'Rôle', 'Capacité', 'Combats', 'Qté méd.', 'Part des dégâts', 'Dégâts / unité', 'Subis / unité', 'Échange', 'Cap. active'],
        a.myTypes.map((t) => [
            `<strong>${esc(t.fr)}</strong>`,
            `<span class="chip chip-role">${esc(t.roleFr)}</span>`,
            esc(t.abilityFr || '—'),
            num(t.fights),
            num(t.qtyMedian),
            barCell(t.damageShare, Math.max(...a.myTypes.map((x) => x.damageShare)), `${t.damageShare} %`),
            num(t.dealtPerUnit),
            num(t.takenPerUnit),
            `<span class="${t.trade >= 1 ? 'v-good' : 'v-bad'}">${t.trade}</span>`,
            t.abilityFireRate >= 99 ? '<span class="chip chip-on">✓ 100 %</span>'
                : `<span class="chip chip-off">${t.abilityFireRate} %</span>`,
        ]),
        [0, 0, 0, 1, 1, 0, 1, 1, 1, 0],
    )}
        <p class="note"><strong>Échange</strong> = dégâts infligés ÷ dégâts subis par ce type. Au-dessus de 1, il rend
            plus qu’il ne prend. <strong>Dégâts / unité</strong> cumule tout l’historique : un type souvent engagé en
            petit nombre et balayé tôt y paraît faible même s’il frappe fort.</p>

        <h2 class="block">Le vivier que tu affrontes</h2>
        <p class="note">C’est contre ces armées-là qu’une composition doit gagner — pas contre une cible théorique.
            Écart de niveau médian : ${a.opponents.levelGap >= 0 ? '+' : ''}${a.opponents.levelGap}.
            Fortification médiane en face : ${a.opponents.fortMedian ?? 0} % de dégâts en moins quand tu attaques.</p>
        ${dataTable(
        ['Type adverse', 'Rôle', 'Capacité', 'Rencontré', 'Qté méd.', 'PV / unité', 'Dégâts / coup', 'Renforts'],
        a.opponents.pool.map((o) => [
            `<strong>${esc(o.key)}</strong>`,
            `<span class="chip chip-role">${esc(o.roleFr)}</span>`,
            esc(o.abilityFr || '—'),
            barCell(o.fights, Math.max(...a.opponents.pool.map((x) => x.fights)), `${o.fights} piles`),
            num(o.qtyMedian),
            num(o.unitHpMedian),
            num(o.dpuPerHit),
            o.reinforcements ? num(o.reinforcements) : '—',
        ]),
        [0, 0, 0, 0, 1, 1, 1, 1],
    )}

        ${bt ? backtestCard(bt) : ''}

        <h2 class="block">Ce que l’historique dit du moteur</h2>
        <div class="cards">
            ${[
        ['Formule de dégâts', a.mechanics.damageFormula],
        ['Triangle des rôles', a.mechanics.roleEffectOnDamage],
        ['Choix de la cible', a.mechanics.targeting],
        ['Durée d’un combat', `${a.mechanics.medianFightSeconds} s en médiane (le temps est compté en centièmes de seconde)`],
    ].map(([h, p]) => `<div class="card"><h3>${esc(h)}</h3><p>${p}</p></div>`).join('')}
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

        <h2 class="block">Les ${a.fights.length} combats</h2>
        ${dataTable(
        ['Quand', 'Rôle', 'Issue', 'Adversaire', 'Niv.', 'Points', 'Ma compo', 'Mes PV au départ', 'Capacités actives'],
        a.fights.map((f) => [
            `<span style="color:var(--text-3)">${esc(when(f.at))}</span>`,
            esc(f.role),
            f.won ? '<span class="chip chip-on">Victoire</span>' : '<span class="chip chip-off">Défaite</span>',
            esc(f.opponent.name),
            num(f.opponent.level),
            `<span class="${f.delta >= 0 ? 'v-good' : 'v-bad'}">${f.delta >= 0 ? '+' : ''}${f.delta}</span>`,
            f.myPiles.filter((p) => !p.reinforcement).map((p) => `${esc(p.base)}&nbsp;×${p.qty}`).join(', '),
            pct(f.myPiles.reduce((s, p) => s + p.hp, 0) / (f.myPiles.reduce((s, p) => s + p.max, 0) || 1)),
            f.abOn.length ? f.abOn.length : '<span class="v-bad">0</span>',
        ]),
        [0, 0, 0, 0, 1, 1, 0, 1, 1],
        'wrap-6',
    )}`;
}

function readiness(a) {
    const xs = a.fights.filter((f) => f.role === 'défense')
        .map((f) => f.myPiles.reduce((s, p) => s + p.hp, 0) / (f.myPiles.reduce((s, p) => s + p.max, 0) || 1))
        .sort((x, y) => x - y);
    return xs.length ? xs[xs.length >> 1] : 1;
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
                    (1 = parfait, 0,5 = hasard).</p>
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

/* ── Compositions ──────────────────────────────────────────────────────────── */

async function runCompos() {
    const s = state.server;
    const slots = $('#f-slots')?.value || s?.crew?.slots || '';
    const types = $('#f-types')?.value || s?.crew?.typeSlots || '';
    const ready = $('#f-ready')?.value;
    const q = new URLSearchParams();
    if (slots) q.set('slots', slots);
    if (types) q.set('types', types);
    if (ready) q.set('readiness', String(Number(ready) / 100));
    const res = await api(`/api/compos?${q}`);
    if (res.empty) {
        $('#compos-body').innerHTML = callout(res.reason, 'bad');
        location.hash = 'compos';
        return;
    }
    state.compos = res;
    renderCompos();
    location.hash = 'compos';
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
                <h3>Ce qui n’est pas modélisé</h3>
                <p>Les renforts de famille, les objets que tu pourrais forger, les capacités adverses mal
                    documentées (coup de grâce, corruption) et la dispersion des tirages de dégâts. Le simulateur
                    calcule des espérances : deux compositions se comparent sans bruit, mais un combat réel
                    garde sa part de hasard.</p>
            </div>
        </div>`;
    wireControls();
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
                        <b>${esc(t.fr)}</b><span class="qty">×${num(t.qty)}</span>
                        <span class="ab">${t.abilityOn ? esc(t.abilityFr || '') : 'capacité éteinte'}</span>
                    </span>`).join('')}
            </div>
            <div class="compo-score">
                <b class="${b.wins / b.fights >= 0.5 ? 'v-good' : 'v-bad'}">${b.wins}/${b.fights}</b>
                <span>${b.winRate} % des combats archivés</span>
            </div>
            <div class="compo-meta">
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

function dataTable(heads, rows, numeric = [], wrapClass = '') {
    const th = heads.map((h, n) => `<th class="${numeric[n] ? 'num' : ''}">${esc(h)}</th>`).join('');
    const tr = rows.map((r) => `<tr>${r.map((c, n) => {
        const cls = [numeric[n] ? 'num' : '', wrapClass === `wrap-${n}` ? 'wrap' : ''].filter(Boolean).join(' ');
        return `<td class="${cls}">${c}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="scroller"><table class="data"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
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

function when(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
