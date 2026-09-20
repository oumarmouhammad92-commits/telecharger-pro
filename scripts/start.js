#!/usr/bin/env node
/**
 * Script de démarrage « Téléchargeur Pro ».
 *
 * Il lance EN MEME TEMPS :
 *   1. le moteur de téléchargement Python (backend.py) : multi-blocs, reprise,
 *      reprise automatique après coupure réseau / arrêt du PC ;
 *   2. l'interface graphique Electron.
 *
 * Le script choisit un port libre, attend que le moteur réponde sur /health,
 * transmet le port à l'interface, puis arrête proprement le moteur quand la
 * fenêtre est fermée (Ctrl+C fonctionne aussi).
 *
 * Usage :  npm start        (ou  node scripts/start.js [--port 9898] [--no-gui])
 */
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const portIndex = ARGS.indexOf('--port');
const FORCE_PORT = portIndex !== -1 ? parseInt(ARGS[portIndex + 1], 10) : 9898;
const NO_GUI = ARGS.includes('--no-gui');

function log(msg) {
  console.log('[start] ' + msg);
}

/** Trouve un port TCP libre sur 127.0.0.1 (évite le conflit si 9898 est pris). */
function findFreePort(start, tries) {
  const base = Number.isFinite(start) && start > 0 ? start : 9898;
  return new Promise((resolve, reject) => {
    let candidate = base;
    let remaining = tries;
    const attempt = () => {
      if (remaining <= 0) return reject(new Error('Aucun port libre à partir de ' + base));
      remaining -= 1;
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => {
        candidate += 1;
        attempt();
      });
      srv.listen(candidate, '127.0.0.1', () => {
        const free = candidate;
        srv.close(() => resolve(free));
      });
    };
    attempt();
  });
}

/** Vérifie la disponibilité du runtime Python. */
function findPython() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const cmd of candidates) {
    const probe = cmd === 'py' ? ['-3', '--version'] : ['--version'];
    const r = spawnSync(cmd, probe, { stdio: 'pipe', encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) {
      return { cmd, args: cmd === 'py' ? ['-3'] : [], version: (r.stdout || r.stderr || '').trim() };
    }
  }
  return null;
}

/** Attend que le backend réponde sur /health. */
function waitForBackend(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const ping = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(ping, 300);
      });
    };
    ping();
  });
}

/** Demande l'arrêt propre du moteur (sauvegarde de la progression). */
function shutdownBackend(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/shutdown', method: 'POST', headers: { 'Content-Length': 0 }, timeout: 3000 },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.on('error', () => resolve());
    req.end();
  });
}

function electronBinary() {
  try {
    return require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (e) {
    return null;
  }
}

async function main() {
  const python = findPython();
  if (!python) {
    console.error('[start] Python 3 est introuvable. Installez-le depuis https://www.python.org/downloads/');
    console.error("[start] (cochez « Add python.exe to PATH » pendant l'installation)");
    process.exitCode = 1;
    return;
  }
  log('Python détecté : ' + python.version);

  const port = await findFreePort(FORCE_PORT, 25);
  log('Port du moteur : ' + port);

  const backend = spawn(python.cmd, python.args.concat([backendPath(), String(port)]), {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env, { SDM_PORT: String(port), PYTHONUNBUFFERED: '1' }),
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('Arrêt du moteur (la progression est sauvegardée)...');
    await shutdownBackend(port);
    setTimeout(() => {
      if (backend && !backend.killed) backend.kill();
    }, 1500);
    setTimeout(() => process.exit(0), 3000);
  };

  backend.stdout.on('data', (d) => process.stdout.write('[moteur] ' + d.toString()));
  backend.stderr.on('data', (d) => process.stderr.write('[moteur] ' + d.toString()));
  backend.on('exit', (code) => {
    if (!stopping) log('Le moteur s\'est arrêté (code ' + code + ')');
  });

  const ready = await waitForBackend(port, 20000);
  if (ready) {
    log('Moteur prêt sur http://127.0.0.1:' + port);
  } else {
    console.error('[start] Le moteur ne répond pas sur http://127.0.0.1:' + port);
    console.error('[start] Vérifiez que Python 3.9+ est installé et que le port est libre.');
  }

  if (NO_GUI) {
    log('Mode --no-gui : moteur seul. Ctrl+C pour arrêter.');
    process.on('SIGINT', stop);
    return;
  }

  const electronExe = electronBinary();
  if (!electronExe) {
    console.error('[start] Electron n\'est pas installé. Lancez d\'abord :  npm install');
    await stop();
    process.exitCode = 1;
    return;
  }

  log('Ouverture de l\'interface graphique...');
  const gui = spawn(electronExe, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      SDM_BACKEND_PORT: String(port),
      SDM_EXTERNAL_BACKEND: '1',
    }),
    windowsHide: false,
  });

  gui.on('exit', () => {
    stop();
  });

  process.on('SIGINT', () => {
    if (gui && !gui.killed) gui.kill();
    stop();
  });
  process.on('SIGTERM', stop);
}

function backendPath() {
  return path.join(ROOT, 'python', 'backend.py');
}

main().catch((e) => {
  console.error('[start] Erreur : ' + e.message);
  process.exitCode = 1;
});
