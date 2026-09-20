#!/usr/bin/env python3
import json, os, sys, time, uuid, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.parse, urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
VERSION = '1.0.0'

def _ensure_dir(env_key, default):
    """Dossier de travail : surchargeable par variable d'environnement.

    Utile quand l'application est installée dans un dossier en lecture seule
    (Program Files) : l'interface passe alors un dossier utilisateur.
    """
    raw = os.environ.get(env_key)
    target = Path(raw).expanduser() if raw else Path(default)
    target.mkdir(parents=True, exist_ok=True)
    return target

STATE_DIR = _ensure_dir('SDM_STATE_DIR', ROOT / 'state')
DOWNLOADS_DIR = _ensure_dir('SDM_DOWNLOADS_DIR', ROOT / 'downloads')

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

STATE_PATH = STATE_DIR / 'tasks.json'
TASKS = []
SHUTDOWN = threading.Event()

class DownloadTask:
    def __init__(self, task_id, url, dest_path, total_size=None, started_at=None, downloaded=None, paused=False, stopped=False, finished=False, error=None, segments=None, **kwargs):
        self.task_id = task_id
        self.url = url
        self.dest_path = Path(dest_path)
        self.total_size = total_size
        self.started_at = started_at or time.time()
        self.downloaded = downloaded if downloaded is not None else 0
        self.paused = paused
        self.stopped = stopped
        self.finished = finished
        self.error = error
        self.segments = [tuple(s) for s in (segments or [])]
        self.worker_thread = None
        self._lock = threading.Lock()

    def add_segment(self, start, end):
        with self._lock:
            ns, ne = start, end
            merged = []
            for a, b in self.segments:
                if ns <= b + 1:
                    ns = min(ns, a); ne = max(ne, b)
                elif ne + 1 >= a:
                    ns = min(ns, a); ne = max(ne, b)
                else:
                    merged.append((a, b))
            merged.append((ns, ne))
            merged.sort()
            self.segments = merged

    def downloaded(self):
        with self._lock:
            return sum(e - s + 1 for s, e in self.segments)

    def snapshot(self):
        with self._lock:
            return {
                'task_id': self.task_id,
                'url': self.url,
                'dest_path': str(self.dest_path),
                'total_size': self.total_size,
                'downloaded': sum(e - s + 1 for s, e in self.segments),
                'started_at': self.started_at,
                'paused': self.paused,
                'stopped': self.stopped,
                'finished': self.finished,
                'error': self.error,
                'segments': list(self.segments),
            }

def load_state():
    if TASKS:
        return TASKS
    if not STATE_PATH.exists():
        return []
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        tasks = [DownloadTask(**t) for t in data]
        TASKS.extend(tasks)
        return TASKS
    except Exception as exc:
        print(f'[state] impossible de lire {STATE_PATH}: {exc}', flush=True)
        return []

def auto_resume():
    """Reprend automatiquement tout téléchargement inachevé au démarrage.

    L'état est écrit sur disque après chaque bloc : même si le PC est coupé
    pendant des mois, le fichier partiel et sa progression sont conservés.
    """
    resumed = 0
    for t in TASKS:
        if t.finished or t.stopped:
            continue
        t.paused = False
        t.error = None
        start_worker(t)
        resumed += 1
    if resumed:
        print(f'[state] reprise automatique de {resumed} téléchargement(s)', flush=True)
    return resumed

def save_state():
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump([t.snapshot() for t in TASKS], f, ensure_ascii=False, indent=2)

def build_filename(url, suggested=None):
    parsed = urllib.parse.urlparse(url)
    name = suggested
    if not name:
        path = parsed.path.strip('/')
        if path:
            name = Path(path).name
    if not name or '.' not in name:
        name = 'download_' + str(uuid.uuid4())[:8] + '.bin'
    name = ''.join(ch if ch.isalnum() or ch in '._- ' else '_' for ch in name)
    return name

def resolve_dest(url, suggested=None):
    base = build_filename(url, suggested)
    name = base
    i = 1
    while (DOWNLOADS_DIR / name).exists():
        stem, ext = os.path.splitext(base)
        name = f'{stem} ({i}){ext}'
        i += 1
    return DOWNLOADS_DIR / name

def http_head(url):
    req = urllib.request.Request(url, method='HEAD')
    req.add_header('User-Agent', USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            size = resp.headers.get('Content-Length')
            return int(size) if size else None
    except Exception:
        return None

def add_task(url, suggested=None, force_new=False):
    if not force_new:
        for t in TASKS:
            if t.url == url and not t.finished:
                return t.task_id, 'already_pending'
    total = http_head(url)
    dest = resolve_dest(url, suggested)
    task_id = str(uuid.uuid4())
    task = DownloadTask(task_id, url, dest, total_size=total)
    TASKS.append(task)
    save_state()
    start_worker(task)
    return task_id, 'ok'

def start_worker(task):
    if is_worker_alive(task):
        return
    print(f'[worker] start_worker called for {task.task_id}', flush=True)
    def worker():
        try:
            _download_task_worker(task)
        except Exception as exc:  # l'état doit toujours rester exploitable
            print(f'[worker] fatal error {task.task_id}: {exc}', flush=True)
            task.error = str(exc)
            save_state()
    t = threading.Thread(target=worker, daemon=True)
    task.worker_thread = t
    t.start()

def _download_task_worker(task):
    print(f'[worker] start {task.task_id}', flush=True)
    dest = task.dest_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = task.total_size or None

    # Securite : si le fichier partiel a disparu (dossier supprime) ou est plus
    # court que ce qu'annonce l'etat, les plages memorisees ne correspondent plus
    # au contenu du disque. On repart alors de zero au lieu de fabriquer un
    # fichier corrompu.
    size_on_disk = dest.stat().st_size if dest.exists() else 0
    if task.segments:
        last_byte = max(e for _s, e in task.segments)
        if size_on_disk <= last_byte:
            print(f'[worker] fichier partiel absent ou tronque '
                  f'({size_on_disk} <= {last_byte}) : reprise depuis zero {task.task_id}',
                  flush=True)
            with task._lock:
                task.segments = []

    covered_until = -1
    ranges_to_fetch = []
    for s, e in sorted(task.segments):
        if s > covered_until + 1 and covered_until + 1 < (total or 0):
            ranges_to_fetch.append((covered_until + 1, min(s - 1, total - 1)))
        covered_until = max(covered_until, e)
    if total is None:
        try:
            print(f'[worker] unknown size {task.task_id}', flush=True)
            req = urllib.request.Request(task.url, method='GET')
            req.add_header('User-Agent', USER_AGENT)
            with urllib.request.urlopen(req, timeout=60) as resp:
                pos = 0
                with open(dest, 'wb') as f:
                    chunk = resp.read(1024 * 256)
                    while chunk:
                        if task.paused or task.stopped:
                            break
                        f.write(chunk)
                        start = pos
                        pos += len(chunk)
                        task.add_segment(start, pos - 1)
                        save_state()
                        chunk = resp.read(1024 * 256)
            task.finished = True
        except Exception as e:
            print(f'[worker] error unknown size {task.task_id}: {e}', flush=True)
            task.error = str(e)
        task.paused = False
        save_state()
        return
    if covered_until < (total or 0) - 1:
        ranges_to_fetch.append((covered_until + 1, total - 1))
    print(f'[worker] ranges_to_fetch={ranges_to_fetch} {task.task_id}', flush=True)
    for start, end in ranges_to_fetch:
        if task.paused or task.stopped:
            break
        attempt = 0
        while attempt < 5:
            if task.paused or task.stopped:
                break
            try:
                print(f'[worker] fetching range {start}-{end} {task.task_id}', flush=True)
                req = urllib.request.Request(task.url, method='GET')
                req.add_header('User-Agent', USER_AGENT)
                req.add_header('Range', f'bytes={start}-{end}')
                with urllib.request.urlopen(req, timeout=60) as resp:
                    code = resp.status
                    if code == 206:
                        pos = start
                        with open(dest, 'ab') as f:
                            f.seek(start)
                            chunk = resp.read(1024 * 256)
                            while chunk:
                                if task.paused or task.stopped:
                                    break
                                f.write(chunk)
                                pos += len(chunk)
                                task.add_segment(pos - len(chunk), pos - 1)
                                save_state()
                                chunk = resp.read(1024 * 256)
                        task.add_segment(start, end)
                        save_state()
                        print(f'[worker] range done {start}-{end} {task.task_id}', flush=True)
                        # On sort de la boucle de tentatives pour traiter la plage
                        # suivante : le `return` d'origine sautait la verification
                        # finale qui pose `finished = True` (tache jamais marquee
                        # terminee quand une seule plage restait a telecharger).
                        break
                    else:
                        print(f'[worker] server returned {code}, fallback single pass {task.task_id}', flush=True)
                        _download_simple(task, dest, total)
                        return
            except Exception as e:
                attempt += 1
                print(f'[worker] attempt {attempt} error {e} {task.task_id}', flush=True)
                if attempt >= 5:
                    task.error = str(e)
                    save_state()
                    return
                time.sleep(min(2 ** attempt, 15))
    print(f'[worker] finished range loop {task.task_id}', flush=True)
    task.paused = False
    # Un fichier alloue par seek peut avoir la bonne taille sans etre complet :
    # on verifie donc que les plages conservees couvrent bien tout le contenu.
    covered = 0
    for s, e in task.segments:
        covered += max(0, e - s + 1)
    total = task.total_size or 0
    size_on_disk = dest.stat().st_size if dest.exists() else 0
    if total and size_on_disk >= total and covered >= total:
        task.finished = True
        task.error = None
    save_state()
    print(f'[worker] finished {task.task_id} downloaded={size_on_disk} '
          f'covered={covered}/{total} finished={task.finished}', flush=True)

def _download_simple(task, dest, total):
    try:
        print(f'[worker] simple download start {task.task_id}', flush=True)
        # Le mode simple repart du début : on repart d'une progression propre
        # (le serveur ne gère pas les requêtes Range, aucune reprise partielle possible).
        with task._lock:
            task.segments = []
        req = urllib.request.Request(task.url, method='GET')
        req.add_header('User-Agent', USER_AGENT)
        with urllib.request.urlopen(req, timeout=120) as resp:
            pos = 0
            with open(dest, 'wb') as f:
                chunk = resp.read(1024 * 256)
                while chunk:
                    if task.paused or task.stopped:
                        break
                    f.write(chunk)
                    start = pos
                    pos += len(chunk)
                    task.add_segment(start, pos - 1)
                    save_state()
                    chunk = resp.read(1024 * 256)
        print(f'[worker] simple download done {task.task_id}', flush=True)
        if task.total_size and dest.exists() and dest.stat().st_size >= task.total_size:
            task.finished = True
        save_state()
    except Exception as e:
        print(f'[worker] simple download error {task.task_id}: {e}', flush=True)
        task.error = str(e)
        save_state()

def is_worker_alive(task):
    th = getattr(task, 'worker_thread', None)
    return bool(th and th.is_alive())

def start_task(task_id):
    for t in TASKS:
        if t.task_id == task_id:
            if t.finished:
                return False
            # Une reprise doit relancer le téléchargement si le worker est arrêté
            # (pause, perte de réseau, fermeture de l'application...).
            was_idle = bool(t.paused or t.stopped or t.error) or not is_worker_alive(t)
            t.paused = False
            t.stopped = False
            t.error = None
            save_state()
            if was_idle and not is_worker_alive(t):
                start_worker(t)
            return True
    return False

def pause_task(task_id):
    for t in TASKS:
        if t.task_id == task_id:
            t.paused = True
            break
    save_state()

def stop_task(task_id):
    for t in TASKS:
        if t.task_id == task_id:
            t.stopped = True
            t.paused = False
            break
    save_state()

def remove_task(task_id, delete_file=False):
    global TASKS
    new = []
    for t in TASKS:
        if t.task_id == task_id:
            if delete_file and t.dest_path.exists():
                try:
                    t.dest_path.unlink()
                except Exception:
                    pass
        else:
            new.append(t)
    TASKS = new
    save_state()

def clear_all_state():
    if STATE_PATH.exists():
        STATE_PATH.unlink()
    for p in DOWNLOADS_DIR.iterdir():
        try:
            p.unlink()
        except Exception:
            pass
    TASKS.clear()

def find_task(task_id):
    for t in TASKS:
        if t.task_id == task_id:
            return t
    return None

def list_tasks_status():
    out = []
    for t in TASKS:
        s = t.snapshot()
        s['percent'] = None
        if t.total_size and t.total_size > 0:
            d = s['downloaded']
            s['percent'] = round(100.0 * d / t.total_size, 2)
        out.append(s)
    return out

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/tasks':
            self._json(list_tasks_status())
        elif p in ('/health', '/'):
            self._json({'ok': True, 'service': 'telecharger-pro', 'version': VERSION,
                        'tasks': len(TASKS), 'port': getattr(self.server, 'server_port', None),
                        'downloads_dir': str(DOWNLOADS_DIR)})
        elif p.startswith('/task/'):
            t = find_task(p.split('/')[-1])
            if not t:
                self._json({'error': 'not found'}, 404)
            else:
                self._json(t.snapshot())
        elif p == '/downloads':
            self._json({'downloads_dir': str(DOWNLOADS_DIR)})
        elif p == '/debug':
            import os as _os
            self._json({'state_path': str(STATE_PATH), 'cwd': _os.getcwd(), 'exists': STATE_PATH.exists(), 'tasks_count': len(TASKS)})
        else:
            self._json({'error': 'unknown'}, 404)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            data = {}
        p = self.path.split('?')[0]
        if p == '/tasks/add':
            tid, st = add_task(data.get('url'), data.get('suggested_name'))
            task = find_task(tid)
            self._json({'task_id': tid, 'status': st,
                        'dest_path': str(task.dest_path) if task else None})
        elif p == '/task/start':
            self._json({'ok': start_task(data.get('task_id'))})
        elif p == '/task/pause':
            pause_task(data.get('task_id'))
            self._json({'ok': True})
        elif p == '/task/stop':
            stop_task(data.get('task_id'))
            self._json({'ok': True})
        elif p == '/task/remove':
            remove_task(data.get('task_id'), delete_file=data.get('delete_file', False))
            self._json({'ok': True})
        elif p == '/clear':
            clear_all_state()
            self._json({'ok': True})
        elif p == '/resume-all':
            self._json({'ok': True, 'resumed': auto_resume()})
        elif p == '/shutdown':
            save_state()
            self._json({'ok': True})
            SHUTDOWN.set()
        else:
            self._json({'error': 'unknown'}, 404)

    def log_message(self, format, *args):
        pass

    def _json(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

def run_server(port=9898):
    """Démarre le serveur local ; si le port est occupé on essaie les suivants."""
    last_error = None
    for candidate in range(port, port + 20):
        try:
            server = HTTPServer(('127.0.0.1', candidate), Handler)
        except OSError as exc:
            last_error = exc
            continue
        print(f'[python] Backend listening on http://127.0.0.1:{candidate}', flush=True)
        print(f'[python] PORT={candidate}', flush=True)
        def worker():
            server.serve_forever()
        t = threading.Thread(target=worker, daemon=True)
        t.start()
        return server, candidate
    raise SystemExit(f'[python] Aucun port disponible entre {port} et {port + 19} ({last_error})')

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('SDM_PORT', '9898'))
    load_state()
    server, port = run_server(port)
    auto_resume()
    try:
        while not SHUTDOWN.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for t in TASKS:
            if not t.finished:
                t.paused = True
        save_state()
        server.shutdown()
        print('[python] Backend arrêté proprement', flush=True)
        sys.stdout.flush()
        os._exit(0)
