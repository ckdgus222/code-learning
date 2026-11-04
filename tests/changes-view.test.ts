import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangeList, ChangesView, type DiffEntry, type Loaded } from '../src/renderer/changes';
import type { FileChange, ProjectChanges } from '../src/shared/contracts';

const change: FileChange = { kind: 'modified', path: 'src/edit.ts', oldPath: null, fileId: 'edit' };
const result: ProjectChanges = { projectId: 'p', commit: '1234567890', changes: [change], notCompared: [], notes: [] };
const done = (value: string): Loaded<string> => ({ status: 'done', value });
const props: React.ComponentProps<typeof ChangesView> = {
  history: { status: 'done', value: { projectId: 'p', available: true, reason: null,
    commits: [{ oid: result.commit, subject: 'first', time: 0, head: true }] } },
  changes: { commit: result.commit, revision: 0, state: { status: 'done', value: result } },
  stale: false, diff: null, locked: false,
  onRetryHistory() {}, onCompare() {}, onRefresh() {}, onCancel() {}, onOpen() {}, onOpenCode() {},
};
const render = (diff: DiffEntry | null = null, overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(React.createElement(ChangesView, { ...props, diff, ...overrides }));

describe('change list', () => {
  it('counts only present kinds and selects by kind and path, without requiring object identity', () => {
    const changes: FileChange[] = [change, { ...change, kind: 'added' }, { ...change, path: 'other.ts' }];
    const html = renderToStaticMarkup(React.createElement(ChangeList, { result: { ...result, changes }, locked: true,
      selected: { ...change }, onOpen() {} }));
    expect(html).toContain('수정 2 · 추가 1');
    expect(html).not.toContain('삭제 0');
    expect(html.match(/class="change-list__selected"/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="change-list__selected"><span class="tag tag--change tag--modified"/);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('title="src/edit.ts"');
  });

  it('supports the map without optional props and preserves rename paths in titles', () => {
    const renamed: FileChange = { ...change, kind: 'renamed', oldPath: 'old.ts' };
    const html = renderToStaticMarkup(React.createElement(ChangeList, { result: { ...result, changes: [renamed] }, locked: false, onOpen() {} }));
    expect(html).not.toContain('change-list__selected');
    expect(html).toContain('title="old.ts → src/edit.ts">old.ts → src/edit.ts</span>');
  });

  it('keeps the first 300 rows and does not highlight a hidden or missing change', () => {
    const changes = Array.from({ length: 302 }, (_, i) => ({ ...change, path: `${i}.ts` }));
    const html = renderToStaticMarkup(React.createElement(ChangeList, { result: { ...result, changes }, locked: false,
      selected: changes[301], onOpen() {} }));
    expect(html.match(/<li>/g)).toHaveLength(300);
    expect(html).toContain('2개 더 보기');
    expect(html).not.toContain('change-list__selected');
    expect(render({ change: { ...change, path: 'gone.ts' }, old: done('a'), now: done('b') })).not.toContain('change-list__selected');
  });
});

it('shows the unopened comparison and moves both original help paragraphs into details', () => {
  const html = render();
  expect(html).toContain('바뀐 파일 1개');
  expect(html).toContain('class="card changes-placeholder"');
  const help = html.match(/<details class="changes-help">(.*?)<\/details>/)![1];
  expect(help).toContain('<summary>비교 방법과 한계</summary>');
  expect(help).toContain('앱은 Git의 필터·줄 끝 바꾸기를 실행하지 않고 내용 그대로 비교해요.');
  expect(help).toContain('새 커밋이나 스테이징 뒤에는 ‘다시 비교’를 눌러 주세요.');
  expect(html).toContain('class="changes-attribution">사람이 바꿨는지 AI가 바꿨는지는 가려내지 않아요.');
});

it('uses a full-width single list with no comparison placeholder for zero changes', () => {
  const html = render(null, { changes: { ...props.changes!, state: { status: 'done', value: { ...result, changes: [] } } } });
  expect(html).toContain('changes-layout--single');
  expect(html).toContain('바뀐 파일 0개');
  expect(html).toContain('고른 커밋 뒤로 바뀐 파일이 없어요.');
  expect(html).not.toContain('changes-comparison');
});

it.each([
  { history: null }, { history: { status: 'loading' } }, { history: { status: 'failed', message: 'history failed' } },
  { changes: { ...props.changes!, state: { status: 'loading' } } },
  { changes: { ...props.changes!, state: { status: 'failed', message: 'compare failed' } } },
] satisfies Partial<typeof props>[])('keeps an opened diff full width while the list is unavailable %#', overrides => {
  const html = render({ change, old: done('a'), now: done('b') }, overrides);
  expect(html).toContain('changes-layout--single');
  expect(html).toContain('aria-label="고른 변경 비교"');
  expect(html).not.toContain('aria-label="바뀐 파일 목록"');
});

describe('diff counts', () => {
  it('shows exact counts, the selected row and the commit strip for both sides', () => {
    const html = render({ change, old: done('a\n'), now: done('b\n') });
    expect(html).toContain('class="diff-counts__added">+1</span> <span class="diff-counts__removed">−1</span>');
    expect(html).toContain('change-list__selected');
    expect(html).toContain('이전 코드 · 1234567');
    expect(html).toContain('<span>지금 코드</span>');
    expect(html).toContain('바뀌지 않은 부분은 접어요');
  });

  it.each(['added', 'untracked', 'deleted'] as const)('counts only the existing side of %s, even above the edit budget', kind => {
    const deleted = kind === 'deleted';
    const html = render({ change: { ...change, kind }, old: deleted ? done('a\n'.repeat(1001)) : null,
      now: deleted ? null : done('a\n'.repeat(1001)) });
    expect(html).toContain(deleted ? 'class="diff-counts__removed">−1001' : 'class="diff-counts__added">+1001');
    expect(html).not.toContain(deleted ? 'diff-counts__added' : 'diff-counts__removed');
    expect(html).not.toContain('diff-columns');
    expect(html).not.toContain('바뀌지 않은 부분은 접어요');
  });

  it.each(['old', 'now'] as const)('hides all counts when %s is failed or loading', side => {
    for (const unavailable of [{ status: 'failed', message: 'cannot read' }, { status: 'loading' }] satisfies Loaded<string>[]) {
      const html = render({ change, old: done('a'), now: done('b'), [side]: unavailable });
      expect(html).not.toContain('class="diff-counts"');
      expect(html).not.toContain('diff-columns');
    }
  });

  it('does not treat a missing modified side as an empty file', () => {
    expect(render({ change, old: null, now: done('b') })).not.toContain('class="diff-counts"');
  });

  it('shows omission instead of approximate numbers above the edit budget', () => {
    const html = render({ change, old: done('a\n'.repeat(501)), now: done('b\n'.repeat(501)) });
    expect(html).toContain('title="바뀐 줄이 너무 많아 줄 수를 세지 않았어요.">줄 수 생략');
    expect(html).not.toContain('diff-counts__added');
    expect(html).not.toContain('diff-counts__removed');
  });
});
