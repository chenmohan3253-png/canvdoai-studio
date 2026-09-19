import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

// Package material only. This inventory is not a legal clearance or an SBOM for FFmpeg.
const root = resolve('.');
const destination = join(root, 'docs', 'third-party-notices');
await mkdir(destination, { recursive: true });
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const records = [];
for (const [directory, entry] of Object.entries(lock.packages)) {
  if (!directory || entry.dev) continue;
  const packageDirectory = resolve(root, directory);
  if (!packageDirectory.startsWith(root + sep) || !directory.startsWith('node_modules/')) {
    throw Error(`Unexpected dependency path: ${directory}`);
  }
  const metadata = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  const noticeFiles = (await readdir(packageDirectory, { withFileTypes: true }))
    .filter(file => file.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file.name));
  const prefix = `${metadata.name.replaceAll('/', '__').replaceAll('@', '')}-${metadata.version}`;
  const notices = [];
  for (const file of noticeFiles) {
    const target = join(destination, `${prefix}-${file.name}`);
    await copyFile(join(packageDirectory, file.name), target);
    const bytes = await readFile(target);
    notices.push({ file: relative(destination, target), sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  records.push({ name: metadata.name, version: metadata.version, declaredLicense: metadata.license ?? metadata.licenses ?? null, dependencyPath: directory, notices });
}
await writeFile(join(destination, 'inventory.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  scope: 'Installed production npm dependencies, including transitive packages and declarations. FFmpeg/Electron redistribution require separate review.',
  packages: records,
}, null, 2));
const missing = records.filter(record => !record.notices.length);
if (missing.length) throw Error(`Missing license notice files: ${missing.map(record => record.name).join(', ')}`);
console.log(`Collected license notices for ${records.length} production dependency paths.`);
