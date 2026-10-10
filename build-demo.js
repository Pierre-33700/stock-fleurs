'use strict';
// Génère le site de démonstration (GitHub Pages) dans docs/ : npm run build:demo
// L'application est la même que la vraie, mais un faux serveur (demo/api-local.js) garde les données dans le navigateur.
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const out = path.join(root, 'docs');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, c) => fs.writeFileSync(path.join(out, f), c);

for (const f of ['app.js', 'style.css', 'icon.svg']) fs.copyFileSync(path.join(root, 'public', f), path.join(out, f));
fs.copyFileSync(path.join(root, 'demo', 'api-local.js'), path.join(out, 'api-local.js'));

// Chemins relatifs : la page est servie sous /nom-du-depot/ et non à la racine du domaine.
let html = read('public/index.html')
  .replace(/(href|src)="\//g, '$1="')
  .replace('<title>Stock Fleurs</title>', '<title>Stock Fleurs · démonstration</title>')
  .replace('<script src="app.js"></script>', '<script src="api-local.js"></script>\n<script src="app.js"></script>');
if (!html.includes('api-local.js')) throw new Error('Insertion du faux serveur impossible : index.html a changé.');
write('index.html', html);

const manifest = JSON.parse(read('public/manifest.webmanifest'));
manifest.name = 'Stock Fleurs (démo)';
manifest.short_name = 'Stock Fleurs';
manifest.start_url = './';
manifest.icons = manifest.icons.map((i) => ({ ...i, src: i.src.replace(/^\//, '') }));
write('manifest.webmanifest', JSON.stringify(manifest, null, 2) + '\n');

write('.nojekyll', '');
console.log('Site de démonstration généré dans docs/');
