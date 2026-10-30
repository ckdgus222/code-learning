import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FileUse } from '../src/renderer/screen-groups';
import type { CallSite, FunctionCalls, MapImport, ProjectRoutes } from '../src/shared/contracts';
import { FileGuideCard } from '../src/renderer/file-guide';
import { describeFile } from '../src/core/analysis/file-guide';
import { analyzeSource } from '../src/core/analysis/syntax';
import { functionDoes } from '../src/renderer/guide-facts';

const emptyFacts = {
  open: true, onToggle() {},
  ai: { state: 'ready' as const, bySymbol: new Map<string, string>() },
  importers: { state: 'ready' as const, stale: false, result: { files: [], ambiguous: [], unread: [], limitedMap: false } },
  does: { bySymbol: new Map(), changed: false, notes: { routes: [], flows: [] } },
  doesState: { routes: 'none' as const, flows: false }, callers: null,
  onBuildMap() {}, onCancelMap() {}, onShowImport() {}, onFindCallers() {}, onCancelCallers() {}, onShowCallSite() {}, pathOf: (id: string) => id,
};

const emptyUses = { state: 'none' as const, uses: [], changed: false, routes: null };

const text = "import a from './a';\nexport * from 'b';\n\nexport * from 'c';\n"
  + Array.from({ length: 82 }, (_, i) => `export function run${i}() { return ${i}; }`).join('\n') + '\nconst broken = ;';
const analysis = analyzeSource(text, 'guide.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
const guide = describeFile(text, 'guide.ts', 'f', 'h', analysis, [{ id: 'imported-a', relativePath: 'a.ts', size: 0 }]);

it.each([
  ['db.post.delete()', 'post 지우기'], ['db .post.delete()', 'post 지우기'],
  ['articleREPOSITORY.save(article)', 'article 없으면 새로 저장하고 있으면 바꾸기'],
  ['this.repo.save(article)', 'repository 없으면 새로 저장하고 있으면 바꾸기'],
  ['dbClient.post.delete()', null],
])('finds named stores in file guidance and labels each guess once: %s', (call, label) => {
  const text = `export function save() { ${call}; }`;
  const analysis = analyzeSource(text, 'service.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
  const guide = describeFile(text, 'service.ts', 'f', 'h', analysis, []);
  expect(guide.functions.flatMap(fn => fn.stores)).toHaveLength(label ? 1 : 0);
  const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts,
    uses: emptyUses, onUse() {}, guide, analysis, onOpenFile() {}, busy: false, stale: false, onShow() {}, onSelect() {} }));
  expect(html.match(/\(이름으로 추정\)/g) ?? []).toHaveLength(label ? 1 : 0);
  if (!label) return;
  expect(html).toContain(`${label} (이름으로 추정) (1행)`);
  expect(html).not.toContain(`${label} (이름으로 추정) · 모양으로 판단`);
});

describe('file guide card', () => {
  it.each([false, true])('renders the disclosure with open=%s', open => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, open,
      uses: emptyUses, onUse() {}, guide, analysis, onOpenFile() {}, busy: false, stale: false, onShow() {}, onSelect() {} }));
    const disclosure = html.match(/^<details[^>]*>/)![0];
    expect(disclosure.includes('open=""')).toBe(open);
    expect(disclosure).toContain('aria-label="이 파일은"');
    expect(html).toContain('자세한 문장 설명은 AI 칸의 ‘AI로 이 파일 설명 만들기’에서 만들 수 있어요.');
  });

  it('shows eight function cards, imports and limitations before the collapsed other code', () => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, uses: emptyUses, onUse() {}, guide, analysis, onOpenFile() {}, busy: false, stale: false, onShow() {}, onSelect() {} }));
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
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, uses: emptyUses, onUse() {}, guide, analysis, onOpenFile() {}, ...state, onShow() {}, onSelect() {} }));
    expect(html).toContain('a.ts 열기</button>');
    const buttons = html.match(/<button[^>]*>/g)!;
    expect(buttons.length).toBeGreaterThan(8);
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
  });

  it('omits missing ranges and exports, and renders source strings as plain text', () => {
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, uses: emptyUses, onUse() {}, analysis, onOpenFile() {}, guide: { ...guide,
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
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
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
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
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
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
      onShow() {}, onSelect() {}, onOpenFile() {} }));
    expect(html.indexOf(warning)).toBeGreaterThan(-1);
    expect(html.indexOf(warning)).toBeLessThan(html.indexOf('이 파일의 함수'));
  });

  it('keeps symbol facts and buttons when no exact syntax match exists and clips parameters', () => {
    const source = 'function run(\n first: string,\n second: number,\n third: VeryLongParameterTypeName,\n fourth: string\n) { call(); }';
    const analysis = analyzeSource(source, 'example.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
    const guide = { ...describeFile(source, 'example.ts', 'f', 'h', analysis, []), functions: [] };
    const html = renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
      onShow() {}, onSelect() {}, onOpenFile() {} }));
    const params = analysis.symbols[0].params.replace(/\s+/g, ' ').trim().slice(1, -1).trim();
    expect(html).toContain(`받는 것: ${params.slice(0, 60)}…`);
    expect(html).toContain('<strong>run</strong>');
    expect(html).toContain('이 함수 고르기');
    expect(html).toContain('크기:');
    expect(html).not.toContain('부르는 것:');
  });
});

describe('file guide AI function summaries', () => {
  const source = 'function run() {}\nfunction other() {}';
  const analysis = analyzeSource(source, 'example.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
  const guide = describeFile(source, 'example.ts', 'f', 'h', analysis, []);
  const symbolId = analysis.symbols[0].id;
  type Props = React.ComponentProps<typeof FileGuideCard>;
  const render = (props: Partial<Props> = {}) => renderToStaticMarkup(React.createElement(FileGuideCard, {
    ...emptyFacts, guide, analysis, uses: emptyUses, busy: false, stale: false,
    onUse() {}, onShow() {}, onSelect() {}, onOpenFile() {}, ...props,
  }));
  const noneNotice = 'AI 칸의 ‘AI로 이 파일 설명 만들기’를 쓰면, AI가 요약한 함수 카드에 AI 해석을 보여 줘요.';
  const staleNotice = '파일이 바뀌어 AI 요약을 숨겼어요. 다시 만들어 주세요.';

  it('shows the AI heading, interpretation tag and text only on a summarized function', () => {
    const html = render({ ai: { state: 'ready', bySymbol: new Map([[symbolId, 'run 함수 설명']]) } });
    expect(html.match(/<h5>AI 요약<\/h5>/g)).toHaveLength(1);
    expect(html).toContain('<span class="tag tag--unknown">AI 해석</span> run 함수 설명');
    expect(html.indexOf('<strong>run</strong>')).toBeLessThan(html.indexOf('<h5>AI 요약</h5>'));
    expect(html.indexOf('<h5>AI 요약</h5>')).toBeLessThan(html.indexOf('<h5>부르는 곳</h5>'));
    expect(html.slice(html.indexOf('<strong>other</strong>'))).not.toContain('AI 요약');
    expect(html).not.toContain(noneNotice);
    expect(html).not.toContain(staleNotice);
  });
  it.each([['none', noneNotice], ['stale', staleNotice]] as const)('shows the %s notice before the function list', (state, notice) => {
    const html = render({ ai: { state, bySymbol: new Map() } });
    expect(html).toContain(notice);
    expect(html.indexOf(notice)).toBeLessThan(html.indexOf('이 파일의 함수'));
    expect(html).not.toContain('<h5>AI 요약</h5>');
  });
  it('shows no notice or AI heading for a ready result without matching summaries', () => {
    const html = render();
    expect(html).not.toContain(noneNotice);
    expect(html).not.toContain(staleNotice);
    expect(html).not.toContain('<h5>AI 요약</h5>');
  });
  it.each(['none', 'stale'] as const)('hides the %s notice for plain text', state => {
    const html = render({ analysis: { ...analysis, language: 'text', symbols: [] }, ai: { state, bySymbol: new Map() } });
    expect(html).not.toContain(noneNotice);
    expect(html).not.toContain(staleNotice);
  });
  it.each([false, true])('keeps the empty-facts message and suggests asking AI only without a summary (%s)', hasSummary => {
    const html = render({ analysis: { ...analysis, symbols: [analysis.symbols[0]] }, guide: { ...guide, functions: [] },
      ai: { state: 'ready', bySymbol: new Map(hasSummary ? [[symbolId, 'run 함수 설명']] : []) } });
    expect(html).toContain('코드에서 찾은 할 일이 없어요.');
    expect(html.includes('AI에게 물어볼 수 있어요')).toBe(!hasSummary);
    if (hasSummary) expect(html.indexOf('코드에서 찾은 할 일이 없어요.')).toBeLessThan(html.indexOf('<h5>AI 요약</h5>'));
  });
  it('renders AI markup as escaped text', () => {
    const html = render({ ai: { state: 'ready', bySymbol: new Map([[symbolId, '<b>함수 설명</b><script>bad()</script>']]) } });
    expect(html).toContain('&lt;b&gt;함수 설명&lt;/b&gt;&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script>');
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
    renderToStaticMarkup(React.createElement(FileGuideCard, { ...emptyFacts, guide, analysis, busy, stale, uses,
      onUse() {}, onOpenFile() {}, onShow() {}, onSelect() {} }));

  it.each([
    ['none', false, '기능 흐름을 아직 만들지 않았어요. 한눈에 보기에서 기능 목록을 찾으면 여기 보여요.'],
    ['stale', false, '코드가 바뀌어 기능 흐름을 다시 만들어야 해요. 한눈에 보기에서 주소를 다시 찾아 주세요.'],
    ['running', false, '기능 흐름을 만드는 중이에요.'],
    ['ready', false, '이 파일이 들어간 기능을 찾지 못했어요.'],
    ['ready', true, '파일이 바뀌어 기능 단계를 다시 찾아야 해요.'],
  ] as const)('renders %s with changed=%s', (state, changed, message) => {
    const html = render({ state, changed, uses: [], routes });
    expect(html).toContain(message);
    expect(html).not.toContain('>이 단계로</button>');
    if (changed) expect(html).not.toContain('이 파일이 들어간 기능을 찾지 못했어요.');
    if (state === 'stale') expect(html).not.toContain('아직 만들지 않았어요');
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

describe('file guide importers, actions and callers', () => {
  const source = `function login() { if (!user) throw new Error('이메일이 없어요'); prisma.user.findUnique({}); }\nfunction empty() {}`;
  const analysis = analyzeSource(source, 'auth.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' });
  const guide = describeFile(source, 'auth.ts', 'f', 'h', analysis, []);
  const symbolId = analysis.symbols[0].id;
  type Props = React.ComponentProps<typeof FileGuideCard>;
  const render = (props: Partial<Props> = {}) => renderToStaticMarkup(React.createElement(FileGuideCard, {
    ...emptyFacts, uses: emptyUses, onUse() {}, guide, analysis, busy: false, stale: false,
    onShow() {}, onSelect() {}, onOpenFile() {}, ...props,
  }));
  const item: MapImport = { fromFileId: 'from', fileHash: 'h', startUtf16: 1, endUtf16: 3, startLine: 2, endLine: 2, text: 'import', specifier: './auth' };
  const importer = { fromFileId: 'from', relativePath: 'web/x.ts', item };
  const site: CallSite = { fileId: 'web/x.ts', fileHash: 'h', startUtf16: 1, endUtf16: 3, startLine: 9, endLine: 9,
    text: 'login()', args: [], inTest: false, inFunction: null };
  const result: FunctionCalls = { projectId: 'p', fileId: 'f', fileHash: 'h', startUtf16: 0, endUtf16: source.length,
    name: 'login', calls: [], callers: [], typedCallers: [], maybeCallers: [], names: { local: ['login'], exported: [], property: [] },
    unexamined: [], values: [], limited: false, notes: [] };
  const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>${label}</button>`))![0];

  it.each([
    ['none', '프로젝트 지도를 만들면 이 파일을 가져다 쓰는 파일도 보여요.', '지도 만들어 찾기'],
    ['running', '프로젝트 지도를 만드는 중이에요.', '취소'],
    ['ready', '이 파일을 가져다 쓰는 파일을 찾지 못했어요.', null],
  ] as const)('shows %s importers and always warns about aliases', (state, message, label) => {
    const html = render({ importers: { ...emptyFacts.importers, state } });
    expect(html).toContain(message);
    if (label) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('경로 별칭(@/…)이나 실행할 때 정하는 가져오기는 따라가지 않아서 더 있을 수 있어요.');
  });
  it('shows confirmed files separately from ambiguity, caps each list and keeps stale results', () => {
    const html = render({ importers: { state: 'ready', stale: true, result: {
      files: Array.from({ length: 14 }, (_, i) => ({ ...importer, fromFileId: `${i}`, relativePath: `web/${i}.ts` })),
      ambiguous: Array.from({ length: 13 }, (_, i) => ({ ...importer, item: { ...item, startUtf16: i } })), unread: [{ relativePath: 'broken.ts', reason: '구문 오류' }], limitedMap: false,
    } } });
    expect(html).toContain('이 파일을 가져다 쓰는 파일 14개');
    expect(html).toContain('web/0.ts · 2행');
    expect(html).not.toContain('web/12.ts');
    expect(html).toContain('여럿 중 하나로 정하지 못한 가져오기 13개:');
    expect(html.match(/ 열기<\/button>/g)).toHaveLength(24);
    expect(html).toContain('외 2개');
    expect(html).toContain('외 1개');
    expect(html).toContain('끝까지 못 본 파일 1개');
    expect(html).toContain('이 파일을 가져다 쓰는 파일이 더 있을 수 있어요.');
    expect(html).toContain('지도를 만든 뒤 프로젝트가 바뀌었어요. 아래 목록은 그 전 코드 기준이에요.');
  });
  it.each([true, false])('locks map only for busy, but navigation and call searches for stale (busy=%s)', busy => {
    const html = render({ busy, stale: true, importers: { state: 'ready', stale: true,
      result: { files: [importer], ambiguous: [], unread: [], limitedMap: false } } });
    expect(button(html, '다시 찾기').includes('disabled')).toBe(busy);
    expect(button(html, 'x.ts 열기')).toContain('disabled');
    expect(button(html, '부르는 곳 찾기')).toContain('disabled');
    expect(button(html, '코드 보기')).toContain('disabled');
    const none = render({ busy, stale: true, importers: { state: 'none', stale: false, result: null } });
    expect(button(none, '지도 만들어 찾기').includes('disabled')).toBe(busy);
  });
  it('leaves both cancel buttons enabled during busy and stale states', () => {
    const html = render({ busy: true, stale: true, importers: { state: 'running', stale: false, result: null },
      callers: { symbolId, state: { status: 'finding' }, stale: false } });
    expect(html).toContain('부르는 곳을 찾는 중…');
    expect(button(html, '취소')).not.toContain('disabled');
    expect(button(html, '찾기 취소')).not.toContain('disabled');
  });
  it('renders requests, after, errors and stores in order with exact text, links and omitted warnings', () => {
    const html = render({ doesState: { routes: 'ready', flows: true }, does: { changed: false, notes: { routes: [], flows: [] },
      bySymbol: new Map([[symbolId, { requests: [
        { line: 24, text: 'POST /api/auth/login 요청을 보내요', links: [
          { text: '서버 POST /api/auth/login', inferred: false, reasons: [] },
          { text: '서버 POST /auth/login', inferred: true, reasons: ['앞 경로 추정'] },
        ] }, { line: 26, text: 'GET /missing 요청을 보내요', links: [] },
      ], after: [{ line: 27, text: '성공하면 화면 /로 이동하기' }], afterPartly: true }]]) },
      guide: { ...guide, functions: guide.functions.map(fn => ({ ...fn, stopsOmitted: 2, storesOmitted: 3 })) },
    });
    expect(html).toContain('POST /api/auth/login 요청을 보내요 (24행)');
    expect(html).toContain('→ 서버 POST /api/auth/login');
    expect(html).toContain('title="앞 경로 추정">추정 연결');
    expect(html.match(/>추정 연결</g)).toHaveLength(1);
    expect(html).toContain('서버 주소와 잇지 못했어요');
    const texts = ['요청을 보내요 (24행)', '성공하면 화면 /로 이동하기 · 모양으로 판단 (27행)',
      '“이메일이 없어요” 오류를 내요 · 조건: !user (1행)', 'user 읽기 · 모양으로 판단 (1행)'];
    for (const text of texts) expect(html).toContain(text);
    expect(texts.map(text => html.indexOf(text))).toEqual(texts.map(text => html.indexOf(text)).toSorted((a, b) => a - b));
    expect(html).toContain('일부 생략');
    expect(html).toContain('외 2개');
    expect(html).toContain('외 3개');
    expect(html).toContain('코드에서 찾은 할 일이 없어요. AI에게 물어볼 수 있어요.');
  });
  it.each([
    [{ routes: 'none', flows: false }, '서버 주소를 찾으면 함수가 보내는 요청도 여기 보여요.'],
    [{ routes: 'ready', flows: false }, '기능 흐름을 만들면 요청 뒤 할 일도 여기 보여요.'],
    [{ routes: 'stale', flows: false }, '프로젝트가 바뀌어 서버 주소를 다시 찾아야 해요.'],
  ] as const)('shows action availability above the function list: %j', (doesState, message) => {
    const html = render({ doesState });
    expect(html.indexOf(message)).toBeGreaterThan(-1);
    expect(html.indexOf(message)).toBeLessThan(html.indexOf('이 파일의 함수'));
    if (doesState.routes === 'stale') expect(html).not.toContain('기능 흐름을 만들면');
  });
  it('shows changed hashes and analysis limits above functions even without omitted after actions', () => {
    const html = render({ does: { ...emptyFacts.does, changed: true, notes: { routes: ['구문 오류 파일이 있어요.'], flows: ['여러 곳을 부르는 함수는 확인하지 않았어요.'] } } });
    for (const message of ['파일이 바뀌어 보내는 요청과 요청 뒤 할 일을 다시 찾아야 해요.',
      '일부만 확인했어요 · 이유 2개', '보내는 요청과 요청 뒤 할 일이 더 있을 수 있어요.',
      '서버 주소 찾기: 구문 오류 파일이 있어요.', '기능 흐름: 여러 곳을 부르는 함수는 확인하지 않았어요.']) {
      expect(html.indexOf(message)).toBeGreaterThan(-1);
      expect(html.indexOf(message)).toBeLessThan(html.indexOf('이 파일의 함수'));
    }
  });
  it('keeps both reason disclosures closed and renders paths and reasons as plain text', () => {
    const html = render({ importers: { state: 'ready', stale: false, result: { files: [], ambiguous: [],
      unread: [{ relativePath: 'src/<broken>.ts', reason: '<script>구문 오류</script>' }], limitedMap: true } },
    does: { ...emptyFacts.does, notes: { routes: ['주소 이유'], flows: ['흐름 이유'] } } });
    expect(html.match(/<details[^>]*><summary class="hint">/g)).toEqual([
      '<details><summary class="hint">', '<details><summary class="hint">',
    ]);
    expect(html).toContain('끝까지 못 본 파일 1개</summary>');
    expect(html).toContain('일부만 확인했어요 · 이유 2개</summary>');
    expect(html).toContain('src/&lt;broken&gt;.ts · &lt;script&gt;구문 오류&lt;/script&gt;');
    expect(html).toContain('<li>서버 주소 찾기: 주소 이유</li><li>기능 흐름: 흐름 이유</li>');
    expect(html).toContain('지도 읽기 한도에 닿아 읽지 않은 파일도 있어요.</p></details>');
    expect(html).not.toContain('한도에 닿아 일부 파일은 보지 않았어요');
  });
  it.each([1, 12, 14])('caps each disclosure at twelve rows for %s reasons', count => {
    const unread = Array.from({ length: count }, (_, i) => ({ relativePath: `src/broken${i}.ts`, reason: `구문 오류 ${i}` }));
    const reasons = Array.from({ length: count }, (_, i) => `이유 ${i}`);
    const html = render({ importers: { state: 'ready', stale: false,
      result: { files: [], ambiguous: [], unread, limitedMap: false } },
    does: { ...emptyFacts.does, notes: { routes: reasons.slice(0, 6), flows: reasons.slice(6) } } });
    const disclosures = [...html.matchAll(/<details><summary class="hint">[\s\S]*?<\/details>/g)].map(match => match[0]);
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0]).toContain(`끝까지 못 본 파일 ${count}개</summary>`);
    expect(disclosures[1]).toContain(`일부만 확인했어요 · 이유 ${count}개</summary>`);
    for (const disclosure of disclosures) {
      expect(disclosure.match(/<li>/g)).toHaveLength(Math.min(count, 12));
      if (count > 12) expect(disclosure).toContain(`외 ${count - 12}개`);
      if (count <= 12) expect(disclosure).not.toContain('외 ');
    }
    expect(disclosures[0]).toContain(`src/broken${Math.min(count, 12) - 1}.ts · 구문 오류 ${Math.min(count, 12) - 1}`);
    expect(disclosures[0]).not.toContain('src/broken12.ts');
    expect(disclosures[0]).not.toContain('지도 읽기 한도');
    expect(disclosures[1]).not.toContain('기능 흐름: 이유 12');
  });
  it('shows a map limit summary with no unread files and hides disclosures without limits', () => {
    const html = render({ importers: { state: 'ready', stale: false,
      result: { files: [], ambiguous: [], unread: [], limitedMap: true } } });
    expect(html).toContain('<details><summary class="hint">지도 읽기 한도에 닿음</summary>');
    expect(html).toContain('이 파일을 가져다 쓰는 파일이 더 있을 수 있어요.');
    expect(html).toContain('지도 읽기 한도에 닿아 읽지 않은 파일도 있어요.');
    expect(html).not.toContain('끝까지 못 본 파일 0개');
    expect(html).not.toContain('일부만 확인했어요');
    const unlimited = render();
    expect(unlimited).not.toContain('<summary class="hint">');
    expect(unlimited).not.toContain('한도에 닿아 일부 파일은 보지 않았어요');
  });
  it.each(['routes', 'flows'] as const)('shows the fallback disclosure for limited %s with empty notes', kind => {
    const routes: ProjectRoutes = { projectId: 'p', routesId: 'r', routes: [], requests: [], links: [], prefix: null, limited: true, notes: [] };
    const does = functionDoes('f', 'h', analysis.symbols, kind === 'routes' ? routes : null,
      kind === 'flows' ? [{ projectId: 'p', routesId: 'r', routeIndex: 0, nodes: [], edges: [], limited: true, notes: [] }] : null);
    const html = render({ does });
    expect(html).toContain('<details><summary class="hint">일부만 확인했어요 · 이유 1개</summary>');
    expect(html).toContain(kind === 'routes' ? '서버 주소 찾기: 서버 주소 찾기를 끝까지 하지 못했어요.'
      : '기능 흐름: 기능 흐름 일부를 끝까지 확인하지 못했어요.');
  });
  it('shows failures and locks retry, while another card keeps its own search button', () => {
    const html = render({ stale: true, callers: { symbolId, stale: false, state: { status: 'failed', message: '찾기 실패' } } });
    expect(html).toContain('찾기 실패');
    expect(button(html, '다시 찾기')).toContain('disabled');
    expect(html.match(/>부르는 곳 찾기<\/button>/g)).toHaveLength(1);
    const other = render({ callers: { symbolId: 'old', stale: false, state: { status: 'failed', message: '옛 결과' } } });
    expect(other).not.toContain('옛 결과');
    expect(other.match(/>부르는 곳 찾기<\/button>/g)).toHaveLength(2);
  });
  it.each([null, []])('distinguishes unnamed functions from no confirmed callers (%j)', callers => {
    const html = render({ callers: { symbolId, stale: false, state: { status: 'done', result: { ...result, callers } } } });
    expect(html).toContain(callers === null ? '이름이 없는 함수라 부르는 곳을 찾지 않았어요.' : '확정한 부르는 곳이 없어요.');
  });
  it('separates and limits confirmed and typed callers, shows tests and class-body calls, and summarizes uncertainty', () => {
    const html = render({ callers: { symbolId, stale: true, state: { status: 'done', result: { ...result,
      callers: Array.from({ length: 6 }, (_, i) => ({ ...site, startUtf16: i, inTest: true })),
      typedCallers: Array.from({ length: 7 }, (_, i) => ({ ...site, startUtf16: i, basis: 'Auth 타입',
        inFunction: i ? null : { name: 'useAuth', startUtf16: 0, endUtf16: 10, startLine: 1 } })),
      maybeCallers: [{ ...site, reason: 'member', detail: null }, { ...site, reason: 'member', detail: null }],
      unexamined: [{ fileId: 'skipped', relativePath: 'skipped.ts', reason: '한도' }],
    } } } });
    expect(html).toContain('web/x.ts 9행 · 함수 밖(파일 최상위·클래스 본문)');
    expect(html).toContain('web/x.ts 9행 · useAuth 안');
    expect(html).toContain('시험 코드');
    expect(html).toContain('title="Auth 타입">타입으로 찾음');
    expect(html.match(/>호출 위치<\/button>/g)).toHaveLength(10);
    expect(html.match(/>타입으로 찾음</g)).toHaveLength(5);
    expect(html).toContain('외 1개');
    expect(html).toContain('외 2개');
    expect(html).toContain('이름이 같지만 잇지 못한 호출 2개 · 함수 흐름 화면에서 자세히 볼 수 있어요');
    expect(html).toContain('보지 못한 파일 1개가 있어 더 있을 수 있어요.');
    expect(html).toContain('찾은 뒤 프로젝트가 바뀌었어요. 다시 찾아 주세요.');
    expect(button(html, '다시 찾기')).not.toContain('disabled');
  });
  it.each([{ busy: true, stale: false }, { busy: false, stale: true }])('locks call sites and stale result retry for %j', state => {
    const html = render({ ...state, callers: { symbolId, stale: true,
      state: { status: 'done', result: { ...result, callers: [site] } } } });
    expect(button(html, '호출 위치')).toContain('disabled');
    expect(button(html, '다시 찾기')).toContain('disabled');
  });
});
