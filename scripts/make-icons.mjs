import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') {
  console.error('macOS에서 실행하세요');
  process.exit(1);
}

const execFileAsync = promisify(execFile);
// The electron package exports the path to its binary.
const { default: electron } = await import('electron');
const root = path.resolve(import.meta.dirname, '..');
const destination = path.join(root, 'assets/icon');
const temp = await mkdtemp(path.join(os.tmpdir(), 'code-learning-icons-'));
try {
  const rendered = path.join(temp, 'icon.png');
  await execFileAsync(electron, [path.join(root, 'scripts/render-icon.cjs'), path.join(destination, 'icon.svg'), rendered], { timeout: 120_000 });
  const iconset = path.join(temp, 'icon.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const file = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      await execFileAsync('sips', ['-z', pixels, pixels, rendered, '--out', file]);
    }
  }
  const icns = path.join(temp, 'icon.icns');
  await execFileAsync('iconutil', ['-c', 'icns', iconset, '-o', icns]);

  // sips crops around the centre: keep pixels 64 through 959 on each axis for Windows.
  const cropped = path.join(temp, 'windows.png');
  await execFileAsync('sips', ['-c', '896', '896', rendered, '--out', cropped]);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  const images = [];
  let offset = directory.length;
  for (const [index, size] of sizes.entries()) {
    const file = path.join(temp, `windows-${size}.png`);
    await execFileAsync('sips', ['-z', String(size), String(size), cropped, '--out', file]);
    const png = await readFile(file);
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    images.push(png);
    offset += png.length;
  }
  const ico = path.join(temp, 'icon.ico');
  await writeFile(ico, Buffer.concat([directory, ...images]));
  // Leave existing assets alone if rendering or conversion fails.
  await copyFile(icns, path.join(destination, 'icon.icns'));
  await copyFile(ico, path.join(destination, 'icon.ico'));
  console.log('Created assets/icon/icon.icns and assets/icon/icon.ico');
} finally {
  await rm(temp, { recursive: true, force: true });
}
