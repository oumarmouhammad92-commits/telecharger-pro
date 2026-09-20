const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

// Port du moteur Python : transmis par scripts/start.js (ou valeur par défaut).
const BACKEND_PORT = parseInt(process.env.SDM_BACKEND_PORT || '9898', 10);
// Quand scripts/start.js gère déjà le moteur, on n'en lance pas un second.
const EXTERNAL_BACKEND = process.env.SDM_EXTERNAL_BACKEND === '1';

// Détection du runtime Python
function findPython() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const probe = c === 'py' ? ['-3', '--version'] : ['--version'];
    try {
      const r = spawnSync(c, probe, { stdio: 'pipe', encoding: 'utf8', timeout: 8000 });
      if (r.status === 0) return { cmd: c, args: c === 'py' ? ['-3'] : [] };
    } catch (e) {
      // on essaie le candidat suivant
    }
  }
  return { cmd: 'python', args: [] };
}

// Chemin du moteur : dossier « python » embarqué (version installée) ou projet.
function backendPath() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'python', 'backend.py') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'python', 'backend.py');
}

let backendProcess = null;
let backendPort = BACKEND_PORT;

function backendHeaders() {
  return { 'Content-Type': 'application/json' };
}

function checkHealth(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function waitForBackend(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await checkHealth(port, 1500);
    if (health && health.ok) return health;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function startBackend() {
  if (EXTERNAL_BACKEND) {
    console.log('[main] moteur géré par scripts/start.js sur le port ' + backendPort);
    return;
  }
  const py = findPython();
  const script = backendPath();
  const env = Object.assign({}, process.env, { SDM_PORT: String(backendPort), PYTHONUNBUFFERED: '1' });
  // Application installée : on écrit dans les dossiers de l'utilisateur.
  if (app.isPackaged) {
    env.SDM_STATE_DIR = path.join(app.getPath('userData'), 'state');
    env.SDM_DOWNLOADS_DIR = path.join(app.getPath('downloads'), 'Téléchargeur Pro');
  }
  backendProcess = spawn(py.cmd, py.args.concat([script, String(backendPort)]), {
    stdio: 'pipe',
    shell: false,
    env,
    windowsHide: true,
  });
  backendProcess.on('error', (err) => {
    console.error('[main] backend error', err);
  });
  backendProcess.stdout.on('data', (data) => {
    console.log('[backend]', data.toString().trim());
  });
  backendProcess.stderr.on('data', (data) => {
    console.error('[backend]', data.toString().trim());
  });
}

function stopBackend() {
  const proc = backendProcess;
  backendProcess = null;
  if (!proc) return;
  // Arrêt propre : le moteur sauvegarde la progression avant de quitter.
  const req = http.request(
    { host: '127.0.0.1', port: backendPort, path: '/shutdown', method: 'POST', headers: backendHeaders(), timeout: 2500 },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
  try {
    proc.kill();
  } catch (e) {
    // déjà arrêté
  }
}

// Petit client HTTP pour le backend
function requestBackend(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: backendPort,
      path: path,
      method: method,
      headers: backendHeaders(),
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON: ' + data));
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

let mainWindow = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    frame: true,
    backgroundColor: '#0e0e12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(async () => {
  startBackend();
  // On attend que le moteur soit disponible avant d'afficher la liste.
  const health = await waitForBackend(backendPort, 20000);
  if (health) {
    console.log('[main] moteur prêt (v' + health.version + ') port ' + backendPort);
  } else {
    console.error('[main] moteur indisponible sur le port ' + backendPort);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPCs
ipcMain.handle('api/add-task', async (_, url, suggestedName) => {
  try {
    const res = await requestBackend('POST', '/tasks/add', { url, suggested_name: suggestedName });
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/tasks', async () => {
  try {
    const res = await requestBackend('GET', '/tasks');
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/task-status', async (_, taskId) => {
  try {
    const res = await requestBackend('GET', '/task/' + taskId);
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/start-task', async (_, taskId) => {
  try {
    const res = await requestBackend('POST', '/task/start', { task_id: taskId });
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/pause-task', async (_, taskId) => {
  try {
    const res = await requestBackend('POST', '/task/pause', { task_id: taskId });
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/stop-task', async (_, taskId) => {
  try {
    const res = await requestBackend('POST', '/task/stop', { task_id: taskId });
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/remove-task', async (_, taskId, deleteFile) => {
  try {
    const res = await requestBackend('POST', '/task/remove', { task_id: taskId, delete_file: deleteFile });
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/downloads-dir', async () => {
  try {
    const res = await requestBackend('GET', '/downloads');
    return res;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('api/open-folder', async () => {
  try {
    const res = await requestBackend('GET', '/downloads');
    if (res && res.downloads_dir) {
      shell.openPath(res.downloads_dir);
      return { ok: true };
    }
    return { ok: false };
  } catch (e) {
    return { ok: false };
  }
});

ipcMain.handle('api/open-url', async (_, url) => {
  shell.openExternal(url);
  return { ok: true };
});

// Ouvre le fichier téléchargé avec l'application par défaut du système.
ipcMain.handle('api/open-path', async (_, target) => {
  try {
    if (!target || !fs.existsSync(target)) return { ok: false, error: 'Fichier introuvable' };
    const err = await shell.openPath(target);
    return { ok: !err, error: err || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Affiche le fichier dans l'explorateur / le gestionnaire de fichiers.
ipcMain.handle('api/reveal-path', async (_, target) => {
  try {
    if (!target || !fs.existsSync(target)) return { ok: false, error: 'Fichier introuvable' };
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Quand la fenêtre est fermée mais l'app reste active, on keep backend up for tray-like behavior
// (simplifié ici : on ne quitte pas tant qu'une fenêtre est ouverte)
