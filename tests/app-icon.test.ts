import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const config = readFileSync(path.join(root, 'forge.config.ts'), 'utf8');
const icon = config.match(/^\s*icon:\s*'([^']+)'/m)?.[1];
const setupIcon = config.match(/^\s*setupIcon:\s*'([^']+)'/m)?.[1];
const iconUrl = config.match(/^\s*iconUrl:\s*'([^']+)'/m)?.[1];

describe('app icon assets', () => {
  it('points the packager and installer at committed icon files', () => {
    expect(icon).toBe('assets/icon/icon');
    expect(setupIcon).toBe(`${icon}.ico`);
    for (const extension of ['svg', 'icns', 'ico']) {
      expect(existsSync(path.join(root, `${icon}.${extension}`)), extension).toBe(true);
    }
  });

  it('downloads the same repository file used by the installer', () => {
    expect(iconUrl).toBeDefined();
    const url = new URL(iconUrl!);
    expect(url.origin).toBe('https://raw.githubusercontent.com');
    expect(url.pathname).toBe(`/ckdgus222/code-learning/main/${setupIcon}`);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });

  it('contains seven correctly sized PNG images within the ICO directory bounds', () => {
    const ico = readFileSync(path.join(root, 'assets/icon/icon.ico'));
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(sizes.length);
    let end = 6 + sizes.length * 16;
    for (const [index, size] of sizes.entries()) {
      const entry = 6 + index * 16;
      expect(ico[entry]).toBe(size === 256 ? 0 : size);
      expect(ico[entry + 1]).toBe(size === 256 ? 0 : size);
      expect(ico[entry + 2]).toBe(0);
      expect(ico[entry + 3]).toBe(0);
      expect(ico.readUInt16LE(entry + 4)).toBe(1);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset).toBe(end);
      expect(length).toBeGreaterThanOrEqual(33);
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      const png = ico.subarray(offset, offset + length);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.toString('ascii', 12, 16)).toBe('IHDR');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      end = offset + length;
    }
    expect(end).toBe(ico.length);
  });

  it('contains the expected ICNS representations with valid element lengths', () => {
    const icns = readFileSync(path.join(root, 'assets/icon/icon.icns'));
    expect(icns.toString('ascii', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const types = [];
    let offset = 8;
    while (offset < icns.length) {
      expect(offset + 8).toBeLessThanOrEqual(icns.length);
      types.push(icns.toString('ascii', offset, offset + 4));
      const length = icns.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThanOrEqual(8);
      expect(offset + length).toBeLessThanOrEqual(icns.length);
      offset += length;
    }
    expect(offset).toBe(icns.length);
    expect(types).toEqual(expect.arrayContaining(['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']));
    // Depending on the macOS version, iconutil stores the 16px and 32px entries as PNG (icp4/icp5),
    // ARGB (ic04/ic05; seen on macOS 27) or legacy RGB + mask.
    expect(types.some(type => ['icp4', 'ic04'].includes(type)) || (types.includes('is32') && types.includes('s8mk'))).toBe(true);
    expect(types.some(type => ['icp5', 'ic05'].includes(type)) || (types.includes('il32') && types.includes('l8mk'))).toBe(true);
  });
});
