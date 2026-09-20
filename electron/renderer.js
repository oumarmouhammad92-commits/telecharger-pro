const $ = (s) => document.querySelector(s);
const urlInput = $('#urlInput');
const addBtn = $('#addBtn');
const openFolderBtn = $('#openFolderBtn');
const taskList = $('#taskList');
const emptyState = $('#emptyState');
const statusText = $('#statusText');
const counters = $('#counters');

let tasksCache = [];
let running = true;
let poller = null;

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  let v = bytesPerSec;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).slice(0, 48);
  } catch (e) {
    return url.slice(0, 48);
  }
}

async function loadTasks() {
  try {
    const res = await api.tasks();
    if (Array.isArray(res)) tasksCache = res;
    else if (res && res.error) console.warn(res.error);
    else tasksCache = [];
  } catch (e) { console.warn(e); tasksCache = []; }
}

async function refreshTasks() {
  await loadTasks();
  renderTasks();
  counters.textContent = tasksCache.length + ' tâche' + (tasksCache.length > 1 ? 's' : '');
}

function renderTasks() {
  taskList.innerHTML = '';
  if (!tasksCache.length) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';
  for (const t of tasksCache) taskList.appendChild(taskRowEl(t));
}

function taskRowEl(t) {
  const row = document.createElement('div');
  row.className = 'task-row';
  row.dataset.taskId = t.task_id;

  const name = document.createElement('div');
  name.className = 'task-name';
  name.innerHTML = `<span>${escapeHtml(t.dest_path ? t.dest_path.split('\\').pop() : t.task_id)}</span><a href='#' data-open-url='${escapeHtml(t.url)}'>${escapeHtml(shortenUrl(t.url))}</a>`;

  const progress = document.createElement('div');
  progress.className = 'progress-cell';
  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = ((t.percent !== null ? t.percent : 0)) + '%';
  const percent = document.createElement('span');
  percent.className = 'percent';
  percent.textContent = (t.percent !== null ? t.percent : 0).toFixed(1) + '%';
  track.appendChild(fill);
  progress.appendChild(track);
  progress.appendChild(percent);

  const size = document.createElement('div');
  size.className = 'size-cell';
  size.textContent = (t.total_size ? formatSize(t.total_size) : '—') + ' / ' + (t.downloaded ? formatSize(t.downloaded) : '—');

  const speed = document.createElement('div');
  speed.className = 'speed-cell';
  speed.textContent = formatSpeed(t.speed || 0);

  const actions = document.createElement('div');
  actions.className = 'actions-cell';

  if (!t.finished) {
    if (!t.paused && !t.stopped) {
      const pauseBtn = document.createElement('button');
      pauseBtn.className = 'icon-btn';
      pauseBtn.textContent = '❚❚';
      pauseBtn.title = 'Pause';
      pauseBtn.addEventListener('click', () => api.pauseTask(t.task_id));
      actions.appendChild(pauseBtn);
    } else {
      const startBtn = document.createElement('button');
      startBtn.className = 'icon-btn';
      startBtn.textContent = '►';
      startBtn.title = 'Reprendre';
      startBtn.addEventListener('click', () => api.startTask(t.task_id));
      actions.appendChild(startBtn);
    }
    const stopBtn = document.createElement('button');
    stopBtn.className = 'icon-btn';
    stopBtn.textContent = '■';
    stopBtn.title = 'Arrêter';
    stopBtn.addEventListener('click', () => api.stopTask(t.task_id));
    actions.appendChild(stopBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Supprimer';
  removeBtn.addEventListener('click', () => {
    api.removeTask(t.task_id, !!t.finished).then(() => refreshTasks());
  });
  actions.appendChild(removeBtn);

  if (t.finished) {
    const openBtn = document.createElement('button');
    openBtn.className = 'icon-btn';
    openBtn.textContent = '📂';
    openBtn.title = 'Ouvrir le fichier';
    openBtn.addEventListener('click', () => {
      if (t.dest_path) shellOpen(t.dest_path);
    });
    actions.appendChild(openBtn);
  }

  row.appendChild(name);
  row.appendChild(progress);
  row.appendChild(size);
  row.appendChild(speed);
  row.appendChild(actions);
  return row;
}

function attachOpenUrlHandlers() {
  taskList.querySelectorAll('[data-open-url]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      api.openUrl(el.getAttribute('data-open-url'));
    });
  });
}

let prevSnapshot = new Map();
function computeSpeed(tasks) {
  const now = Date.now();
  const out = new Map();
  for (const t of tasks) {
    const prev = prevSnapshot.get(t.task_id);
    let speed = 0;
    if (prev) {
      const deltaBytes = (t.downloaded || 0) - prev.downloaded;
      const deltaMs = now - prev.ts;
      if (deltaMs > 0 && deltaBytes > 0) speed = (deltaBytes * 1000) / deltaMs;
    }
    out.set(t.task_id, Object.assign({}, t, { speed }));
  }
  prevSnapshot = new Map();
  for (const t of out.values()) prevSnapshot.set(t.task_id, { ts: now, downloaded: t.downloaded });
  return out;
}

async function poll() {
  if (!running) return;
  try {
    const res = await api.tasks();
    if (Array.isArray(res)) {
      const withSpeed = computeSpeed(res);
      tasksCache = Array.from(withSpeed.values());
      renderTasks();
      attachOpenUrlHandlers();
      counters.textContent = tasksCache.length + ' tâche' + (tasksCache.length > 1 ? 's' : '');
    } else {
      statusText.textContent = res && res.error ? 'Moteur indisponible : ' + res.error : 'Moteur indisponible';
    }
  } catch (e) { console.warn(e); }
}

async function addTask() {
  const url = urlInput.value.trim();
  if (!url) return;
  const suggested = url.split('/').filter(Boolean).pop();
  const res = await api.addTask(url, suggested || '');
  if (res && res.task_id) {
    urlInput.value = '';
    await refreshTasks();
    statusText.textContent = 'Tâche ajoutée';
  } else if (res && res.status === 'already_pending') {
    statusText.textContent = 'Cette URL est déjà en cours';
  } else {
    statusText.textContent = res && res.error ? 'Erreur: ' + res.error : 'Impossible d’ajouter';
  }
}

addBtn.addEventListener('click', addTask);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addTask();
});
openFolderBtn.addEventListener('click', async () => {
  await api.openFolder();
});

function shellOpen(filePath) {
  if (window.api && api.openPath) api.openPath(filePath);
}

async function resumePending() {
  await refreshTasks();
  const pending = tasksCache.filter((t) => !t.finished && !t.stopped && t.downloaded > 0);
  for (const t of pending) {
    try {
      await api.startTask(t.task_id);
    } catch (e) {
      console.warn(e);
    }
  }
}

async function init() {
  await refreshTasks();
  await resumePending();
  poller = setInterval(poll, 1500);
}

init().catch((e) => console.warn(e));

window.addEventListener('beforeunload', () => {
  running = false;
  if (poller) clearInterval(poller);
});
