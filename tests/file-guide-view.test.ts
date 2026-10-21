import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileGuideCard } from '../src/renderer/file-guide';
import { describeFile } from '../src/core/analysis/file-guide';
import { analyzeSource } from '../src/core/analysis/syntax';

const text = "import a from 'a';\nexport * from 'b';\n\nexport * from 'c';\n"
  + Array.from({ length: 82 }, (_, i) => `export function run${i}() { return ${i}; }`).join('\n') + '\nconst broken = ;';
const analysis = analyzeSource(text, 'guide.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
const guide = describeFile(text, 'guide.ts', 'f', 'h', analysis, []);

describe('file guide card', () => {
  it('shows eight rows, import display names, export count and limitations before the collapsed list', () => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { guide, busy: false, stale: false, onShow() {}, onSelect() {} }));
    expect(html).toContain('<details open=""');
    expect(html).toContain('이 파일은');
    expect(html).toContain('코드 모양으로 짐작했어요');
    expect(html).toContain('가져오기·다시 내보내기 (2줄)');
    expect(html).toContain('다시 내보내기 (1줄)');
    expect(html).toContain('외 63개');
    expect(html.match(/>코드 보기<\/button>/g)).toHaveLength(8);
    expect(html.match(/>이 함수 고르기<\/button>/g)).toHaveLength(6);
    expect(html).toContain('더 보기');
    expect(html.indexOf('덩어리 4개는 설명하지 않았어요')).toBeLessThan(html.indexOf('안의 코드'));
    expect(html.indexOf('구문 오류가 있어 일부 코드는 나누지 않았어요')).toBeLessThan(html.indexOf('안의 코드'));
    expect(html).not.toContain('<strong>run6</strong>');
  });

  it.each([{ busy: true, stale: false }, { busy: false, stale: true }])('disables basis, code, function and expand buttons when %j', state => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { guide, ...state, onShow() {}, onSelect() {} }));
    const buttons = html.match(/<button[^>]*>/g)!;
    expect(buttons.length).toBeGreaterThan(8);
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
  });

  it('omits missing ranges and exports, and renders source strings as plain text', () => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { guide: { ...guide,
      role: { label: '시험 파일', about: '<script>bad()</script>', basis: { text: 'test.ts', range: null } }, exports: [], chunks: [] },
    busy: false, stale: false, onShow() {}, onSelect() {} }));
    expect(html).not.toContain('근거:');
    expect(html).not.toContain('내보내는 것:');
    expect(html).toContain('&lt;script&gt;');
  });
});
