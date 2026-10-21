import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeHighlightStyle } from '../src/renderer/code-theme';

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(match => [match[1], match[2]]));

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

describe('dark workspace contrast', () => {
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
      const colour = style.color === 'var(--muted)' ? tokens.muted : style.color!;
      for (const background of ['surface', 'mark', 'ok-soft', 'danger-soft']) {
        expect(contrast(colour, tokens[background]), `${colour} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
