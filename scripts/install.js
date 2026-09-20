const { spawnSync } = require('child_process');

console.log('--- Installation de Téléchargeur Pro ---');

const result = spawnSync('npm', ['install'], { stdio: 'inherit', shell: true });

if (result.status !== 0) {
  console.error('[setup] L\'installation des dépendances a échoué.');
  process.exit(result.status || 1);
}

console.log('');
console.log('[setup] Dépendances installées.');
console.log('[setup] Vérifiez que Python 3.9+ est disponible :');
spawnSync('python', ['--version'], { stdio: 'inherit', shell: true });
console.log('');
console.log('Démarrage :  npm start      (ou double-clic sur start.bat)');
console.log('Moteur seul : npm run backend');
console.log('Installateur : npm run dist');
