const { spawnSync } = require('child_process');

console.log('--- Installation de Téléchargeur Pro ---');

const result = spawnSync('npm', ['install'], { stdio: 'inherit', shell: true });

if (result.status !== 0) {
  console.error('[setup] L\'installation des dépendances a échoué.');
  process.exit(result.status || 1);
}

console.log('');
console.log('[setup] Dépendances installées.');
console.log('[setup] Python (développement uniquement) :');
spawnSync('python', ['--version'], { stdio: 'inherit', shell: true });
console.log('');
console.log('[setup] En l’absence de Python, lancez  node scripts/fetch_python.js');
console.log('[setup] pour utiliser le Python embarqué — c’est déjà le cas de la version installée.');
console.log('');
console.log('Démarrage :  npm start      (ou double-clic sur start.bat)');
console.log('Moteur seul : npm run backend');
console.log('Installateur : npm run dist');
