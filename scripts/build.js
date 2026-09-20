const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

console.log('--- Construction de l\'installateur ---');
console.log('Utilisation de electron-builder avec la configuration package.json.');
const s = spawnSync('npx', ['electron-builder', '--config', path.join(ROOT, 'package.json')], {
  stdio: 'inherit',
  cwd: ROOT,
});
if (s.status !== 0) {
  console.warn('electron-builder a échoué. Vérifiez la configuration et les dépendances.');
  process.exit(s.status || 1);
}
console.log('Construction terminée.');
