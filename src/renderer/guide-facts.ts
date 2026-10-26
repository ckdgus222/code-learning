import type { CodeSymbol, FeatureFlow, MapImport, ProjectMap, ProjectRoutes } from '../shared/contracts';
import type { FileExplanationResult } from '../shared/ai';
import { afterText, afterWhen, routeLabel } from '../core/analysis/flow-story';

export interface Importer { fromFileId: string; relativePath: string; item: MapImport }

export function aiFunctionSummaries(result: FileExplanationResult | null, stale: boolean, symbols: CodeSymbol[]):
  { state: 'none' | 'stale' | 'ready'; bySymbol: Map<string, string> } {
  const bySymbol = new Map<string, string>();
  if (!result) return { state: 'none', bySymbol };
  if (stale) return { state: 'stale', bySymbol };
  for (const symbol of symbols) {
    const chunk = result.chunks.find(item => item.functionRange?.startUtf16 === symbol.evidence.startUtf16 &&
      item.functionRange.endUtf16 === symbol.evidence.endUtf16);
    if (!chunk) continue;
    const summary = result.explanation.chunks.find(item => item.chunkId === chunk.id)?.summary;
    if (summary) bySymbol.set(symbol.id, summary);
  }
  return { state: 'ready', bySymbol };
}

export function importersOf(fileId: string, relativePath: string, map: ProjectMap):
  { files: Importer[]; ambiguous: Importer[]; unread: { relativePath: string; reason: string }[]; limitedMap: boolean } {
  const paths = new Map(map.files.map(file => [file.id, file.relativePath]));
  const first = new Map<string, Importer>();
  for (const item of map.edges) {
    if (item.toFileId !== fileId) continue;
    const previous = first.get(item.fromFileId);
    if (previous && previous.item.startUtf16 <= item.startUtf16) continue;
    first.set(item.fromFileId, { fromFileId: item.fromFileId, relativePath: paths.get(item.fromFileId) ?? item.fromFileId, item });
  }
  const ambiguous = map.unresolved.filter(item => item.reason === 'ambiguous' && item.candidates.includes(relativePath))
    .map(item => ({ fromFileId: item.fromFileId, relativePath: paths.get(item.fromFileId) ?? item.fromFileId, item }));
  const byPath = (a: Importer, b: Importer) => a.relativePath.localeCompare(b.relativePath) || a.item.startUtf16 - b.item.startUtf16;
  const unread = map.files.filter(file => ['partial', 'failed', 'skipped'].includes(file.checked))
    .map(file => ({ relativePath: file.relativePath, reason: file.reason ?? '끝까지 보지 못했어요' }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files: [...first.values()].sort(byPath), ambiguous: ambiguous.sort(byPath), unread, limitedMap: map.limited };
}

export interface DoesLine { line: number; text: string }
export interface RequestLine extends DoesLine { links: { text: string; inferred: boolean; reasons: string[] }[] }

export function functionDoes(fileId: string, fileHash: string, symbols: CodeSymbol[],
  routes: ProjectRoutes | null, flows: FeatureFlow[] | null):
  { bySymbol: Map<string, { requests: RequestLine[]; after: DoesLine[]; afterPartly: boolean }>; changed: boolean;
    notes: { routes: string[]; flows: string[] } } {
  const bySymbol: ReturnType<typeof functionDoes>['bySymbol'] = new Map();
  const symbolsByRange = new Map(symbols.map(symbol => [`${symbol.evidence.startUtf16}:${symbol.evidence.endUtf16}`, symbol.id]));
  for (const symbol of symbols) bySymbol.set(symbol.id, { requests: [], after: [], afterPartly: false });
  let changed = false;
  const linksByRequest = new Map<number, RequestLine['links']>();
  for (const link of routes?.links ?? []) {
    const links = linksByRequest.get(link.requestIndex) ?? [];
    links.push({ text: `서버 ${routeLabel(routes!.routes[link.routeIndex])}`, inferred: !link.sure, reasons: link.reasons });
    linksByRequest.set(link.requestIndex, links);
  }
  routes?.requests.forEach((request, index) => {
    if (request.fileId !== fileId) return;
    if (request.fileHash !== fileHash) { changed = true; return; }
    if (!request.inFunction) return;
    const symbolId = symbolsByRange.get(`${request.inFunction.startUtf16}:${request.inFunction.endUtf16}`);
    if (!symbolId) return;
    bySymbol.get(symbolId)!.requests.push({ line: request.startLine,
      text: `${request.methods?.join('·') ?? '방식 모름'} ${request.host ?? ''}${request.path} 요청을 보내요${request.prefix === 'unknown' ? ' (앞 경로 확인 못 함)' : ''}`,
      links: linksByRequest.get(index) ?? [] });
  });
  const seenAfter = new Set<string>();
  for (const node of flows?.flatMap(flow => flow.nodes) ?? []) {
    if (node.side !== 'front' || node.fileId !== fileId) continue;
    if (node.fileHash !== fileHash) { changed = true; continue; }
    const symbolId = symbolsByRange.get(`${node.range.startUtf16}:${node.range.endUtf16}`);
    if (!symbolId) continue;
    const lines = bySymbol.get(symbolId)!;
    lines.afterPartly ||= node.afterOmitted > 0;
    for (const after of node.after) {
      const key = `${symbolId}:${after.site.startUtf16}:${after.when}:${after.action}`;
      if (seenAfter.has(key)) continue;
      seenAfter.add(key);
      lines.after.push({ line: after.site.startLine, text: `${afterWhen[after.when]} ${afterText(after)}` });
    }
  }
  for (const lines of bySymbol.values()) {
    lines.requests.sort((a, b) => a.line - b.line);
    lines.after.sort((a, b) => a.line - b.line);
  }
  const routeNotes = new Set(routes?.limited
    ? routes.notes.length ? routes.notes : ['서버 주소 찾기를 끝까지 하지 못했어요.']
    : []);
  const flowNotes = new Set((flows ?? []).filter(flow => flow.limited)
    .flatMap(flow => flow.notes.length ? flow.notes : ['기능 흐름 일부를 끝까지 확인하지 못했어요.']));
  return { bySymbol, changed, notes: { routes: [...routeNotes], flows: [...flowNotes].filter(note => !routeNotes.has(note)) } };
}
