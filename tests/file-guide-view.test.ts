import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FileUse } from '../src/renderer/screen-groups';
import type { ProjectRoutes } from '../src/shared/contracts';
import { FileGuideCard } from '../src/renderer/file-guide';
import { describeFile } from '../src/core/analysis/file-guide';
import { analyzeSource } from '../src/core/analysis/syntax';

const emptyUses = { state: 'none' as const, uses: [], changed: false, routes: null };

const text = "import a from './a';\nexport * from 'b';\n\nexport * from 'c';\n"
  + Array.from({ length: 82 }, (_, i) => `export function run${i}() { return ${i}; }`).join('\n') + '\nconst broken = ;';
const analysis = analyzeSource(text, 'guide.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
const guide = describeFile(text, 'guide.ts', 'f', 'h', analysis, [{ id: 'imported-a', relativePath: 'a.ts', size: 0 }]);

describe('file guide card', () => {
  it('shows eight function cards, imports and limitations before the collapsed other code', () => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { uses: emptyUses, onUse() {}, guide, analysis, onOpenFile() {}, busy: false, stale: false, onShow() {}, onSelect() {} }));
    expect(html).toContain('<details open=""');
    expect(html).toContain('이 파일은');
    expect(html).toContain('코드 모양으로 짐작했어요');
    expect(html).toContain('가져오기·다시 내보내기 (2줄)');
    expect(html).toContain('다시 내보내기 (1줄)');
    expect(html).toContain('외 63개');
    expect(html.match(/>코드 보기<\/button>/g)).toHaveLength(10);
    expect(html.match(/>이 함수 고르기<\/button>/g)).toHaveLength(8);
    expect(html).toContain('더 보기');
    expect(html).toContain('이 파일의 함수 82개');
    expect(html).toContain('<details><summary>그 밖의 코드 2개</summary>');
    expect(html).toContain('title="a.ts">a.ts 열기</button>');
    expect(html.indexOf('덩어리 4개는 설명하지 않았어요')).toBeLessThan(html.indexOf('이 파일의 함수'));
    expect(html.indexOf('구문 오류가 있어 일부 코드는 나누지 않았어요')).toBeLessThan(html.indexOf('이 파일의 함수'));
    expect(html).not.toContain('<strong>run8</strong>');
  });

  it.each([{ busy: true, stale: false }, { busy: false, stale: true }])('disables basis, code, function and expand buttons when %j', state => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { uses: emptyUses, onUse() {}, guide, analysis, onOpenFile() {}, ...state, onShow() {}, onSelect() {} }));
    expect(html).toContain('a.ts 열기</button>');
    const buttons = html.match(/<button[^>]*>/g)!;
    expect(buttons.length).toBeGreaterThan(8);
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
  });

  it('omits missing ranges and exports, and renders source strings as plain text', () => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { uses: emptyUses, onUse() {}, analysis, onOpenFile() {}, guide: { ...guide,
      role: { label: '시험 파일', about: '<script>bad()</script>', basis: { text: 'test.ts', range: null } }, exports: [], chunks: [] },
    busy: false, stale: false, onShow() {}, onSelect() {} }));
    expect(html).not.toContain('근거:');
    expect(html).not.toContain('내보내는 것:');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('file guide function cards', () => {
  it.each(['function outer() { function inner() {} }', 'const a = () => 1, b = () => 2;'])('renders every analyzer symbol: %s', source => {
    const analysis = analyzeSource(source, 'example.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
    const guide = describeFile(source, 'example.ts', 'f', 'h', analysis, []);
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
      onShow() {}, onSelect() {}, onOpenFile() {} }));
    expect(html).toContain(`이 파일의 함수 ${analysis.symbols.length}개`);
    expect(html.match(/>이 함수 고르기<\/button>/g)).toHaveLength(analysis.symbols.length);
    let previous = -1;
    for (const symbol of analysis.symbols) {
      const index = html.indexOf(`<strong>${symbol.name}</strong>`);
      expect(index).toBeGreaterThan(previous);
      previous = index;
      expect(html).toContain(`${symbol.evidence.startLine}–${symbol.evidence.endLine}행`);
      expect(html).toContain(`크기: ${symbol.complexity.lines}줄 · 깊이 ${symbol.complexity.depth}`);
    }
  });

  it('renders every kind as a shape judgement and labels method hook calls cautiously', () => {
    const source = "@Controller('auth') class Auth { @Post('login') login() { this.useCache(); return <div/>; } }\nfunction useThing() {}";
    const analysis = analyzeSource(source, 'example.tsx', { projectId: 'p', fileId: 'f', fileHash: 'h' });
    const guide = describeFile(source, 'example.tsx', 'f', 'h', analysis, []);
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
      onShow() {}, onSelect() {}, onOpenFile() {} }));
    expect(html).toContain('종류 표시는 코드 모양으로 판단했어요. 실제로 요청이 이어지는지는 흐름 따라가기에서 확인해요.');
    for (const tag of guide.functions.flatMap(item => item.tags)) expect(html).toContain(`${tag} · 모양으로 판단</span>`);
    expect(html).toContain('훅처럼 이름 붙인 호출: this.useCache');
    expect(html).not.toContain('쓰는 훅:');
    expect(html).toContain('받는 것: 없음');
  });

  it('shows analyzer warnings before the function title even when chunk splitting is complete', () => {
    const source = 'const callbacks = [' + Array.from({ length: 205 }, () => '() => 1').join(',') + '];';
    const analysis = analyzeSource(source, 'example.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
    const guide = describeFile(source, 'example.ts', 'f', 'h', analysis, []);
    expect(guide.limitations).toEqual([]);
    const warning = analysis.warnings.find(message => message.includes('분석량 제한'))!;
    expect(warning).toBeDefined();
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
      onShow() {}, onSelect() {}, onOpenFile() {} }));
    expect(html.indexOf(warning)).toBeGreaterThan(-1);
    expect(html.indexOf(warning)).toBeLessThan(html.indexOf('이 파일의 함수'));
  });

  it('keeps symbol facts and buttons when no exact syntax match exists and clips parameters', () => {
    const source = 'function run(\n first: string,\n second: number,\n third: VeryLongParameterTypeName,\n fourth: string\n) { call(); }';
    const analysis = analyzeSource(source, 'example.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
    const guide = { ...describeFile(source, 'example.ts', 'f', 'h', analysis, []), functions: [] };
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
      onShow() {}, onSelect() {}, onOpenFile() {} }));
    const params = analysis.symbols[0].params.replace(/\s+/g, ' ').trim().slice(1, -1).trim();
    expect(html).toContain(`받는 것: ${params.slice(0, 60)}…`);
    expect(html).toContain('<strong>run</strong>');
    expect(html).toContain('이 함수 고르기');
    expect(html).toContain('크기:');
    expect(html).not.toContain('부르는 것:');
  });
});

describe('file uses', () => {
  const routes: ProjectRoutes = { projectId: 'p', routesId: 'r', prefix: null, requests: [], links: [], limited: false, notes: [], routes: [
    { method: 'POST', path: '/api/login', framework: 'nest', prefix: 'known', basis: { text: 'Post', range: { fileId: 'back', fileHash: 'hash', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: 'Post' } },
      handler: { fileId: 'back', fileHash: 'hash', name: 'login', startUtf16: 0, endUtf16: 1, startLine: 1 } },
  ] };
  const use: FileUse = { routeIndex: 0, screen: '/login', through: 'page', storyId: 'req@page', step: 1,
    label: '프론트 처리', nodeId: 'send', other: true, inferred: true, reasons: ['주소 추정'] };
  const render = (uses: React.ComponentProps<typeof FileGuideCard>['uses'], busy = false, stale = false) =>
    renderToStaticMarkup(React.createElement(FileGuideCard, { guide, analysis, busy, stale, uses,
      onUse() {}, onOpenFile() {}, onShow() {}, onSelect() {} }));

  it.each([
    ['none', false, '기능 흐름을 아직 만들지 않았어요. 한눈에 보기에서 기능 목록을 찾으면 여기 보여요.'],
    ['running', false, '기능 흐름을 만드는 중이에요.'],
    ['ready', false, '이 파일이 들어간 기능을 찾지 못했어요.'],
    ['ready', true, '파일이 바뀌어 기능 단계를 다시 찾아야 해요.'],
  ] as const)('renders %s with changed=%s', (state, changed, message) => {
    const html = render({ state, changed, uses: [], routes });
    expect(html).toContain(message);
    expect(html).not.toContain('>이 단계로</button>');
    if (changed) expect(html).not.toContain('이 파일이 들어간 기능을 찾지 못했어요.');
  });
  it('shows route, step, other path and inference, with a twelve row limit and omitted count', () => {
    const html = render({ state: 'ready', changed: true, routes,
      uses: Array.from({ length: 14 }, (_, i) => ({ ...use, screen: i === 0 ? null : `/login${i}` })) });
    expect(html).toContain('이 파일이 나오는 기능 14개');
    expect(html).toContain('POST /api/login · 2단계 프론트 처리');
    expect(html).toContain('화면 /login1 ·');
    expect(html).toContain('다른 경로');
    expect(html).toContain('title="주소 추정">추정 연결');
    expect(html.match(/>이 단계로<\/button>/g)).toHaveLength(12);
    expect(html).toContain('외 2개');
    expect(html).not.toContain('화면 /login12');
    expect(html).toContain('파일이 바뀌어 기능 단계를 다시 찾아야 해요.');
    expect(html.indexOf('이 파일이 나오는 기능')).toBeLessThan(html.indexOf('근거:'));
  });
  it.each([[true, false], [false, true]])('locks use navigation for busy=%s stale=%s', (busy, stale) => {
    const html = render({ state: 'ready', changed: false, routes, uses: [use] }, busy, stale);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>이 단계로<\/button>/);
  });
});
