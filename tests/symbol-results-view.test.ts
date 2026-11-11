import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { MapFile } from '../src/shared/contracts';
import type { MapEntry } from '../src/renderer/project-map';
import { SymbolResults } from '../src/renderer/symbol-results';

const entry: MapEntry = { revision: 0, build: 1, map: {
  projectId: 'p', files: [{ id: 'a', relativePath: 'src/a.py', folder: 'src', start: false, entry: false, checked: 'full', reason: null }],
  symbols: [
    { fileId: 'a', fileHash: 'hash', name: 'C.f', kind: 'function', startUtf16: 20, endUtf16: 40, startLine: 3, endLine: 4 },
    { fileId: 'a', fileHash: 'hash', name: 'C', kind: 'class', startUtf16: 0, endUtf16: 40, startLine: 1, endLine: 4 },
  ], symbolsCut: false, edges: [], external: [], unresolved: [], complexFunctions: [], exports: [], limited: false, notes: [],
  unused: { candidates: [], unsure: [], excluded: [], notes: [], exports: { candidates: [], unsure: [], notes: [] } },
} };
function render(props: Partial<React.ComponentProps<typeof SymbolResults>> = {}) {
  return renderToStaticMarkup(React.createElement(SymbolResults, { query: 'c', entry, stale: false, mapping: false, locked: false,
    onBuild() {}, onShow() {}, ...props }));
}

it.each(['', ' \n '])('renders nothing for an empty query %j, even while mapping', query => {
  expect(render({ query, mapping: true })).toBe('');
});
it('shows collection status without claiming no matches before a map exists', () => {
  const html = render({ entry: null, mapping: true });
  expect(html).toContain('aria-label="함수·클래스 검색 결과"');
  expect(html).toContain('<p role="status" class="hint">함수·클래스 이름을 모으는 중…</p>');
  expect(html).not.toContain('일치하는 함수·클래스가 없어요.');
  expect(html).not.toContain('이름 모으기');
});
it('offers name collection before the first map', () => {
  const html = render({ entry: null });
  expect(html).toContain('함수·클래스 이름은 지도를 만들 때 함께 모아요.');
  expect(html).toContain('<button type="button" class="btn btn--small">이름 모으기</button>');
  expect(html).not.toContain('일치하는 함수·클래스가 없어요.');
  expect(render({ entry: null, locked: true })).toContain('<button type="button" class="btn btn--small" disabled="">이름 모으기</button>');
});
it('shows one-letter matches, names, kinds and path with start line', () => {
  const html = render();
  expect(html).toContain('함수·클래스 · 2개');
  expect(html).toContain('<button type="button" class="files__item" title="C">C</button><span class="symbol-results__place">클래스 · src/a.py:1</span>');
  expect(html).toContain('<button type="button" class="files__item" title="C.f">C.f</button><span class="symbol-results__place">함수 · src/a.py:3</span>');
  expect(render({ query: 'f' })).toContain('함수·클래스 · 1개');
  expect(html).toContain('지도가 읽은 TS/JS·Python 파일에서 찾아요.');
  expect(html).not.toContain('빠진 이름이 있어요.');
  expect(html).not.toContain('지도를 만든 뒤 파일이 바뀌었어요.');
});
it('reports no matches only when a map exists', () => {
  const html = render({ query: 'missing' });
  expect(html).toContain('함수·클래스 · 0개');
  expect(html).toContain('일치하는 함수·클래스가 없어요.');
  expect(html).not.toContain('<ul>');
});
it('lists 50 of the total matches and explains the remainder', () => {
  const symbols = Array.from({ length: 52 }, (_, i) => ({ ...entry.map.symbols[0], startUtf16: i }));
  const html = render({ entry: { ...entry, map: { ...entry.map, symbols } } });
  expect(html).toContain('함수·클래스 · 52개');
  expect(html.match(/<li>/g)).toHaveLength(50);
  expect(html).toContain('처음 50개만 보여요. 나머지 2개는 검색어를 더 적어 주세요.');
  expect(render()).not.toContain('처음 50개만');
});
it.each(['limited', 'symbolsCut'] as const)('explains missing names for %s', flag => {
  expect(render({ entry: { ...entry, map: { ...entry.map, [flag]: true } } })).toContain('끝까지 읽지 못한 파일이나 빠진 이름이 있어요.');
});
it.each(['partial', 'failed', 'skipped'] as MapFile['checked'][])('explains missing names for a %s file without a global limit', checked => {
  const map = { ...entry.map, files: [{ ...entry.map.files[0], checked }] };
  expect(map.limited).toBe(false);
  expect(map.symbolsCut).toBe(false);
  expect(render({ entry: { ...entry, map } })).toContain('끝까지 읽지 못한 파일이나 빠진 이름이 있어요.');
});
it('explains stale names and disables each result while locked', () => {
  const html = render({ stale: true, locked: true });
  expect(html).toContain('지도를 만든 뒤 파일이 바뀌었어요. 이름과 위치가 지금과 다를 수 있어요.');
  expect(html.match(/<button type="button" class="files__item" disabled=""/g)).toHaveLength(2);
});
it('keeps previous results while rebuilding the map', () => {
  const html = render({ mapping: true });
  expect(html).toContain('함수·클래스 이름을 모으는 중…');
  expect(html).toContain('함수·클래스 · 2개');
  expect(html).toContain('title="C.f">C.f</button>');
});
