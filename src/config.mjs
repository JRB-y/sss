import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
    root: ROOT,
    baseUrl: (process.env.SSS_BASE_URL || 'https://ssandsun.com').replace(/\/+$/, ''),
    email: process.env.SSS_EMAIL || '',
    password: process.env.SSS_PASSWORD || '',
    locale: process.env.SSS_LOCALE || 'en',
    headed: process.env.SSS_HEADED === '1',
    // Pause entre deux requêtes de détail : on reste poli avec le serveur du jeu.
    requestDelayMs: Number(process.env.SSS_DELAY_MS || 150),
    timeoutMs: Number(process.env.SSS_TIMEOUT_MS || 45000),
    paths: {
        data: path.join(ROOT, 'data'),
        out: path.join(ROOT, 'out'),
        fights: path.join(ROOT, 'data', 'fights.json'),
        raw: path.join(ROOT, 'data', 'raw'),
        state: path.join(ROOT, 'out', 'state.json'),
        report: path.join(ROOT, 'out', 'report.json'),
    },
};

export function assertCredentials() {
    if (!config.email || !config.password) {
        throw new Error(
            'Identifiants manquants : copie .env.example en .env et renseigne SSS_EMAIL / SSS_PASSWORD '
            + '(ou exporte-les dans ton shell).',
        );
    }
}
