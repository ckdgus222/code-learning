import React from 'react';
import * as ReactHooks from 'react';
import * as JSX from 'react/jsx-dev-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReadingStep } from '../src/shared/contracts';
import type { MapEntry } from '../src/renderer/project-map';
import { ReadingOrderCard, READING_SHOWN } from '../src/renderer/overview';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...actual, jsxDEV: vi.fn(actual.jsxDEV) };
});
afterEach(() => vi.clearAllMocks());

const steps: ReadingStep[] = Array.from({ length: 12 }, (_, index) => index === 0
  ? { kind: 'start', fileId: `file-${index}`, reaches: 11 }
  : { kind: 'next', fileId: `file-${index}`, depth: index, usedBy: 1 });
const entry: MapEntry = { revision: 0, build: 1, map: {
  projectId: 'project', files: steps.map(step => ({ id: step.fileId, relativePath: `src/nested/${step.fileId}.ts`, folder: 'src/nested',
    start: false, entry: false, checked: 'full', reason: null })),
  edges: [], unresolved: [], external: [], complexFunctions: [], symbols: [], symbolsCut: false, exports: [], limited: false, notes: [],
  unused: { candidates: [], unsure: [], excluded: [], notes: [], exports: { candidates: [], unsure: [], notes: [] } },
  reading: { steps, total: 12, incomplete: false },
} };
function render(props: Partial<React.ComponentProps<typeof ReadingOrderCard>> = {}) {
  return renderToStaticMarkup(React.createElement(ReadingOrderCard, {
    entry, stale: false, mapping: false, locked: false, onBuild() {}, onOpenFile() {}, ...props,
  }));
}
const buttons = () => vi.mocked(JSX.jsxDEV).mock.results.map(result => result.value as React.ReactElement<{
  children: React.ReactNode; className: string; onClick(): void;
}>).filter(element => element.type === 'button');
const incompleteNotice = '지도가 다 보지 못한 import가 있어 순서가 달라질 수 있어요.';

it('labels its section with the reading order heading', () => {
  const html = render();
  const id = html.match(/<section class="card overview-starts" aria-labelledby="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(html).toContain(`<h3 id="${id}">이 순서로 읽어 보세요</h3>`);
});

it.each([null, entry])('shows only progress while mapping, even with stale data', value => {
  const html = render({ entry: value, stale: true, mapping: true });
  expect(html).toContain('<p role="status">순서를 정하는 중…</p>');
  expect(html).not.toContain('<ol');
  expect(html).not.toContain('<button');
});

it.each([false, true])('offers a first build without a map, stale=%s', stale => {
  const onBuild = vi.fn();
  const html = render({ entry: null, stale, onBuild });
  expect(html).toContain('아직 정하지 않았어요.');
  expect(html).toContain('>순서 정하기</button>');
  expect(html).not.toContain('<ol');
  buttons()[0].props.onClick();
  expect(onBuild).toHaveBeenCalledExactlyOnceWith();
});

it('hides old steps and rebuilds a stale map', () => {
  const onBuild = vi.fn();
  const html = render({ stale: true, onBuild });
  expect(html).toContain('파일이 바뀌어 다시 정해야 해요.');
  expect(html).toContain('>다시 정하기</button>');
  expect(html).not.toContain('<ol');
  expect(html).not.toContain('src/nested');
  buttons()[0].props.onClick();
  expect(onBuild).toHaveBeenCalledExactlyOnceWith();
});

it.each([false, true])('explains an empty result and incomplete=%s', incomplete => {
  const html = render({ entry: { ...entry, map: { ...entry.map, reading: { steps: [], total: 0, incomplete } } } });
  expect(html).toContain('import 연결로는 시작 파일을 정하지 못했어요. 위 ‘어디부터 읽을까요?’나 코드 읽기에서 파일을 골라 보세요.');
  expect(html.includes(incompleteNotice)).toBe(incomplete);
  expect(html).not.toContain('<ol');
  expect(html).not.toContain('최대 3개');
});

it('shows ten numbered full paths, both kinds of explanation and the remaining count', () => {
  const onOpenFile = vi.fn();
  const html = render({ onOpenFile });
  expect(READING_SHOWN).toBe(10);
  expect(html).toContain('<ol class="starts">');
  expect(html.match(/<li>/g)).toHaveLength(10);
  expect(html).toContain('<b>1.</b> <span class="path">src/nested/file-0.ts</span>');
  expect(html).toContain('<b>10.</b> <span class="path">src/nested/file-9.ts</span>');
  expect(html).not.toContain('src/nested/file-10.ts');
  expect(html).toContain('시작 파일 후보 · 파일 11개로 이어져요');
  expect(html).toContain('시작에서 1걸음 · 파일 1개가 가져다 써요');
  expect(html).toContain('>2개 더 보기</button>');
  expect(html).toContain('최대 3개');
  expect(html).toContain('시험·설정·타입 선언 파일은 뺐고, 확정된 import만 셌어요. 실제 실행 순서가 아니라 읽기 추천이에요.');
  buttons().filter(button => button.props.className === 'starts__item')[1].props.onClick();
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('file-1');
});

it('reveals every step after the more button and removes that button', () => {
  const setShowAll = vi.fn();
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [false, setShowAll]);
  render();
  buttons().find(button => button.props.className === 'btn btn--small')!.props.onClick();
  expect(setShowAll).toHaveBeenCalledExactlyOnceWith(true);
  vi.mocked(ReactHooks.useState).mockImplementationOnce(() => [setShowAll.mock.calls[0][0], setShowAll]);
  const html = render();
  expect(html.match(/<li>/g)).toHaveLength(12);
  expect(html).toContain('<b>12.</b> <span class="path">src/nested/file-11.ts</span>');
  expect(html).not.toContain('더 보기');
});

it('does not offer more for exactly ten steps', () => {
  const html = render({ entry: { ...entry, map: { ...entry.map, reading: { steps: steps.slice(0, 10), total: 10, incomplete: false } } } });
  expect(html.match(/<li>/g)).toHaveLength(10);
  expect(html).not.toContain('더 보기');
});

it.each([12, 40])('explains truncation only when total=%i exceeds all stored steps', total => {
  const html = render({ entry: { ...entry, map: { ...entry.map, reading: { ...entry.map.reading, total } } } });
  expect(html.includes(`시작 파일에서 이어지는 파일 ${total}개 중 앞의 12개예요.`)).toBe(total > 12);
});

it.each([false, true])('uses only reading.incomplete=%s for the missing import notice', incomplete => {
  const html = render({ entry: { ...entry, map: { ...entry.map, limited: !incomplete,
    reading: { ...entry.map.reading, incomplete } } } });
  expect(html.includes(incompleteNotice)).toBe(incomplete);
});

it('disables every file button while locked', () => {
  const html = render({ locked: true });
  expect(html.match(/class="starts__item" disabled=""/g)).toHaveLength(10);
  expect(render()).not.toContain('disabled=""');
});

it('omits steps without a mapped file and keeps visible numbering consecutive', () => {
  const html = render({ entry: { ...entry, map: { ...entry.map, files: entry.map.files.slice(1, 3) } } });
  expect(html.match(/<li>/g)).toHaveLength(2);
  expect(html).toContain('<b>1.</b> <span class="path">src/nested/file-1.ts</span>');
  expect(html).toContain('<b>2.</b> <span class="path">src/nested/file-2.ts</span>');
  expect(html).not.toContain('undefined');
  expect(html).not.toContain('더 보기');
});
