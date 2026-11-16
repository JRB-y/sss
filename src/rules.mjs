import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { log } from './util.mjs';

/* Les règles publiques (/fr/regles) sont rendues côté serveur : pas besoin de navigateur ni de
   connexion, un simple fetch suffit. Le balisage est régulier et stable —
   section.r-chapter > article.r-section > (p | ul.r-list | ol.r-steps | table.r-table | div.r-facts
   | p.r-note) — on le traduit donc bloc par bloc plutôt que de passer par un convertisseur
   générique qui perdrait les tableaux et les encadrés. */

const RULES_PATHS = {
    fr: '/fr/regles',
    en: '/en/rules',
    es: '/es/reglas',
    de: '/de/regeln',
    it: '/it/regole',
};

export async function exportRules({ locale = 'fr' } = {}) {
    const rulesPath = RULES_PATHS[locale];
    if (!rulesPath) throw new Error(`Langue inconnue : ${locale} (dispo : ${Object.keys(RULES_PATHS).join(', ')})`);

    const url = `${config.baseUrl}${rulesPath}`;
    log.info(`GET ${url}`);
    const res = await fetch(url, { headers: { 'Accept-Language': locale } });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const html = await res.text();

    const doc = parseRules(html, url);
    const markdown = renderMarkdown(doc, { url, locale });

    const file = path.join(config.paths.docs, locale === 'fr' ? 'regles.md' : `rules.${locale}.md`);
    await fs.mkdir(config.paths.docs, { recursive: true });
    await fs.writeFile(file, markdown, 'utf8');

    const sections = doc.chapters.reduce((n, c) => n + c.sections.length, 0);
    log.pass(`${doc.chapters.length} chapitres, ${sections} sections → ${path.relative(config.root, file)}`);
    return { file, chapters: doc.chapters.length, sections };
}

/* ---------- Lecture de la page ---------- */

function parseRules(html, url) {
    const title = textOf(match(html, /<h1[^>]*class="[^"]*rules-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/));
    const lead = textOf(match(html, /<p class="section-lead">([\s\S]*?)<\/p>/));
    const chapters = [];

    for (const chapterHtml of allBlocks(html, 'section', 'r-chapter')) {
        const id = attr(chapterHtml, 'id');
        const num = textOf(match(chapterHtml, /<p class="r-chapter-num">([\s\S]*?)<\/p>/));
        const chapterTitle = textOf(match(chapterHtml, /<h2[^>]*r-chapter-title[^>]*>([\s\S]*?)<\/h2>/));
        const chapterLead = textOf(match(chapterHtml, /<p class="r-chapter-lead">([\s\S]*?)<\/p>/));
        const sections = [];

        for (const sectionHtml of allBlocks(chapterHtml, 'article', 'r-section')) {
            // Le titre porte l'ancre « # » de copie de lien : on ne garde que le <span> du nom.
            const head = match(sectionHtml, /<h3[^>]*r-section-title[^>]*>([\s\S]*?)<\/h3>/) || '';
            sections.push({
                id: attr(sectionHtml, 'id'),
                title: textOf(match(head, /<span>([\s\S]*?)<\/span>/) || head),
                blocks: parseBlocks(sectionHtml.replace(/<h3[^>]*r-section-title[^>]*>[\s\S]*?<\/h3>/, '')),
            });
        }

        if (chapterTitle) chapters.push({ id, num, title: chapterTitle, lead: chapterLead, sections });
    }

    if (!chapters.length) throw new Error(`Aucun chapitre trouvé dans ${url} — le balisage a dû changer.`);
    return { title, lead, chapters };
}

/** Blocs d'une section, dans l'ordre d'apparition. */
function parseBlocks(html) {
    const blocks = [];
    const re = /<(p|ul|ol|table|div)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(html))) {
        const [, tag, attrs, inner] = m;
        const cls = (match(`<x${attrs}>`, /class="([^"]*)"/) || '').trim();

        if (tag === 'p' && cls.includes('r-note')) blocks.push({ type: 'note', text: inline(inner) });
        else if (tag === 'p' && !cls) blocks.push({ type: 'p', text: inline(inner) });
        else if (tag === 'ul' || tag === 'ol') {
            blocks.push({ type: tag === 'ol' ? 'steps' : 'list', items: listItems(inner) });
        } else if (tag === 'div' && cls.includes('r-table-wrap')) {
            const table = match(inner, /<table[^>]*>([\s\S]*?)<\/table>/);
            if (table) blocks.push({ type: 'table', ...parseTable(table) });
        } else if (tag === 'div' && cls.includes('r-facts')) {
            blocks.push({ type: 'facts', items: parseFacts(inner) });
        }
        // Les blocs imbriqués (table-wrap, r-facts) consomment leur contenu : la regex non
        // gourmande s'arrête à la première fermeture, d'où la relance de l'index.
        if (tag === 'div') re.lastIndex = m.index + m[0].length;
    }
    return blocks;
}

function parseTable(html) {
    const head = match(html, /<thead[^>]*>([\s\S]*?)<\/thead>/) || '';
    const body = match(html, /<tbody[^>]*>([\s\S]*?)<\/tbody>/) || html;
    const cells = (row) => [...row.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((c) => inline(c[2]));
    const rows = (block) => [...block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => cells(r[1]));
    const headRows = rows(head);
    return { head: headRows[0] || [], rows: rows(body) };
}

function parseFacts(html) {
    return [...html.matchAll(/<div class="r-fact">([\s\S]*?)<\/div>/g)].map((m) => ({
        value: textOf(match(m[1], /<b>([\s\S]*?)<\/b>/)),
        label: textOf(match(m[1], /<span>([\s\S]*?)<\/span>/)),
    }));
}

function listItems(html) {
    return [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => inline(m[1]));
}

/* ---------- Rendu Markdown ---------- */

function renderMarkdown(doc, { url, locale }) {
    const out = [];
    out.push(`# Sand Sea Sun — ${doc.title}`, '');
    if (doc.lead) out.push(`> ${doc.lead}`, '');
    out.push(`*Source : [${url}](${url}) — règles officielles (${locale.toUpperCase()}), copiées le ${today()}.*`, '');

    out.push('## Sommaire', '');
    for (const ch of doc.chapters) {
        out.push(`- **${ch.num} — [${ch.title}](#${slug(ch.title)})** — ${ch.lead}`);
        for (const s of ch.sections) out.push(`  - [${s.title}](#${slug(s.title)})`);
    }
    out.push('');

    for (const ch of doc.chapters) {
        out.push('---', '', `## ${ch.title}`, '');
        if (ch.lead) out.push(`*${ch.lead}*`, '');
        for (const s of ch.sections) {
            out.push(`### ${s.title}`, '');
            for (const b of s.blocks) out.push(...renderBlock(b), '');
        }
    }

    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function renderBlock(block) {
    switch (block.type) {
        case 'p': return [block.text];
        case 'note': return [`> 💡 ${block.text}`];
        case 'list': return block.items.map((i) => `- ${i}`);
        case 'steps': return block.items.map((i, n) => `${n + 1}. ${i}`);
        case 'facts': return [block.items.map((f) => `**${f.value}** ${f.label}`).join(' · ')];
        case 'table': return renderTable(block);
        default: return [];
    }
}

function renderTable({ head, rows }) {
    const width = Math.max(head.length, ...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];
    const line = (cells) => `| ${pad(cells).map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
    const header = head.length ? head : Array(width).fill('');
    return [line(header), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.map(line)];
}

/* ---------- Petits utilitaires HTML ---------- */

/** Tous les blocs `<tag class="…cls…">…</tag>` de même type, en comptant l'imbrication. */
function allBlocks(html, tag, cls) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, 'g');
    const found = [];
    let m;
    while ((m = open.exec(html))) {
        if (!m[0].includes(cls)) continue;
        const end = closingIndex(html, tag, m.index + m[0].length);
        if (end < 0) continue;
        found.push(html.slice(m.index, end));
        open.lastIndex = end;
    }
    return found;
}

/** Index de fin du bloc ouvert juste avant `from`, balises de même nom imbriquées comprises. */
function closingIndex(html, tag, from) {
    const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'g');
    re.lastIndex = from;
    let depth = 1;
    let m;
    while ((m = re.exec(html))) {
        depth += m[0].startsWith('</') ? -1 : 1;
        if (depth === 0) return m.index + m[0].length;
    }
    return -1;
}

function inline(html) {
    return decode(
        String(html)
            .replace(/<svg[\s\S]*?<\/svg>/g, '')
            .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/g, (_, __, t) => `**${t.trim()}**`)
            .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/g, (_, __, t) => `*${t.trim()}*`)
            .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/g, (_, t) => `\`${t.trim()}\``)
            .replace(/<br\s*\/?>/g, ' ')
            .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, t) => {
                const text = t.replace(/<[^>]+>/g, '').trim();
                if (!text) return '';
                const target = href.startsWith('http') ? href : `${config.baseUrl}${href}`;
                return `[${text}](${target})`;
            })
            .replace(/<[^>]+>/g, ''),
    ).replace(/\s+/g, ' ').replace(/\*\*\s+/g, '** ').trim();
}

function textOf(html) {
    return decode(String(html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decode(s) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', laquo: '«', raquo: '»', deg: '°', times: '×', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', rsquo: '’', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', middot: '·' };
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (full, name) => (name.toLowerCase() in named ? named[name.toLowerCase()] : full));
}

function match(html, re) {
    const m = re.exec(String(html || ''));
    return m ? m[1] : null;
}

function attr(html, name) {
    return match(html, new RegExp(`${name}="([^"]*)"`));
}

/** Ancre GitHub : minuscules, ponctuation retirée, espaces en tirets (accents conservés). */
function slug(title) {
    return title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

function today() {
    return new Date().toLocaleDateString('fr-CA'); // AAAA-MM-JJ, en heure locale
}
