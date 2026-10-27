import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeHighlightStyle } from '../src/renderer/code-theme';

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const lightBlock = css.match(/:root\s*\{([^}]+)\}/)![1];
const darkBlock = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)![1];
const themes = [lightBlock, darkBlock].map(block =>
  Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]])));
const [light, dark] = themes;

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string) {
  const light = luminance(foreground), dark = luminance(background);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

describe.each(['light', 'dark'])('%s workspace contrast', mode => {
  const tokens = mode === 'light' ? light : dark;
  it('keeps body, secondary text and line numbers readable on their backgrounds', () => {
    for (const ink of ['ink', 'muted']) for (const background of ['bg', 'rail', 'side', 'surface', 'raised', 'mark', 'accent-soft']) {
      expect(contrast(tokens[ink], tokens[background]), `${ink} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const background of ['surface', 'side']) expect(contrast(tokens.dim, tokens[background])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps chips, primary buttons and notices readable', () => {
    for (const [ink, background] of [['accent-ink', 'accent'], ['accent', 'accent-soft'], ['ok', 'ok-soft'], ['warn', 'warn-soft'], ['danger', 'danger-soft']]) {
      expect(contrast(tokens[ink], tokens[background]), `${ink} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps every syntax colour readable on code, evidence and changed lines', () => {
    for (const style of codeHighlightStyle.specs) {
      expect(style.color).toMatch(/^var\(--(?:syntax-[\w-]+|muted)\)$/);
      const colour = tokens[style.color!.slice(6, -1)];
      for (const background of ['surface', 'mark', 'ok-soft', 'danger-soft']) {
        expect(contrast(colour, tokens[background]), `${colour} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('system theme tokens', () => {
  it('defines the same tokens in both themes without duplicates', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const [index, block] of [lightBlock, darkBlock].entries()) {
      expect([...block.matchAll(/--[\w-]+:/g)]).toHaveLength(Object.keys(themes[index]).length);
    }
  });

  it('uses a bright paper background by default and preserves the dark background', () => {
    expect(css).toMatch(/color-scheme:\s*light dark;/);
    expect(luminance(light.bg)).toBeGreaterThan(0.8);
    expect(dark.bg).toBe('#14161A');
    expect(light.radius).toBe('3px');
    expect(dark.radius).toBe('10px');
  });

  it('keeps renderer colours in the theme definitions', () => {
    const renderer = new URL('../src/renderer/', import.meta.url);
    // The neutral translucent shadow is shared by both themes.
    const allowedColours = ['rgb(0 0 0 / .08)'];
    const files = readdirSync(renderer, { recursive: true, encoding: 'utf8' }).filter(file => /\.(?:ts|tsx|css)$/.test(file));
    for (const file of files) {
      let source = readFileSync(new URL(file, renderer), 'utf8');
      if (file === 'styles.css') {
        for (const block of [lightBlock, darkBlock]) source = source.replace(block, block.replace(/--[\w-]+:\s*[^;]+;/g, ''));
      }
      for (const colour of allowedColours) source = source.replaceAll(colour, '');
      expect(source.match(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi), file).toBeNull();
    }
  });
});
