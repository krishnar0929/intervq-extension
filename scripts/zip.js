// Builds dist/intervq-extension.zip for the Chrome Web Store: manifest, icons and src only.
// The manifest's "key" (which pins the extension ID for local, unpacked use) is left out, because the
// Web Store gives the extension its own ID and refuses uploads that carry a key.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const stage = mkdtempSync(join(tmpdir(), 'intervq-zip-'));
const out = join(root, 'dist', 'intervq-extension.zip');

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
delete manifest.key;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, 'icons'), join(stage, 'icons'), { recursive: true });
cpSync(join(root, 'src'), join(stage, 'src'), { recursive: true });

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', out, 'manifest.json', 'icons', 'src'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`${out.slice(root.length + 1)} (version ${manifest.version}, no key)`);
