import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { OutlineLists } from '../src/renderer/outline-lists';
import type { Analysis, Evidence } from '../src/shared/contracts';

const evidence = (id: string, startLine = 1, endLine = startLine): Evidence => ({
  id, projectId: 'p', fileId: 'f', fileHash: 'h', startUtf16: 0, endUtf16: 10, startLine, endLine,
});
const analysis: Analysis = { language: 'python', symbols: [], warnings: [],
  classes: [
    { name: 'Model', bases: '(BaseModel)', evidence: evidence('model-range', 3, 6) },
    { name: 'Item', bases: '', evidence: evidence('item-range', 8, 9) },
  ],
  imports: [{ text: 'from package import (\n    first,\tsecond,\n)', evidence: evidence('import-range', 1, 4) }],
};
const render = (props: Partial<React.ComponentProps<typeof OutlineLists>> = {}) =>
  renderToStaticMarkup(React.createElement(OutlineLists, { analysis, locked: false, current: null, onShow() {}, ...props }));

it.each([undefined, []])('renders nothing without imports and with classes=%j', classes => {
  expect(render({ analysis: { language: 'python', symbols: [], warnings: [], imports: [], classes } })).toBe('');
});

it('shows class names, base lists and ranges with the outline row markup', () => {
  const html = render({ analysis: { ...analysis, imports: [] } });
  expect(html).toContain('<h4 class="eyebrow">클래스 2개</h4><ul class="symbols">');
  expect(html).toContain('<li class="symbols__row"><button class="symbols__item" aria-pressed="false">Model</button><span class="symbols__meta">(BaseModel) · 3–6행</span></li>');
  expect(html).toContain('<li class="symbols__row"><button class="symbols__item" aria-pressed="false">Item</button><span class="symbols__meta">8–9행</span></li>');
  expect(html).not.toContain('<details');
});

it('folds imports and collapses multiline whitespace while showing the starting line', () => {
  const html = render({ analysis: { ...analysis, classes: undefined } });
  expect(html).not.toContain('<h4');
  expect(html).toContain('<details><summary class="eyebrow">import 1개</summary><ul class="symbols">');
  expect(html).toContain('title="from package import ( first, second, )">from package import ( first, second, )</button>');
  expect(html).toContain('<span class="symbols__meta">1행</span>');
});

it.each([80, 81])('clips an import of %i characters and keeps the full title', length => {
  const text = 'import ' + 'x'.repeat(length - 7);
  const html = render({ analysis: { ...analysis, imports: [{ text, evidence: evidence('long') }] } });
  const label = length > 80 ? text.slice(0, 80) + '…' : text;
  expect(html).toContain(`title="${text}">${label}</button>`);
});

it.each(['model-range', 'item-range', 'import-range', 'unlisted'])('marks only the current evidence row: %s', id => {
  const html = render({ current: evidence(id) });
  const buttons = html.match(/<button\b[^>]*>[^<]*<\/button>/g)!;
  expect(buttons.map(button => button.includes('aria-pressed="true"')))
    .toEqual(['model-range', 'item-range', 'import-range'].map(row => row === id));
});

it.each([false, true])('sets every row disabled=%s', locked => {
  const buttons = render({ locked }).match(/<button\b[^>]*>/g)!;
  expect(buttons).toHaveLength(3);
  expect(buttons.every(button => button.includes('disabled=""') === locked)).toBe(true);
});

it('dispatches each row evidence on click and uses its evidence id as the row key', () => {
  const onShow = vi.fn();
  const pending: React.ReactNode[] = [OutlineLists({ analysis, locked: false, current: null, onShow })];
  const buttons: { children?: React.ReactNode; onClick?: () => void }[] = [];
  const keys: (string | null)[] = [];
  while (pending.length) {
    const item = pending.shift();
    if (Array.isArray(item)) { pending.push(...item); continue; }
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(item)) continue;
    if (item.type === 'li') keys.push(item.key);
    if (item.type === 'button') buttons.push(item.props);
    pending.push(item.props.children);
  }
  const rows = [
    ['Model', analysis.classes![0].evidence], ['Item', analysis.classes![1].evidence],
    ['from package import ( first, second, )', analysis.imports[0].evidence],
  ] as const;
  for (const [label, range] of rows) {
    buttons.find(button => button.children === label)!.onClick!();
    expect(onShow).toHaveBeenLastCalledWith(range);
    expect(keys).toContain(range.id);
  }
  expect(onShow).toHaveBeenCalledTimes(3);
});

it('shows the first 300 imports and counts the omitted rows', () => {
  const imports = Array.from({ length: 301 }, (_, i) => ({ text: `import module${i}`, evidence: evidence(`import-${i}`) }));
  const html = render({ analysis: { ...analysis, classes: [], imports } });
  expect(html).toContain('import 301개</summary>');
  expect(html.match(/<li class="symbols__row">/g)).toHaveLength(300);
  expect(html).toContain('>import module299</button>');
  expect(html).not.toContain('import module300');
  expect(html).toContain('처음 300개만 보여요. 나머지 1개는 생략했어요.');
});
