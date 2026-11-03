// Sanity checks before loading or packaging: the manifest parses, every file it points to exists, and every
// relative import in src/ resolves. Run with `npm run check`.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const problems = [];
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

const files = [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  'src/offscreen/offscreen.html',
];
for (const f of files) if (!existsSync(join(root, f))) problems.push(`manifest points to a missing file: ${f}`);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
for (const file of walk(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const refs = [
    ...text.matchAll(/(?:import|from)\s*['"](\.[^'"]+)['"]/g),
    ...text.matchAll(/(?:src|href)="(?!https?:)([^"#]+\.(?:js|css|png))"/g),
    ...text.matchAll(/new URL\('(\.[^']+)'/g),
  ].map((m) => m[1]);
  for (const ref of refs) {
    if (!existsSync(resolve(dirname(file), ref))) problems.push(`${file.slice(root.length + 1)} refers to a missing file: ${ref}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: IntervQ extension ${manifest.version}, ${files.length} manifest files and all imports found.`);
