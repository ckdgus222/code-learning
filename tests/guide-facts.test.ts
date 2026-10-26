import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/core/analysis/syntax';
import { aiFunctionSummaries, functionDoes, importersOf } from '../src/renderer/guide-facts';
import type { FeatureFlow, FlowNode, MapImport, ProjectMap, ProjectRoutes, Request } from '../src/shared/contracts';
import type { FileExplanationResult } from '../src/shared/ai';

const site = { fileId: 'f', fileHash: 'h', startUtf16: 10, endUtf16: 15, startLine: 2, endLine: 2, text: 'send()' };
const imported: MapImport = { ...site, fromFileId: 'a', specifier: './target' };
const map: ProjectMap = { projectId: 'p', files: ['target', 'a', 'b'].map(id => ({ id, relativePath: `${id}.ts`, folder: '',
  start: false, checked: 'full', reason: null })), edges: [], unresolved: [], external: [], complexFunctions: [], limited: false, notes: [] };

describe('importersOf', () => {
  it('keeps only incoming edges, the earliest import per file and path order', () => {
    const result = importersOf('target', 'target.ts', { ...map, edges: [
      { ...imported, fromFileId: 'b', toFileId: 'target' },
      { ...imported, toFileId: 'target', startUtf16: 40, startLine: 8 },
      { ...imported, toFileId: 'target' },
      { ...imported, fromFileId: 'target', toFileId: 'a' },
    ] });
    expect(result.files.map(file => [file.relativePath, file.item.startLine])).toEqual([['a.ts', 2], ['b.ts', 2]]);
    expect(result.unread).toEqual([]);
    expect(result.limitedMap).toBe(false);
  });
  it('separates ambiguous candidates by full relative path and does not call them confirmed', () => {
    const result = importersOf('target', 'target.ts', { ...map, unresolved: [
      { ...imported, reason: 'ambiguous', candidates: ['target.ts', 'target/index.ts'] },
      { ...imported, reason: 'ambiguous', candidates: ['elsewhere/target.ts'] },
      { ...imported, reason: 'not-found', candidates: ['target.ts'] },
    ] });
    expect(result.files).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].item).toMatchObject({ reason: 'ambiguous', startLine: 2 });
  });
  it.each(['partial', 'failed', 'skipped'] as const)('marks %s code files as partly checked', checked => {
    expect(importersOf('target', 'target.ts', { ...map, files: [{ ...map.files[0], checked }] })).toMatchObject({
      unread: [{ relativePath: 'target.ts', reason: '끝까지 보지 못했어요' }], limitedMap: false,
    });
  });
  it('keeps non-code files out of the partial warning, but reports the map limit', () => {
    expect(importersOf('target', 'target.ts', { ...map, files: [{ ...map.files[0], checked: 'not-code' }] }))
      .toMatchObject({ unread: [], limitedMap: false });
    expect(importersOf('target', 'target.ts', { ...map, limited: true })).toMatchObject({ unread: [], limitedMap: true });
  });
  it('keeps every unread path and reason in path order without clipping the result', () => {
    const unread = Array.from({ length: 14 }, (_, i) => ({ ...map.files[0], id: `${i}`,
      relativePath: `src/file${String(i).padStart(2, '0')}.ts`, checked: 'partial' as const, reason: `구문 오류 ${i}` }));
    const result = importersOf('target', 'target.ts', { ...map, files: [...unread.toReversed(), ...map.files] });
    expect(result.unread).toEqual(unread.map(file => ({ relativePath: file.relativePath, reason: file.reason })));
    expect(result.limitedMap).toBe(false);
  });
});

const symbols = analyzeSource('function a() { function same() { send(); } }\nfunction b() { function same() { send(); } }\nfunction outer() { useEffect(() => send()); }',
  'front.ts', { projectId: 'p', fileId: 'f', fileHash: 'h' }).symbols;
const request = (index: number, changes: Partial<Request> = {}): Request => ({ ...site, args: [], inTest: false,
  inFunction: { ...symbols[index].evidence, name: symbols[index].name }, path: '/login', host: null, prefix: 'known', methods: ['POST'], ...changes });
const routes: ProjectRoutes = { projectId: 'p', routesId: 'r', requests: [], routes: [{ method: 'POST', path: '/login',
  prefix: 'known', framework: 'nest', handler: { ...site, name: 'login' }, basis: { text: 'Post', range: site } }], links: [], prefix: null, limited: false, notes: [] };
const front: FlowNode = { id: 'front', side: 'front', depth: 0, fileId: 'f', fileHash: 'h', relativePath: 'front.ts', name: symbols[1].name,
  range: symbols[1].evidence, event: null, control: null, asks: [], screen: null, outside: [], outsideOmitted: 0, stops: [], stopsOmitted: 0,
  stores: [], storesOmitted: 0, after: [{ when: 'success', action: 'navigate', target: '/', site }], afterOmitted: 0 };
const flow: FeatureFlow = { projectId: 'p', routesId: 'r', routeIndex: 0, nodes: [front], edges: [], limited: false, notes: [] };

describe('aiFunctionSummaries', () => {
  const chunk = { id: 'chunk', kind: 'function' as const, name: symbols[1].name,
    range: symbols[1].evidence, functionRange: { startUtf16: symbols[1].evidence.startUtf16, endUtf16: symbols[1].evidence.endUtf16 } };
  const result: FileExplanationResult = { jobId: 'job', projectId: 'p', relativePath: 'front.ts', range: site,
    chunks: [chunk], explanation: { summary: '파일 설명', chunks: [{ chunkId: chunk.id, summary: '함수 설명' }], unknowns: [] },
    mode: 'codex', review: 'AI 대조 없음', models: [], limitations: [] };

  it.each([false, true])('returns none without a result even when stale is %s', stale => {
    expect(aiFunctionSummaries(null, stale, symbols)).toEqual({ state: 'none', bySymbol: new Map() });
  });
  it('drops every summary when the result is stale', () => {
    expect(aiFunctionSummaries(result, true, symbols)).toEqual({ state: 'stale', bySymbol: new Map() });
  });
  it('matches an exact range, not a shared name or a containing function', () => {
    expect(symbols[1].name).toBe(symbols[3].name);
    expect(aiFunctionSummaries(result, false, symbols)).toEqual({ state: 'ready',
      bySymbol: new Map([[symbols[1].id, '함수 설명']]) });
  });
  it.each(['startUtf16', 'endUtf16'] as const)('requires the same %s', boundary => {
    const changed = { ...chunk, functionRange: { ...chunk.functionRange, [boundary]: chunk.functionRange[boundary] + 1 } };
    expect(aiFunctionSummaries({ ...result, chunks: [changed] }, false, symbols))
      .toEqual({ state: 'ready', bySymbol: new Map() });
  });
  it('ignores chunks without a function range even when their source range matches', () => {
    expect(aiFunctionSummaries({ ...result, chunks: [{ ...chunk, functionRange: null }] }, false, symbols).bySymbol.size).toBe(0);
  });
  it('omits missing summaries and joins available summaries by chunk ID', () => {
    const other = { ...chunk, id: 'other', range: symbols[3].evidence, functionRange: symbols[3].evidence };
    const partial = { ...result, chunks: [chunk, other], explanation: { ...result.explanation,
      chunks: [{ chunkId: other.id, summary: '다른 함수 설명' }, { chunkId: 'unknown', summary: '잇지 못한 설명' }] } };
    expect(aiFunctionSummaries(partial, false, symbols).bySymbol).toEqual(new Map([[symbols[3].id, '다른 함수 설명']]));
  });
  it('does not attach a summary when no function chunk exists', () => {
    expect(aiFunctionSummaries({ ...result, chunks: [] }, false, symbols)).toEqual({ state: 'ready', bySymbol: new Map() });
  });
});

describe('functionDoes', () => {
  it('matches both ends of each function range, including callbacks, instead of names or containment', () => {
    const result = functionDoes('f', 'h', symbols, { ...routes, requests: [request(1), request(5),
      request(1, { inFunction: { ...request(1).inFunction!, endUtf16: symbols[1].evidence.endUtf16 + 1 } }),
      request(1, { inFunction: { ...request(1).inFunction!, startUtf16: symbols[1].evidence.startUtf16 + 1 } }),
      request(1, { fileId: 'other' }), request(1, { inFunction: null }),
    ] }, null);
    expect(symbols[1].name).toBe(symbols[3].name);
    expect([...result.bySymbol.values()].map(value => value.requests.length)).toEqual([0, 1, 0, 0, 0, 1]);
  });
  it('formats methods, hosts and unknown prefixes and preserves every link with its certainty and reason', () => {
    const result = functionDoes('f', 'h', symbols, { ...routes, requests: [request(1), request(1, { methods: null, host: 'https://api.test', prefix: 'unknown' }),
      request(1, { methods: ['GET', 'POST'] })], links: [
      { requestIndex: 0, routeIndex: 0, sure: true, reasons: [] },
      { requestIndex: 0, routeIndex: 0, sure: false, reasons: ['앞 경로 추정'] },
    ] }, null).bySymbol.get(symbols[1].id)!;
    expect(result.requests[0]).toEqual({ line: 2, text: 'POST /login 요청을 보내요', links: [
      { text: '서버 POST /login', inferred: false, reasons: [] }, { text: '서버 POST /login', inferred: true, reasons: ['앞 경로 추정'] },
    ] });
    expect(result.requests[1]).toMatchObject({ text: '방식 모름 https://api.test/login 요청을 보내요 (앞 경로 확인 못 함)', links: [] });
    expect(result.requests[2].text).toBe('GET·POST /login 요청을 보내요');
  });
  it('drops changed hashes and reports changes even when old ranges no longer match', () => {
    const result = functionDoes('f', 'new', symbols, { ...routes, requests: [request(1)] }, [flow]);
    expect(result.changed).toBe(true);
    expect([...result.bySymbol.values()].every(value => !value.requests.length && !value.after.length)).toBe(true);
    const noSymbols = functionDoes('f', 'new', [], { ...routes, requests: [request(1)] }, [flow]);
    expect(noSymbols.changed).toBe(true);
    expect(functionDoes('other', 'new', symbols, { ...routes, requests: [request(1)] }, [flow]).changed).toBe(false);
  });
  it('rejects stale requests and stale nodes independently', () => {
    expect(functionDoes('f', 'h', symbols, { ...routes, requests: [request(1, { fileHash: 'old' })] }, null).changed).toBe(true);
    expect(functionDoes('f', 'h', symbols, null, [{ ...flow, nodes: [{ ...front, fileHash: 'old' }] }]).changed).toBe(true);
  });
  it('deduplicates after by site, when and action across flows and records omissions without adding them', () => {
    const result = functionDoes('f', 'h', symbols, null, [flow, { ...flow, nodes: [{ ...front, afterOmitted: 3,
      after: [...front.after, { ...front.after[0], when: 'error' }, { ...front.after[0], action: 'refresh' }] }] }]);
    expect(result.bySymbol.get(symbols[1].id)).toEqual({ requests: [], afterPartly: true, after: [
      { line: 2, text: '성공하면 화면 /로 이동하기' },
      { line: 2, text: '실패하면 화면 /로 이동하기' },
      { line: 2, text: '성공하면 목록을 새로 불러오게 하기' },
    ] });
    expect(result.bySymbol.get(symbols[3].id)?.after).toEqual([]);
  });
  it('requires front nodes, both range ends and this file, and reports flow limits even with no omissions', () => {
    const result = functionDoes('f', 'h', symbols, { ...routes, limited: true }, [{ ...flow, limited: true, nodes: [
      { ...front, side: 'back' }, { ...front, fileId: 'other' },
      { ...front, range: { ...front.range, endUtf16: front.range.endUtf16 + 1 } },
      { ...front, range: { ...front.range, startUtf16: front.range.startUtf16 + 1 } },
    ] }]);
    expect([...result.bySymbol.values()].every(value => !value.after.length && !value.afterPartly)).toBe(true);
    expect(result.notes).toEqual({ routes: ['서버 주소 찾기를 끝까지 하지 못했어요.'], flows: ['기능 흐름 일부를 끝까지 확인하지 못했어요.'] });
  });
  it('returns empty facts when routes and flows have not been found', () => {
    const result = functionDoes('f', 'h', symbols, null, null);
    expect([...result.bySymbol.values()]).toEqual(symbols.map(() => ({ requests: [], after: [], afterPartly: false })));
    expect(result.changed).toBe(false);
    expect(result.notes).toEqual({ routes: [], flows: [] });
  });
  it('keeps limited flow notes for the sixth request file even when only five files have nodes', () => {
    const requests = Array.from({ length: 6 }, (_, i) => request(1, { fileId: `file${i}` }));
    const nodes = requests.slice(0, 5).map(item => ({ ...front, id: item.fileId, fileId: item.fileId }));
    const result = functionDoes('file5', 'h', symbols, { ...routes, requests }, [
      { ...flow, nodes, limited: true, notes: ['같은 주소의 요청 일부를 생략했어요.'] },
    ]);
    expect(result.bySymbol.get(symbols[1].id)?.requests).toHaveLength(1);
    expect(result.bySymbol.get(symbols[1].id)?.after).toEqual([]);
    expect(result.notes).toEqual({ routes: [], flows: ['같은 주소의 요청 일부를 생략했어요.'] });
  });
  it('deduplicates notes in first-seen order and excludes route notes from limited flow notes', () => {
    const result = functionDoes('f', 'h', symbols, { ...routes, limited: true, notes: ['주소 이유 2', '공통 이유', '주소 이유 2', '주소 이유 1'] }, [
      { ...flow, limited: true, notes: ['흐름 이유 2', '공통 이유', '흐름 이유 2'] },
      { ...flow, notes: ['제한 없는 흐름의 이유'] },
      { ...flow, limited: true, notes: ['흐름 이유 1', '흐름 이유 2'] },
    ]);
    expect(result.notes).toEqual({ routes: ['주소 이유 2', '공통 이유', '주소 이유 1'], flows: ['흐름 이유 2', '흐름 이유 1'] });
  });
  it('ignores notes without limits and does not suppress flow notes matching unlimited route notes', () => {
    expect(functionDoes('f', 'h', symbols, { ...routes, notes: ['공통 이유'] }, [
      { ...flow, notes: ['제한 없는 흐름의 이유'] },
    ]).notes).toEqual({ routes: [], flows: [] });
    expect(functionDoes('f', 'h', symbols, { ...routes, notes: ['공통 이유'] }, [
      { ...flow, limited: true, notes: ['공통 이유'] },
    ]).notes).toEqual({ routes: [], flows: ['공통 이유'] });
  });
  it('adds each fallback only for empty limited notes and preserves its first-seen position', () => {
    expect(functionDoes('f', 'h', symbols, { ...routes, limited: true }, null).notes)
      .toEqual({ routes: ['서버 주소 찾기를 끝까지 하지 못했어요.'], flows: [] });
    expect(functionDoes('f', 'h', symbols, null, [
      { ...flow, limited: true, notes: ['앞 이유'] },
      { ...flow, limited: true },
      { ...flow, limited: true, notes: ['뒤 이유'] },
      { ...flow, limited: true },
    ]).notes).toEqual({ routes: [], flows: ['앞 이유', '기능 흐름 일부를 끝까지 확인하지 못했어요.', '뒤 이유'] });
  });
});
