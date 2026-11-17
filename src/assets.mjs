import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { log, readJson, writeJson, sleep } from './util.mjs';
import { ROSTER } from './troops.mjs';

/* Images du jeu, copiées en local pour que l'interface s'affiche sans dépendre du site.

   Tout est servi en clair, sans session : vérifié sur les portraits, les vignettes, les avatars
   et le sprite d'icônes. Aucun navigateur n'est donc nécessaire ici — un `fetch` suffit, comme
   pour les règles publiques.

   Quatre familles :
   — `units/<clé>.webp`       le portrait entier d'un type, pour une fiche ;
   — `units/face/<clé>.webp`  la vignette, pour une ligne de tableau ;
   — `avatars/<fichier>.webp` la photo de profil d'un joueur. Le nom porte un condensat : quand
     quelqu'un change d'avatar, c'est un nouveau fichier, donc rien à invalider ;
   — `icons.svg`              le sprite complet. Les 30 icônes d'objets y sont des `<symbol>`
     monochromes (`fill="currentColor"`), ce qui permet de les teinter par rareté en CSS plutôt
     que de télécharger 30 fichiers.

   Le téléchargement est incrémental comme le reste : un fichier déjà sur le disque n'est pas
   redemandé. `--force` reprend tout. */

const STORE_VERSION = 1;
const CONCURRENCY = 4;

export async function syncAssets({ force = false } = {}) {
    log.title('Images du jeu');

    const manifest = (await readJson(config.paths.assetsManifest)) || { version: STORE_VERSION, files: {} };
    if (!manifest.files) manifest.files = {};

    const targets = await collectTargets();
    log.info(`${targets.length} image(s) repérée(s) : ${summarize(targets)}`);

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    const queue = [...targets];
    const worker = async () => {
        while (queue.length) {
            const target = queue.shift();
            const dest = path.join(config.paths.assets, target.file);
            if (!force && await exists(dest)) { skipped += 1; continue; }
            try {
                const bytes = await download(target.url, dest);
                manifest.files[target.file] = {
                    url: target.url, kind: target.kind, bytes, fetchedAt: new Date().toISOString(),
                };
                downloaded += 1;
            } catch (e) {
                failed += 1;
                log.warn(`${target.file} : ${e.message}`);
            }
            await sleep(config.requestDelayMs);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    manifest.version = STORE_VERSION;
    manifest.updatedAt = new Date().toISOString();
    manifest.counts = countKinds(manifest.files);
    await writeJson(config.paths.assetsManifest, manifest);

    const total = Object.keys(manifest.files).length;
    log.pass(`${downloaded} téléchargée(s), ${skipped} déjà présente(s)${failed ? `, ${failed} en échec` : ''}`);
    log.pass(`${total} image(s) en local → ${rel(config.paths.assets)}`);
    log.dim(`répartition : ${Object.entries(manifest.counts).map(([k, n]) => `${k} ${n}`).join(' · ')}`);

    return { downloaded, skipped, failed, total, counts: manifest.counts };
}

/* ---------- Ce qu'il faut aller chercher ---------- */

async function collectTargets() {
    const seen = new Map(); // fichier local → cible (dédoublonne les URLs versionnées)
    const add = (url, file, kind) => {
        if (!url || seen.has(file)) return;
        seen.set(file, { url: absolute(url), file, kind });
    };

    // Le sprite : une seule requête pour les 30 icônes d'objets.
    add('/assets/images/icons.svg', 'icons.svg', 'sprite');

    /* Les 21 types, portraits et vignettes. On passe par ROSTER plutôt que par les cartes
       relevées : les types encore verrouillés ont déjà leurs images sur le serveur, autant les
       avoir d'avance pour que l'interface ne se troue pas en montant de niveau. */
    for (const r of ROSTER) {
        add(`/assets/images/units/${r.key}.webp`, `units/${r.key}.webp`, 'portrait');
        add(`/assets/images/units/face/${r.key}.webp`, `units/face/${r.key}.webp`, 'vignette');
    }

    // Les filles et les narcos relevées, qui ne sont pas dans ROSTER.
    const troops = await readJson(config.paths.troops);
    for (const u of Object.values(troops?.units || {})) {
        if (!u.image) continue;
        const name = basename(u.image);
        add(u.image, `units/${name}`, 'portrait');
    }

    /* Bâtiments et ressources : les sprites dépendent du niveau (`gym-2`), donc on prend ceux
       posés dans la ville plus le niveau 1 de chaque type, pour avoir toujours une image. */
    const hq = await readJson(config.paths.hq);
    for (const b of hq?.buildings || []) {
        add(`/assets/images/buildings/${b.sprite}.webp`, `buildings/${b.sprite}.webp`, 'bâtiment');
        add(`/assets/images/buildings/${b.type}.webp`, `buildings/${b.type}.webp`, 'bâtiment');
    }
    for (const r of hq?.resources || []) {
        add(`/assets/images/res/${r.icon}.webp`, `res/${r.icon}.webp`, 'ressource');
    }

    // Les avatars de tous les joueurs croisés, moi compris.
    const enemies = await readJson(config.paths.enemies);
    for (const p of Object.values(enemies?.players || {})) {
        if (!p.avatar) continue;
        add(p.avatar, `avatars/${basename(p.avatar)}`, 'avatar');
    }

    /* Les rapports de combat portent aussi des avatars — y compris ceux de joueurs dont la fiche
       a changé de photo depuis. On les prend, c'est l'archive qui parle. */
    const fights = await readJson(config.paths.fights);
    for (const entry of Object.values(fights?.fights || {})) {
        const report = entry.detail?.fight?.report;
        if (!report) continue;
        for (const side of ['att', 'def']) {
            if (report[side]?.avatar) add(report[side].avatar, `avatars/${basename(report[side].avatar)}`, 'avatar');
            for (const pile of report[side].piles || []) {
                if (pile.img) add(pile.img, `units/face/${basename(pile.img)}`, 'vignette');
            }
        }
    }

    return [...seen.values()];
}

/* ---------- Téléchargement ---------- */

async function download(url, dest) {
    const res = await fetch(url, { headers: { Accept: 'image/webp,image/*,image/svg+xml,*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length) throw new Error('réponse vide');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // Écriture atomique : une image à moitié écrite serait pire qu'une image absente.
    const tmp = `${dest}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, dest);
    return body.length;
}

/* ---------- Utilitaires ---------- */

/** « /assets/images/units/face/bandit.webp?v=179… » → « bandit.webp » */
function basename(url) {
    return String(url).split('?')[0].split('/').filter(Boolean).pop() || 'inconnu';
}

const absolute = (url) => (/^https?:/i.test(url) ? url : `${config.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`);

async function exists(file) {
    try {
        const st = await fs.stat(file);
        return st.size > 0;
    } catch (e) {
        return false;
    }
}

function countKinds(files) {
    const out = {};
    for (const f of Object.values(files)) out[f.kind] = (out[f.kind] || 0) + 1;
    return out;
}

function summarize(targets) {
    const out = {};
    for (const t of targets) out[t.kind] = (out[t.kind] || 0) + 1;
    return Object.entries(out).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ');
}

const rel = (p) => p.replace(`${config.root}/`, '');
