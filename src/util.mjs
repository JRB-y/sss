import fs from 'node:fs/promises';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function readJson(file, fallback = null) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return fallback;
        throw new Error(`JSON illisible (${file}) : ${e.message}`);
    }
}

/** Écriture atomique : un run interrompu ne laisse jamais un fichier de données tronqué. */
export async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
}

export async function writeText(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
}

/* ---------- Sortie console ---------- */
const c = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const paint = (code, s) => (process.stdout.isTTY ? `${code}${s}${c.reset}` : String(s));

export const log = {
    title: (s) => console.log(`\n${paint(c.bold, s)}`),
    info: (s) => console.log(`  ${paint(c.cyan, '›')} ${s}`),
    dim: (s) => console.log(`  ${paint(c.dim, s)}`),
    pass: (s) => console.log(`  ${paint(c.green, '✓')} ${s}`),
    fail: (s) => console.log(`  ${paint(c.red, '✗')} ${s}`),
    warn: (s) => console.log(`  ${paint(c.yellow, '!')} ${s}`),
};
