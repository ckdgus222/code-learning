import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const docsDirectory = fileURLToPath(new URL('../docs/', import.meta.url));
const page = read('docs/index.html');
const readme = read('README.md');

describe('GitHub Pages intro page', () => {
  it('provides the static entry point, empty Jekyll marker and unchanged app icon', () => {
    expect(read('docs/.nojekyll')).toBe('');
    expect(readFileSync(new URL('../docs/images/icon.svg', import.meta.url)))
      .toEqual(readFileSync(new URL('../assets/icon/icon.svg', import.meta.url)));
  });

  it('links both installers from the README using the release asset names', () => {
    const macName = read('scripts/make-dmg.mjs').match(/'([^']+\.dmg)'/)![1];
    const windowsName = read('forge.config.ts').match(/setupExe: '([^']+)'/)![1];
    const readmeDownloads = [...new Set(readme.match(/https:\/\/github\.com\/ckdgus222\/code-learning\/releases\/latest\/download\/[^)\s]+/g))];
    const pageDownloads = [...page.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi)]
      .map(match => match[1]).filter(url => url.includes('/releases/latest/download/'));
    expect(readmeDownloads).toHaveLength(2);
    expect(pageDownloads.sort()).toEqual(readmeDownloads.sort());
    expect(pageDownloads.map(url => url.split('/').at(-1)).sort()).toEqual([macName, windowsName].sort());
  });

  it('resolves every local src and href to a file inside docs', () => {
    const references = [...page.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
      .map(match => match[1] ?? match[2] ?? match[3]).filter(value => !value.startsWith('https://'));
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const resolved = path.resolve(docsDirectory, reference);
      const relative = path.relative(docsDirectory, resolved);
      expect(relative).not.toBe('..');
      expect(relative.startsWith(`..${path.sep}`)).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(existsSync(resolved), reference).toBe(true);
      expect(statSync(resolved).isFile(), reference).toBe(true);
    }
  });

  it('contains no scripts, insecure URLs, CSS imports or external stylesheets', () => {
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/http:\/\//i);
    expect(page).not.toMatch(/@import/i);
    expect(page).not.toMatch(/<link\b[^>]*\brel\s*=\s*(?:"[^"]*stylesheet[^\"]*"|'[^']*stylesheet[^']*'|stylesheet\b)/i);
  });

  it('restricts resources through CSP and sends no referrer', () => {
    const csp = page.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];
    expect(csp).toContain('content="default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"');
    expect(page).toMatch(/<meta\b[^>]*name="referrer"[^>]*content="no-referrer"[^>]*>/i);
    const externalLinks = [...page.matchAll(/<a\b[^>]*href="https:\/\/[^>]+>/gi)];
    expect(externalLinks.length).toBeGreaterThan(0);
    for (const [link] of externalLinks) expect(link).toMatch(/\brel="noopener"/);
  });

  it('uses the real screenshot sizes and lazy-loads only the later screenshots', () => {
    const screenshots = [...page.matchAll(/<img\b[^>]*src="([^"]+\.png)"[^>]*>/gi)];
    expect(screenshots).toHaveLength(5);
    for (const [index, [tag, source]] of screenshots.entries()) {
      const png = readFileSync(path.join(docsDirectory, source));
      expect(tag).toContain(`width="${png.readUInt32BE(16)}"`);
      expect(tag).toContain(`height="${png.readUInt32BE(20)}"`);
      expect(tag.includes('loading="lazy"')).toBe(index > 0);
      const alt = tag.match(/\balt="([^"]+)"/)![1];
      expect(readme).toContain(`![${alt}](docs/${source})`);
    }
  });
});
