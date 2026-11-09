import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Windows checkouts convert line endings to CRLF; the checks below match LF text.
const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/release.yml');
const script = read('scripts/release-draft.mjs');
const jobs = Object.fromEntries([...workflow.matchAll(/^  (version|mac|windows|draft):\n([\s\S]*?)(?=^  \w+:\n|$(?![\s\S]))/gm)]
  .map(match => [match[1], match[2]]));

describe('draft release configuration', () => {
  it('keeps the app and both lockfile root versions as the same plain release version', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(pkg.description).toBe('Read-only app for exploring unfamiliar TypeScript and JavaScript projects');
    expect(read('forge.config.ts')).toContain(`description: '${pkg.description}'`);
  });

  it.each([['workflow', workflow], ['script', script]])('contains no publication flags in the %s', (_, text) => {
    expect(text).not.toMatch(/--draft[=\s]+false|draft:\s*false|--latest/);
  });

  it('grants write permission only to the final draft job', () => {
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    expect(workflow.match(/contents: write/g)).toHaveLength(1);
    expect(jobs.draft).toMatch(/    permissions:\n      contents: write/);
    expect(jobs.draft).toContain('needs: [version, mac, windows]');
    expect(jobs.draft).not.toMatch(/if:\s*(?:always\(\)|\$\{\{\s*always\(\))/);
  });

  it('supports manual and tag triggers in the same serialized version group', () => {
    expect(workflow).toContain('workflow_dispatch:\n    inputs:\n      version:');
    expect(workflow).toContain('required: true');
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain("group: release-${{ inputs.version && format('v{0}', inputs.version) || github.ref_name }}");
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('passes inputs through env and keeps decisions out of run commands', () => {
    const commands = [...workflow.matchAll(/^([ \t]*)(?:- )?run:\s*(.*)(?:\n((?:\1[ \t]+.*\n)*))?/gm)]
      .map(match => `${match[2]}\n${match[3] ?? ''}`);
    expect(commands.length).toBe(8);
    for (const command of commands) expect(command).not.toMatch(/\$\{\{\s*(?:inputs\.|github\.event\.inputs\.)/);
    expect(jobs.version).toContain('env:\n          RELEASE_VERSION: ${{ inputs.version }}');
    expect(jobs.version).toContain('run: node scripts/release-draft.mjs version');
    expect(jobs.draft).toContain('run: node scripts/release-draft.mjs draft');
    expect(jobs.draft).toContain('RELEASE_VERSION: ${{ needs.version.outputs.version }}');
    expect(jobs.draft).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('builds and tests each installer before uploading it for seven days', () => {
    expect(jobs.mac).toMatch(/needs: version[\s\S]*runs-on: macos-latest/);
    expect(jobs.windows).toMatch(/needs: version[\s\S]*runs-on: windows-latest/);
    expect(jobs.mac).toMatch(/run: npm ci[\s\S]*run: npm run make\n[\s\S]*run: npm run test:packaged[\s\S]*uses: actions\/upload-artifact@v7/);
    expect(jobs.windows).toMatch(/run: npm ci[\s\S]*run: npm run make:win[\s\S]*run: node scripts\/windows-installer-smoke.mjs[\s\S]*uses: actions\/upload-artifact@v7/);
    for (const job of [jobs.mac, jobs.windows]) {
      expect(job).toContain('retention-days: 7');
      expect(job).toContain('if-no-files-found: error');
      expect(job).not.toContain('if: always()');
    }
  });

  it('uses the existing installer names and downloads both artifacts to one directory', () => {
    const macName = read('scripts/make-dmg.mjs').match(/'([^']+\.dmg)'/)![1];
    const windowsName = read('forge.config.ts').match(/setupExe: '([^']+)'/)![1];
    expect(macName).toBe('Code-Learning-mac-arm64.dmg');
    expect(windowsName).toBe('Code-Learning-win-x64-Setup.exe');
    expect(jobs.mac).toContain(`path: out/make/${macName}`);
    expect(jobs.windows).toContain(`path: out/make/squirrel.windows/x64/${windowsName}`);
    expect(script).toContain(`['${macName}', '${windowsName}']`);
    expect(script).toContain("'SHA256SUMS.txt'");
    expect(jobs.draft).toContain('name: release-mac\n          path: artifacts');
    expect(jobs.draft).toContain('name: release-windows\n          path: artifacts');
    expect(workflow).not.toMatch(/\.nupkg|\bRELEASES\b/);
  });

  it('uses the CI checkout and Node versions in every job', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(Object.keys(jobs)).toEqual(['version', 'mac', 'windows', 'draft']);
    for (const job of Object.values(jobs)) {
      for (const setting of ['actions/checkout@v7', 'actions/setup-node@v7', 'node-version: 24.18.0', 'cache: npm']) {
        expect(ci).toContain(setting);
        expect(job).toContain(setting);
      }
    }
    expect(workflow.match(/actions\/download-artifact@v8/g)).toHaveLength(2);
  });
});
