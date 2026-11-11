import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { OverviewReview } from '../src/renderer/overview';
import type { MapEntry } from '../src/renderer/project-map';

const entry: MapEntry = { revision: 0, build: 1, map: {
  symbols: [], symbolsCut: false,
  projectId: 'project', files: [], edges: [], external: [], exports: [], notes: [], limited: false,
  unused: { candidates: [{ fileId: 'unused', relativePath: 'unused.ts' }], unsure: [], excluded: [], notes: [],
    exports: { candidates: [], unsure: [], notes: [] } },
  complexFunctions: Array.from({ length: 2 }, (_, index) => ({ fileId: `complex-${index}`, fileHash: 'hash',
    name: 'complex', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 60, lines: 60, depth: 1 })),
  unresolved: Array.from({ length: 3 }, (_, index) => ({ fromFileId: `import-${index}`, fileHash: 'hash',
    startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: "import './missing'", specifier: './missing',
    reason: 'not-found', candidates: [] })),
} };

function render(value: MapEntry | null = entry, stale = false, mapping = false) {
  return renderToStaticMarkup(React.createElement(OverviewReview, {
    entry: value, stale, mapping, onBuild() {}, onOpen() {},
  }));
}

it('names its region with the small 살펴볼 곳 heading', () => {
  const html = render();
  const titleId = html.match(/<section class="card overview-review" aria-labelledby="([^"]+)"/)?.[1];
  expect(titleId).toBeTruthy();
  expect(html).toContain(`<p class="eyebrow" id="${titleId}">살펴볼 곳</p>`);
});

it.each([false, true])('shows only counting status while building, including stale=%s', stale => {
  const html = render(entry, stale, true);
  expect(html).toContain('<p role="status">세는 중…</p>');
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('아직 세지 않았어요.');
});

it.each([false, true])('shows three counts and the map button, limited=%s', limited => {
  const html = render({ ...entry, map: { ...entry.map, limited } });
  expect(html).toContain('<span>아무도 가져다 쓰지 않는 파일 후보</span><b>1</b>');
  expect(html).toContain('<span>어려운 코드 살펴볼 곳</span><b>2</b>');
  expect(html).toContain('<span>확인 못 한 import</span><b>3</b>');
  expect(html.match(/<b>/g)).toHaveLength(3);
  expect(html).toContain('class="btn btn--small">프로젝트 지도에서 보기</button>');
  expect(html.includes('<p class="hint">일부 파일만 확인했어요.</p>')).toBe(limited);
  expect(html).not.toContain('export 후보');
});

it('shows zero counts for an empty map', () => {
  const html = render({ ...entry, map: { ...entry.map, complexFunctions: [], symbols: [], symbolsCut: false, unresolved: [],
    unused: { ...entry.map.unused, candidates: [] } } });
  expect(html.match(/<b>0<\/b>/g)).toHaveLength(3);
});

it('hides all old counts and the open button after files change', () => {
  const html = render(entry, true);
  expect(html).toContain('<p class="hint">파일이 바뀌어 다시 세야 해요.</p>');
  expect(html).toContain('class="btn btn--small">다시 세기</button>');
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('아무도 가져다 쓰지 않는 파일 후보');
  expect(html).not.toContain('프로젝트 지도에서 보기');
});

it.each([false, true])('offers counting when no map exists, stale=%s', stale => {
  const html = render(null, stale);
  expect(html).toContain('<p class="hint">아직 세지 않았어요.</p>');
  expect(html).toContain('class="btn btn--small">세기</button>');
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('다시 세기');
});
