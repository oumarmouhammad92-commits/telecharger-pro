#!/usr/bin/env node
/**
 * Prépare un Python embarqué pour l'application installée.
 *
 * Objectif : le logiciel doit fonctionner sur n'importe quel PC, même sans
 * Python installé. On télécharge donc la distribution « embeddable » officielle
 * de python.org (environ 11 Mo) et on l'extrait dans `python-embed/`.
 * Ce dossier est embarqué dans l'installateur par electron-builder
 * (voir `extraResources` dans package.json).
 *
 * Le moteur n'utilise que la bibliothèque standard : aucune installation pip
 * n'est nécessaire.
 *
 * Usage : node scripts/fetch_python.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION = process.env.SDM_PYTHON_VERSION || '3.13.7';
const TARGET = path.join(ROOT, 'python-embed');
const VENDOR = path.join(ROOT, 'vendor');
const ARCHIVE = path.join(VENDOR, `python-${VERSION}-embed-amd64.zip`);
const URL = `https://www.python.org/ftp/python/${VERSION}/python-${VERSION}-embed-amd64.zip`;

function pythonExe(dir) {
  return process.platform === 'win32'
    ? path.join(dir, 'python.exe')
    : path.join(dir, 'bin', 'python3');
}

function isReady() {
  return fs.existsSync(pythonExe(TARGET));
}

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('Trop de redirections'));
    https
      .get(url, { headers: { 'User-Agent': 'telecharger-pro' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(res.headers.location, dest, depth + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' pour ' + url));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let lastPercent = -1;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const percent = Math.floor((received / total) * 100);
            if (percent >= lastPercent + 20) {
              lastPercent = percent;
              process.stdout.write('  téléchargement ' + percent + ' %\r');
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`],
      { stdio: 'inherit' }
    );
    if (ps.status === 0) return true;
  }
  const unzip = spawnSync('unzip', ['-o', archive, '-d', dest], { stdio: 'inherit' });
  if (unzip.status === 0) return true;
  const py = spawnSync('python3', ['-m', 'zipfile', '-e', archive, dest], { stdio: 'inherit' });
  return py.status === 0;
}

function report(message) {
  console.log('  ⚠ ' + message);
  console.log('  (L’application fonctionnera quand même : elle utilisera le Python du système.)');
}

async function main() {
  console.log('--- Python embarqué pour le PC cible ---');

  if (isReady() && !process.argv.includes('--force')) {
    console.log('  déjà présent : ' + path.relative(ROOT, pythonExe(TARGET)));
    return 0;
  }

  fs.mkdirSync(TARGET, { recursive: true });
  fs.mkdirSync(VENDOR, { recursive: true });

  try {
    if (!fs.existsSync(ARCHIVE) || fs.statSync(ARCHIVE).size < 1000000) {
      console.log('  source : ' + URL);
      await download(URL, ARCHIVE);
    } else {
      console.log('  archive déjà téléchargée : ' + path.relative(ROOT, ARCHIVE));
    }
  } catch (e) {
    report('téléchargement impossible (' + e.message + ')');
    return 0; // on continue la construction sans Python embarqué
  }

  const ok = extract(ARCHIVE, TARGET);
  if (!ok || !isReady()) {
    report('extraction impossible');
    return 0;
  }

  const probe = spawnSync(pythonExe(TARGET), ['-c', 'import ssl, urllib.request, http.server, json, threading; print("ssl", ssl.OPENSSL_VERSION)'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (probe.status === 0) {
    console.log('  moteur Python embarqué prêt : ' + path.relative(ROOT, pythonExe(TARGET)));
    console.log('  ' + (probe.stdout || '').trim());
  } else {
    report('le Python embarqué ne répond pas correctement');
    return 0;
  }
  return 0;
}

main().then((code) => process.exit(code));
