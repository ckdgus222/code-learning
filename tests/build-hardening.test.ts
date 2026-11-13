import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import config from '../forge.config';
import { signMacPackages } from '../scripts/mac-signing';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('build hardening', () => {
  // Packager passes root-relative paths with '/' separators, including on Windows.
  it.each([
    '/node_modules/.vite',
    '/node_modules/.vite/deps/_metadata.json',
    '/node_modules/.vitest-cache',
    '/node_modules/.vitest-cache/tests/results.json',
    '/node_modules/example/node_modules/.vite',
    '/node_modules/example/node_modules/.vitest-cache/results.json',
    '/node_modules/@scope/example/node_modules/.vite/deps/index.js',
    '/node_modules/@scope/example/node_modules/.vitest-cache',
  ])('excludes development cache %s from the package', file => {
    expect(config.packagerConfig.ignore(file)).toBe(true);
  });

  it.each([
    '',
    '/.vite',
    '/.vite/build/main.cjs',
    '/.vite/renderer/main_window/index.html',
    '/node_modules',
    '/node_modules/tree-sitter/prebuilds/darwin-arm64/tree-sitter.node',
    '/node_modules/@typescript/typescript-darwin-arm64/lib/tsc',
    '/node_modules/example/node_modules/other/index.js',
    '/node_modules/.vite-extra/index.js',
    '/node_modules/.vitest-cache-extra/index.js',
    '/node_modules/example/node_modules/.vite-extra/index.js',
    '/node_modules/@scope/example/node_modules/.vitest-cache-extra/index.js',
    '/node_modules/example/.vite/index.js',
  ])('preserves runtime path %j and cache-name lookalikes', file => {
    expect(config.packagerConfig.ignore(file)).toBe(false);
  });

  it.each([
    '/src',
    '/src/main/main.ts',
    '/docs/development.md',
    '/tests/build-hardening.test.ts',
    '/README.md',
    '/.vitest-cache/results.json',
    '/.vite-extra/main.cjs',
    '/node_modules-extra/index.js',
  ])('continues to exclude non-runtime root path %s', file => {
    expect(config.packagerConfig.ignore(file)).toBe(true);
  });

  it('sets only the planned fuses and leaves file:// privileges at their default', () => {
    const plugins = config.plugins.filter(plugin => plugin instanceof FusesPlugin);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].config).toEqual({
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
    expect(Object.keys(plugins[0].getHooks())).toEqual(['packageAfterCopy']);
    expect(config.hooks.postPackage).toBe(signMacPackages);
  });

  it('explicitly allows or denies every locked install script, including nested packages', () => {
    const manifest = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    const scripts = Object.entries(lock.packages)
      .filter(([, entry]) => (entry as { hasInstallScript?: boolean }).hasInstallScript)
      .map(([location, entry]) => {
        const pkg = entry as { name?: string; version: string };
        return `${pkg.name ?? location.split('node_modules/').at(-1)}@${pkg.version}`;
      });
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(typeof manifest.allowScripts[script], script).toBe('boolean');
    expect(manifest.allowScripts).toEqual({
      'electron-winstaller@5.4.4': true,
      'fsevents@2.3.3': false,
      'tree-sitter@0.21.1': false,
      'tree-sitter-javascript@0.21.4': false,
      'tree-sitter-javascript@0.23.1': false,
      'tree-sitter-python@0.23.4': false,
      'tree-sitter-typescript@0.23.2': false,
    });
    expect(manifest.devDependencies.electron).toBe('44.10.2');
    expect(lock.packages['node_modules/electron'].version).toBe('44.10.2');
  });

  it('fails installs for unreviewed scripts', () => {
    const settings = read('.npmrc').split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith(';'));
    expect(settings.filter(line => line.startsWith('strict-allow-scripts'))).toEqual(['strict-allow-scripts=true']);
  });
});
