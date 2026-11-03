import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const appPath = path.join(root, 'out/Code Learning-darwin-arm64/Code Learning.app');
const outputDirectory = path.join(root, 'out/make');
const dmgPath = path.join(outputDirectory, 'Code-Learning-mac-arm64.dmg');

if (!existsSync(appPath)) {
  throw new Error(`Packaged app not found: ${appPath}`);
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'code-learning-dmg-'));
try {
  await execFileAsync('ditto', [appPath, path.join(temp, 'Code Learning.app')]);
  await symlink('/Applications', path.join(temp, 'Applications'));
  await mkdir(outputDirectory, { recursive: true });
  await execFileAsync('hdiutil', [
    'create', '-volname', 'Code Learning', '-srcfolder', temp,
    '-ov', '-format', 'UDZO', dmgPath,
  ]);
} finally {
  await rm(temp, { recursive: true, force: true });
}
