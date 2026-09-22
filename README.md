# Téléchargeur Pro

Un petit gestionnaire de téléchargements **inspiré d'IDM (Internet Download Manager)**, avec une interface graphique légère et un moteur de téléchargement multi-blocs écrit en Python.

> **Point clé : la reprise.** Toute la progression est écrite sur disque après chaque bloc de données.
> Si le réseau tombe, si l'application est fermée, si le PC s'éteint ou plante, le téléchargement
> reprend exactement où il s'était arrêté — **même un an plus tard**, puisque le fichier partiel et
> l'état (`state/tasks.json`) sont conservés et relus automatiquement au démarrage.

---

## 1. Fonctionnalités

| Fonction | Détail |
| --- | --- |
| Téléchargement multi-blocs | Requêtes HTTP `Range` réécrites bloc par bloc (1 Mo) au lieu de tout recommencer |
| Reprise infaillible | État sauvegardé en continu (`state/tasks.json`) + fichier partiel conservé |
| Reprise automatique | Au démarrage, tout téléchargement inachevé repart tout seul |
| Pause / Reprendre / Arrêter | Le worker redémarre réellement à la reprise (pas seulement un drapeau) |
| Reprise réseau | 5 tentatives par bloc avec attente progressive (1 s → 15 s) en cas de coupure |
| Diagnostic | `/health`, `/debug`, journal du moteur dans la console de démarrage |
| Portable | Un seul petit dossier, aucune base de données, aucune dépendance Python externe (bibliothèque standard uniquement) |
| Aucun prérequis | Python embarqué dans le paquet (`python-embed/`) : la version installée fonctionne sur un PC où Python n'est pas installé |
| Installation | Générateur d'installateur Windows (NSIS) + version portable + AppImage/dmg, icône personnalisée intégrée |

## 2. Arborescence

```
downloader-project/
├─ electron/            Interface graphique (Electron, HTML/CSS/JS sans framework)
│  ├─ main.js           Processus principal : lance/arrête le moteur, IPC, ouverture des fichiers
│  ├─ preload.js        Pont sécurisé (contextIsolation) entre l'interface et le système
│  ├─ index.html        Structure de la fenêtre
│  ├─ styles.css        Thème sombre compact
│  └─ renderer.js       Liste des téléchargements, progression, vitesse, boutons
├─ python/
│  └─ backend.py        MOTEUR : serveur HTTP local + téléchargement multi-blocs + reprise
├─ python-embed/        Python embarqué, téléchargé par la construction (non versionné)
├─ assets/
│  ├─ icon.ico          Icône de l'application (Windows)
│  └─ icon.png          Icône 512 px (Linux/macOS, documentation)
├─ scripts/
│  ├─ start.js          Démarrage conjoint moteur Python + interface Electron (npm start)
│  ├─ install.js        Installation des dépendances et vérification de Python (npm run setup)
│  ├─ fetch_python.js   Télécharge le Python embarqué (python-embed/)
│  ├─ make_icons.py     Dessine assets/icon.ico + assets/icon.png (sans dépendance)
│  ├─ prepare_codesign.js  Prépare l'outil rcedit sans droits administrateur
│  └─ build.js          Construction de l'installateur (npm run dist)
├─ state/tasks.json      État de reprise (créé automatiquement, non versionné)
├─ downloads/           Fichiers téléchargés (non versionné)
├─ start.bat            Lancement par double-clic sous Windows
└─ package.json         Dépendances + configuration de l'installateur
```

## 3. Démarrage rapide

**Prérequis pour développer** : [Node.js 18+](https://nodejs.org/) et [Python 3.9+](https://www.python.org/downloads/)
(cochez « Add python.exe to PATH » à l'installation de Python).

> Python n'est nécessaire **que pour le développement**. La version installée embarque son propre
> interpréteur (`python-embed/`), donc le PC de destination n'a besoin de rien.
> Pour ne plus dépendre non plus du Python du système en développement, lancez
> `node scripts/fetch_python.js` : la suite se comportera exactement comme la version installée.

```bash
# 1. Installation (dépendances Electron)
npm install

# 2. Vérification de l'environnement + dossiers
npm run setup

# 3. Lancement : moteur Python + interface graphique, ensemble
npm start
```

Sous Windows, il suffit ensuite de **double-cliquer sur `start.bat`**.

Autres commandes utiles :

```bash
npm run backend     # moteur seul, sans interface (utile pour déboguer)
npm run start:gui   # interface seule (si le moteur tourne déjà)
npm run dist        # construit l'installateur
```

## 4. Utilisation

1. Ouvrez l'application, collez l'URL d'un fichier (`.zip`, `.exe`, `.mp4`, ISO, PDF…) dans la barre du haut.
2. Cliquez sur **Ajouter** : le téléchargement démarre immédiatement, avec pourcentage, taille, vitesse et temps restant.
3. Les boutons de chaque ligne permettent de **mettre en pause** (❚❚), **reprendre** (►), **arrêter** (■),
   **supprimer** (✕, avec option de suppression du fichier) et **ouvrir** (📂) le fichier terminé.
4. Le bouton 📁 de la barre du haut ouvre le dossier `downloads/`.

## 5. Comment la reprise fonctionne

1. Le moteur envoie d'abord une requête `HEAD` pour connaître la taille totale du fichier.
2. Il ouvre le fichier cible en écriture et place le curseur (`seek`) à la position à récupérer.
3. Il télécharge par blocs `Range: bytes=start-end` (1 Mo) et, après **chaque** bloc, il note
   l'intervalle obtenu dans `state/tasks.json` (fusion automatique des intervalles contigus).
4. En cas d'erreur réseau, il retente le même intervalle (attente exponentielle) : rien n'est perdu.
5. À la réouverture de l'application, `auto_resume()` relit `tasks.json`, recalcule les trous restants
   et reprend uniquement les morceaux manquants. Le fichier partiel peut donc attendre des mois.
6. Quand le fichier est complet (`taille sur disque >= taille annoncée`), la tâche passe en *Terminé*.

Si un serveur ne gère pas les requêtes `Range` (pas de code HTTP 206), le moteur bascule
automatiquement en téléchargement simple en un seul passage.

## 6. Créer le logiciel installable

```bash
npm run dist
```

Les fichiers générés apparaissent dans `release/` :

* `Telechargeur-Pro-Setup-1.0.0.exe` → **installateur Windows** (raccourci bureau + menu Démarrer,
  choix du dossier d'installation, désinstallation propre) ;
* `Telechargeur-Pro-Portable-1.0.0.exe` → **version portable**, aucun droit administrateur requis ;
* `*.AppImage` / `*.deb` sous Linux, `*.dmg` sous macOS (la construction doit être faite sur le système visé).

L'installateur embarque **tout ce qu'il faut**, interpréteur compris :

* le moteur : `resources/python/backend.py` ;
* un **Python embarqué** : `resources/python-embed/`, c'est-à-dire la distribution officielle
  « embeddable » de python.org (≈ 11 Mo), téléchargée automatiquement par `scripts/fetch_python.js`
  au moment de la construction ;
* les icônes : `resources/assets/`.

> **Le PC cible n'a donc aucun prérequis** : ni Python, ni `pip`, ni droits d'administrateur
> (la version portable n'en demande aucun). Le moteur n'utilise que la bibliothèque standard.

Au démarrage, l'application cherche l'interpréteur dans cet ordre : Python embarqué (version installée),
puis `py -3`, `python`, `python3` du système (utile en développement).

Chaque étape de `scripts/build.js` est facultative : un échec produit un avertissement, pas un arrêt.

| Étape | Rôle | Si elle échoue |
| --- | --- | --- |
| Icône | Génère `assets/icon.ico` + `assets/icon.png` (ou réutilise ceux déjà présents) | Icône standard d'Electron |
| Python embarqué | Télécharge `python-3.13.x-embed-amd64.zip` et l'extrait dans `python-embed/` | La version installée utilisera le Python du système |
| Outil rcedit | Extrait l'archive `winCodeSign` **sans le dossier `darwin`**, dont les liens symboliques sont refusés par Windows — c'est le rôle de `scripts/prepare_codesign.js` | L'icône du `.exe` n'est pas gravée |
| electron-builder | Produit l'installateur NSIS + la version portable | La construction s'arrête |

La première construction a donc besoin d'un accès Internet (Python embarqué + outil rcedit).
Les dossiers `python-embed/` (10 Mo) et `vendor/` ne sont **pas versionnés** : ils sont reconstruits à la
demande. Pour choisir une autre version de Python, définissez la variable d'environnement
`SDM_PYTHON_VERSION` (par défaut `3.13.7`) puis relancez `npm run dist` — ou
`node scripts/fetch_python.js --force` pour forcer le retéléchargement.

Les arguments passés au script sont transmis à electron-builder : `npm run release` effectue donc les
mêmes préparations que `npm run dist`, puis publie la version dans les Releases GitHub
(jeton `GH_TOKEN` requis, voir la section suivante).

## 7. Dépôt GitHub (déjà publié)

Le code est **déjà envoyé** sur votre compte GitHub :

> **https://github.com/oumarmouhammad92-commits/telecharger-pro**

(Le compte technique qui pousse le code est `oumarmouhammad92-commits`, rattaché à
l'adresse `oumarmouhammad92@gmail.com`. Le nom affiché de l'auteur est `oumarmouhammad92`.)

Le dépôt distant `origin` et la branche `main` sont déjà configurés. Pour envoyer une modification :

```bash
git add -A
git commit -m "Ma modification"
git push
```

Pour publier une version téléchargeable dans l'onglet **Releases** (installateur Windows) :

```bash
npm run dist      # crée release/Telechargeur-Pro-Setup-1.0.0.exe

# Publication automatique (nécessite un jeton GitHub avec la portée « repo ») :
setx GH_TOKEN votre_jeton     # puis rouvrir le terminal
npm run release
```

Sans jeton, la publication se fait à la main : ouvrez
<https://github.com/oumarmouhammad92-commits/telecharger-pro/releases/new>, puis glissez
le fichier `release/Telechargeur-Pro-Setup-1.0.0.exe` dans la Release.

## 8. API locale du moteur (port 9898 par défaut)

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/health` | Vérification de disponibilité (utilisée par le script de démarrage) |
| GET | `/tasks` | Liste des tâches avec `downloaded`, `total_size`, `percent` |
| GET | `/task/<id>` | Détail d'une tâche |
| GET | `/downloads` | Dossier de destination |
| POST | `/tasks/add` | `{ "url": "...", "suggested_name": "..." }` |
| POST | `/task/start` `/task/pause` `/task/stop` `/task/remove` | Pilotage (`{ "task_id": "..." }`) |
| POST | `/resume-all` | Relance toutes les tâches inachevées |
| POST | `/shutdown` | Arrêt propre (sauvegarde l'état avant de quitter) |

## 9. Variables d'environnement

| Variable | Effet |
| --- | --- |
| `SDM_PORT` | Port souhaité pour le moteur (repli automatique sur les 19 ports suivants s'il est occupé) |
| `SDM_STATE_DIR` | Dossier de l'état de reprise (utilisé par la version installée : `%APPDATA%`) |
| `SDM_DOWNLOADS_DIR` | Dossier des fichiers téléchargés (version installée : dossier « Téléchargements ») |
| `SDM_EXTERNAL_BACKEND` | `1` : le moteur est déjà lancé par `scripts/start.js` (évite un double démarrage) |
| `SDM_BACKEND_PORT` | Port transmis à l'interface par le script de démarrage |

## 10. Dépannage

| Symptôme | Solution |
| --- | --- |
| « Python 3 est introuvable » — version installée | Anormal : le paquet embarque son interpréteur. Vérifiez la présence de `resources/python-embed/python.exe`, sinon reconstruisez avec `npm run dist` |
| « Python 3 est introuvable » — développement | Installez Python depuis python.org en cochant **Add python.exe to PATH**, ou lancez `node scripts/fetch_python.js` pour utiliser le Python embarqué, puis relancez `start.bat` |
| L'icône du `.exe` reste celle d'Electron | Relancez `npm run dist` : `scripts/prepare_codesign.js` prépare rcedit sans droit administrateur |
| « Electron n'est pas installé » | Lancez `npm install` à la racine du projet |
| La liste reste vide / « Moteur indisponible » | Vérifiez la console de démarrage : le moteur indique son port (`PORT=9898`). Un antivirus peut bloquer un port local |
| Un téléchargement reste à 0 % | Le serveur distant refuse peut-être `HEAD`/`Range` : le moteur basculera en mode simple, ou l'URL nécessite une session (cookies) |
| Repartir de zéro | Supprimez `state/tasks.json` et le fichier partiel dans `downloads/` |

## 11. Licence

MIT — voir `LICENSE`. Auteur : **oumarmouhammad92** (oumarmouhammad92@gmail.com).
