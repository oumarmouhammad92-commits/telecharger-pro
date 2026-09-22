#!/usr/bin/env node
/**
 * Construction du logiciel installable (npm run dist).
 *
 * Enchainement, chaque etape etant optionnelle (un echec n'empeche pas la
 * construction de continuer, il produit seulement un avertissement) :
 *
 *   1. Icone          -> assets/icon.ico + assets/icon.png
 *   2. Python embarque-> python-embed/ (le logiciel fonctionne alors sur un PC
 *                        ou Python n'est pas installe)
 *   3. Outil rcedit   -> preparation du cache electron-builder (contourne le
 *                        probleme des liens symboliques Windows)
 *   4. Electron       -> release/Telechargeur-Pro-Setup-1.0.0.exe (installateur)
 *                        release/Telechargeur-Pro-Portable-1.0.0.exe (portable)
 *
 * Usage : npm run dist
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const IS_WINDOWS = process.platform === 'win32';

function step(titre, description) {
  console.log('');
  console.log('--- ' + titre + ' ---');
  console.log('  ' + description);
}

function run(command, args) {
  return spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
}

// 1. Icone -------------------------------------------------------------------
function ensureIcon() {
  const icon = path.join(ROOT, 'assets', 'icon.ico');
  if (fs.existsSync(icon)) {
    console.log("  icone deja presente (assets/icon.ico).");
    return;
  }

  step('Icone', "generation de l'icone de l'application");
  const generator = path.join(ROOT, 'scripts', 'make_icons.py');
  if (!fs.existsSync(generator)) {
    console.log('  /!\\ generateur introuvable : icone standard utilisee.');
    return;
  }

  // Python embarque s'il existe (aucun prerequis), sinon Python du systeme.
  const bundled = path.join(ROOT, 'python-embed', IS_WINDOWS ? 'python.exe' : 'bin/python3');
  const python = fs.existsSync(bundled) ? bundled : PYTHON;

  const result = run(python, [generator]);
  if (result.status !== 0 || !fs.existsSync(icon)) {
    console.log('  /!\\ icone non generee : icone standard utilisee.');
  }
}

// 2. Python embarque ---------------------------------------------------------
function ensureEmbeddedPython() {
  const target = path.join(ROOT, 'python-embed', IS_WINDOWS ? 'python.exe' : 'bin/python3');
  if (fs.existsSync(target)) {
    console.log('  Python embarque deja pret (python-embed/).');
    return;
  }

  step('Python embarque', 'le logiciel doit fonctionner sur un PC sans Python');
  const script = path.join(ROOT, 'scripts', 'fetch_python.js');
  if (!fs.existsSync(script)) {
    console.log('  /!\\ scripts/fetch_python.js introuvable : la version installee');
    console.log('      utilisera le Python du systeme (il devra etre installe).');
    return;
  }

  const result = run(process.execPath, [script]);
  if (result.status !== 0 || !fs.existsSync(target)) {
    console.log('  /!\\ Python embarque indisponible : la version installee utilisera');
    console.log('      le Python du systeme (il devra etre installe).');
  }
}

// 3. Outil rcedit (cache electron-builder) -----------------------------------
// electron-builder grave l'icone et le numero de version dans le .exe avec
// rcedit, livre dans l'archive « winCodeSign ». Cette archive contient deux
// liens symboliques macOS que Windows refuse de creer sans droit
// administrateur : sans preparation, la construction s'arrete. Le script
// prepare_codesign.js extrait l'archive en ignorant le dossier darwin, ce qui
// suffit et fonctionne sur n'importe quel PC.
function prepareCodeSign() {
  step('Outil rcedit', 'preparation du cache (sans droit administrateur)');
  const script = path.join(ROOT, 'scripts', 'prepare_codesign.js');
  if (!fs.existsSync(script)) {
    console.log('  /!\\ scripts/prepare_codesign.js introuvable.');
    return;
  }

  const result = run(process.execPath, [script]);
  if (result.status !== 0) {
    console.log("  /!\\ preparation incomplete : l'icone du .exe pourrait ne pas etre gravee.");
  }
}

// 4. Constructeur ------------------------------------------------------------
function build() {
  step('Construction', 'electron-builder (installateur NSIS + version portable)');
  // Les arguments supplémentaires sont transmis tels quels à electron-builder :
  // « npm run release » (--publish always) publie donc la version sur GitHub
  // après avoir préparé l'icône, le Python embarqué et l'outil rcedit.
  const extra = process.argv.slice(2);
  // electron-builder est appelé par son fichier CLI plutôt que par « npx » :
  // aucune dépendance à npx et pas d'avertissement DEP0190 sous Windows.
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (fs.existsSync(cli)) {
    const result = spawnSync(process.execPath, [cli].concat(extra), { stdio: 'inherit', cwd: ROOT });
    return result.status === 0;
  }

  console.log('  electron-builder absente : lancez « npm install » (repli sur npx).');
  const result = spawnSync(
    IS_WINDOWS ? 'npx.cmd' : 'npx',
    ['electron-builder'].concat(extra),
    { stdio: 'inherit', cwd: ROOT, shell: IS_WINDOWS }
  );
  return result.status === 0;
}

// --- Enchainement -----------------------------------------------------------
console.log('=== Construction de Telechargeur Pro ===');
ensureIcon();
ensureEmbeddedPython();
if (IS_WINDOWS) prepareCodeSign();

if (!build()) {
  console.error('Echec de la construction. Verifiez la configuration et les dependances.');
  process.exit(1);
}

console.log('');
console.log('=== Termine ===');
const output = path.join(ROOT, 'release');
if (fs.existsSync(output)) {
  const files = fs
    .readdirSync(output)
    .filter((name) => /\.(exe|AppImage|deb|dmg)$/i.test(name))
    .map((name) => ({ name, size: fs.statSync(path.join(output, name)).size / (1024 * 1024) }));
  for (const file of files) {
    console.log('  ' + file.name + '  (' + file.size.toFixed(1) + ' Mo)');
  }
  if (!files.length) {
    console.log('  (aucun fichier trouve dans release/)');
  }
}
