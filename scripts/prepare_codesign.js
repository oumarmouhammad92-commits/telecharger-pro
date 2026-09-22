#!/usr/bin/env node
/**
 * Prépare l'outil « rcedit » d'electron-builder (cache winCodeSign) sans
 * droits administrateur.
 *
 * Pourquoi ce script ?
 * --------------------
 * Sur Windows, electron-builder grave l'icône et la version dans le .exe avec
 * `rcedit.exe`, livré dans l'archive `winCodeSign-2.6.0.7z`. Cette archive
 * contient DEUX liens symboliques macOS (`darwin/10.12/lib/libcrypto.dylib`
 * et `libssl.dylib`). Windows refuse de créer un lien symbolique sans le
 * privilège « SeCreateSymbolicLinkPrivilege » (administrateur ou mode
 * développeur) : l'extraction échoue alors 4 fois de suite et la
 * construction s'arrête.
 *
 * La parade : extraire nous-mêmes l'archive en excluant le dossier `darwin`
 * (inutile sous Windows) dans le dossier de cache que electron-builder
 * considère comme déjà valide — il suffit que ce dossier existe.
 * Résultat : l'installation fonctionne sur n'importe quel PC, sans droit
 * administrateur.
 *
 * Usage : node scripts/prepare_codesign.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const VERSION = '2.6.0';
const NAME = 'winCodeSign-' + VERSION;
const URL = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/'
  + NAME + '/' + NAME + '.7z';

function cacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'electron-builder', 'Cache');
}

function sevenZip() {
  // 7-Zip livré avec electron-builder : aucune installation requise.
  const root = path.resolve(__dirname, '..');
  const candidates = [
    path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(root, 'node_modules', '7zip-bin', 'win', 'ia32', '7za.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const fallback = spawnSync('7z', ['i'], { encoding: 'utf8' });
  return fallback.status === 0 ? '7z' : null;
}

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('trop de redirections'));
    https
      .get(url, { headers: { 'User-Agent': 'telecharger-pro' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(res.headers.location, dest, depth + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('  hors Windows : rien à préparer.');
    return 0;
  }

  const dir = path.join(cacheRoot(), 'winCodeSign');
  const target = path.join(dir, NAME);
  if (fs.existsSync(path.join(target, 'rcedit-x64.exe'))) {
    console.log('  rcedit déjà disponible (cache electron-builder).');
    return 0;
  }

  const tool = sevenZip();
  if (!tool) {
    console.log('  ⚠ 7-Zip introuvable : l’icône du .exe ne sera pas gravée.');
    return 0;
  }

  fs.mkdirSync(dir, { recursive: true });

  // Une archive peut déjà avoir été téléchargée par une tentative précédente.
  let archive = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.7z'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];

  if (!archive) {
    archive = path.join(dir, NAME + '.7z');
    try {
      console.log('  téléchargement de ' + NAME + '.7z…');
      await download(URL, archive);
    } catch (e) {
      console.log('  ⚠ téléchargement impossible (' + e.message + ') : l’icône du .exe ne sera pas gravée.');
      return 0;
    }
  }

  // Extraction en excluant `darwin` : évite le piège des liens symboliques.
  const extract = spawnSync(tool, ['x', archive, '-o' + target, '-x!darwin', '-bd', '-y'], {
    stdio: 'inherit',
  });
  if (extract.status !== 0 || !fs.existsSync(path.join(target, 'rcedit-x64.exe'))) {
    console.log('  ⚠ extraction impossible : l’icône du .exe ne sera pas gravée.');
    return 0;
  }

  // Nettoyage des archives intermédiaires (le dossier extrait suffit).
  for (const name of fs.readdirSync(dir)) {
    if (name.toLowerCase().endsWith('.7z')) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (e) {
        // sans conséquence
      }
    }
  }
  console.log('  rcedit prêt : ' + target);
  return 0;
}

main().then((code) => process.exit(code));
