import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tags, highlightTree } from '@lezer/highlight';
import { javascriptLanguage, jsxLanguage, tsxLanguage } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { highlightingFor, language, syntaxTree } from '@codemirror/language';
import { codeHighlighting, codeHighlightStyle } from '../src/renderer/code-theme';

describe('codeHighlighting', () => {
  it('leaves plain text without a parser or syntax colours', () => {
    const extensions = codeHighlighting('text');
    expect(extensions).toEqual([]);
    const state = EditorState.create({ extensions });
    expect(state.facet(language)).toBeNull();
    expect(highlightingFor(state, [tags.keyword])).toBeNull();
  });

  it.each(['typescript', 'javascript'] as const)('provides the %s parser and shared colours with JSX enabled', sourceLanguage => {
    const extensions = codeHighlighting(sourceLanguage);
    expect(extensions).toHaveLength(2);
    const state = EditorState.create({ doc: 'const value: number = 1;', extensions });
    expect(state.facet(language)).toBe(sourceLanguage === 'typescript' ? tsxLanguage : jsxLanguage);
    for (const tag of [tags.keyword, tags.string, tags.comment]) {
      expect(highlightingFor(state, [tag])).toBe(codeHighlightStyle.style([tag]));
    }
    if (sourceLanguage === 'typescript') {
      const errors: string[] = [];
      syntaxTree(state).iterate({ enter: node => { if (node.type.isError) errors.push(node.name); } });
      expect(errors).toEqual([]);
      expect(syntaxTree(state).toString()).toContain('TypeAnnotation');
    }
  });
});

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const lightBlock = css.match(/:root\s*\{([^}]+)\}/)![1];
const darkBlock = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)![1];
const contrastBlocks = [...css.matchAll(/:root\[data-code-colors="contrast"\]\s*\{([^}]+)\}/g)].map(match => match[1]);
const contrastOverrides = contrastBlocks.map(block =>
  Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]])));
const codeTokens = ['code-ink', 'syntax-keyword', 'syntax-function', 'syntax-property', 'syntax-type', 'syntax-string', 'syntax-number', 'syntax-comment'];
const overrides = [lightBlock, darkBlock].map(block =>
  Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]])));
const light = overrides[0];
const dark = { ...light, ...overrides[1] };

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
      expect(style.color).toMatch(/^var\(--(?:syntax-[\w-]+|code-ink)\)$/);
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
      expect([...block.matchAll(/--[\w-]+:/g)]).toHaveLength(Object.keys(overrides[index]).length);
    }
  });

  it('uses a bright paper background by default and uses the navy blueprint background', () => {
    expect(css).toMatch(/color-scheme:\s*light dark;/);
    expect(luminance(light.bg)).toBeGreaterThan(0.8);
    expect(dark.bg).toBe('#0A1422');
    expect(dark.surface).toBe('#0D1828');
    expect(dark.accent).toBe('#7DB2F8');
    expect(light.radius).toBe('3px');
    expect(dark.radius).toBe('3px');
    expect(light['radius-sm']).toBe('3px');
    expect(dark['radius-sm']).toBe('3px');
  });

  it('keeps renderer colours in the theme definitions', () => {
    const renderer = new URL('../src/renderer/', import.meta.url);
    // The neutral translucent shadow is shared by both themes.
    const allowedColours = ['rgb(0 0 0 / .08)'];
    const files = readdirSync(renderer, { recursive: true, encoding: 'utf8' }).filter(file => /\.(?:ts|tsx|css)$/.test(file));
    for (const file of files) {
      let source = readFileSync(new URL(file, renderer), 'utf8');
      if (file === 'styles.css') {
        for (const block of [lightBlock, darkBlock, ...contrastBlocks]) source = source.replace(block, block.replace(/--[\w-]+:\s*[^;]+;/g, ''));
      }
      for (const colour of allowedColours) source = source.replaceAll(colour, '');
      expect(source.match(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi), file).toBeNull();
    }
  });
});


describe.each([
  ['light default', light, false], ['dark default', dark, false],
  ['light contrast', { ...light, ...contrastOverrides[0] }, true],
  ['dark contrast', { ...dark, ...contrastOverrides[1] }, true],
] as const)('%s code colours', (_name, tokens, highContrast) => {
  it('defines all eight code tokens and meets contrast on every code background', () => {
    for (const token of codeTokens) {
      expect(tokens[token], token).toMatch(/^#[\da-f]{6}$/i);
      for (const background of ['surface', 'mark', 'ok-soft', 'danger-soft']) {
        expect(contrast(tokens[token], tokens[background]), `${token} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      if (highContrast) expect(contrast(tokens[token], tokens.surface), token).toBeGreaterThanOrEqual(7);
    }
  });
});

it('defines complete, unique high contrast overrides in both media modes', () => {
  expect(contrastBlocks).toHaveLength(2);
  for (const block of contrastBlocks) {
    expect([...block.matchAll(/--([\w-]+):/g)].map(match => match[1]).sort()).toEqual([...codeTokens].sort());
  }
  for (const tokens of overrides) expect(codeTokens.every(token => token in tokens)).toBe(true);
  expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{[^}]+\}\s*:root\[data-code-colors="contrast"\]/);
});

it('maps declarations, properties, functions and literals to their intended colours', () => {
  const cases = [
    [tags.keyword, 'syntax-keyword'],
    [tags.function(tags.variableName), 'syntax-function'], [tags.function(tags.propertyName), 'syntax-function'],
    [tags.propertyName, 'syntax-property'], [tags.definition(tags.propertyName), 'syntax-property'],
    [tags.definition(tags.variableName), 'code-ink'],
    [tags.typeName, 'syntax-type'], [tags.className, 'syntax-type'],
    [tags.string, 'syntax-string'], [tags.regexp, 'syntax-string'],
    [tags.number, 'syntax-number'], [tags.bool, 'syntax-number'], [tags.null, 'syntax-number'], [tags.atom, 'syntax-number'],
    [tags.comment, 'syntax-comment'],
  ] as const;
  for (const [tag, token] of cases) {
    const style = codeHighlightStyle.specs.find(spec => (Array.isArray(spec.tag) ? spec.tag : [spec.tag]).includes(tag));
    expect(style?.color).toBe(`var(--${token})`);
    if (tag === tags.comment) expect(style?.fontStyle).toBe('italic');
  }
});

it('keeps property and variable declarations distinct from functions in parsed code', () => {
  const source = 'const item = {slug: "a", type: true, empty: null}; function run() { return item.slug; } run();';
  const spans: { text: string; classes: string }[] = [];
  highlightTree(javascriptLanguage.parser.parse(source), codeHighlightStyle, (from, to, classes) => {
    spans.push({ text: source.slice(from, to), classes });
  });
  for (const [word, tag] of [
    ['item', tags.definition(tags.variableName)], ['slug', tags.propertyName], ['type', tags.propertyName],
    ['run', tags.function(tags.variableName)], ['true', tags.bool], ['null', tags.null],
  ] as const) {
    expect(spans.find(span => span.text === word)?.classes, word).toBe(codeHighlightStyle.style([tag]));
  }
});
