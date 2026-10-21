import type Parser from 'tree-sitter';
import type { CallTarget, FeatureFlow, FlowEdge, FlowNode, FunctionCalls, ProjectFile, ProjectRoutes, ValueSite } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { findFunctionCalls, type CallsCache } from './calls';
import { candidatesFor, isRelative, MAP_LIMITS, type MapLimits } from './project-map';
import { formatNextPath, nextRouteOf } from './next-routes';
import { lineRange, nearest, reassigned, sameRange, type FileFacts } from './names';
import { functionName, functionTypes } from './syntax';
import { assertResultSize, isTestFile, requestSite, routeSite, shortName } from './routes';

type Node = Parser.SyntaxNode;
const field = (node: Node | null, name: string) => node?.childForFieldName(name) ?? null;
const enclosing = (node: Node): Node | null => {
  for (let parent = node.parent; parent; parent = parent.parent) if (functionTypes.has(parent.type)) return parent;
  return null;
};
const targetOf = (node: FlowNode): CallTarget => ({ fileId: node.fileId, fileHash: node.fileHash, name: node.name, ...node.range });

/** A bounded graph for one receiving route. All arrows describe code, not observed execution. */
export async function buildFeatureFlow(root: string, projectId: string, files: ProjectFile[], routes: ProjectRoutes, routeIndex: number,
  limits: MapLimits = MAP_LIMITS, shouldStop: () => boolean = () => false): Promise<FeatureFlow> {
  const route = routes.routes[routeIndex];
  if (routes.projectId !== projectId || !route) throw new AppError('CHANGED', '기능 목록을 다시 찾아 주세요.');
  const flow: FeatureFlow = { projectId, routesId: routes.routesId, routeIndex, nodes: [], edges: [], limited: routes.limited, notes: [...routes.notes] };
  const cache: CallsCache = { texts: new Map(), parsed: new Map() };
  const results = new Map<string, FunctionCalls>();
  const known = new Map(files.map(file => [file.relativePath, file]));
  const limit = (message: string) => { flow.limited = true; if (!flow.notes.includes(message)) flow.notes.push(message); };
  const add = (side: FlowNode['side'], target: CallTarget, depth: number): FlowNode | null => {
    const id = `${side}:${target.fileId}:${target.startUtf16}:${target.endUtf16}`;
    const prior = flow.nodes.find(node => node.id === id);
    if (prior) return prior;
    if (flow.nodes.filter(node => node.side === side).length >= (side === 'front' ? 12 : side === 'request' ? 5 : 10)) {
      limit('프론트 함수 12개·요청 5개·백엔드 함수 10개까지만 보여요.'); return null;
    }
    const file = files.find(file => file.id === target.fileId);
    if (!file) throw new AppError('CHANGED', '기능의 파일을 지금 찾을 수 없어요.');
    const node: FlowNode = { id, side, depth, fileId: target.fileId, fileHash: target.fileHash, relativePath: file.relativePath, name: shortName(target.name),
      range: { startUtf16: target.startUtf16, endUtf16: target.endUtf16, startLine: target.startLine, endLine: target.startLine },
      event: null, screen: null, outside: [], outsideOmitted: 0 };
    flow.nodes.push(node);
    return node;
  };
  const edge = (from: FlowNode, to: FlowNode, kind: FlowEdge['kind'], site: ValueSite | null, reasons: string[] = [], sure = true) => {
    // Thousands of calls between the same functions would each be an arrow; the flow shows a bounded number.
    if (flow.edges.length >= 200) { limit('화살표는 200개까지만 보여요.'); return; }
    if (!flow.edges.some(item => item.from === from.id && item.to === to.id && item.kind === kind && item.site?.startUtf16 === site?.startUtf16)) {
      // Only the place and its line: a call carries names and arguments the flow does not show.
      const place: ValueSite | null = site && { fileId: site.fileId, fileHash: site.fileHash, startUtf16: site.startUtf16,
        endUtf16: site.endUtf16, startLine: site.startLine, endLine: site.endLine, text: site.text };
      flow.edges.push({ from: from.id, to: to.id, kind, sure, reasons, site: place });
    }
  };
  const inspect = async (node: FlowNode) => {
    if (shouldStop()) throw new AppError('CANCELLED', '기능 흐름 찾기를 취소했어요.');
    const key = `${node.fileId}:${node.range.startUtf16}:${node.range.endUtf16}`;
    let found = results.get(key);
    if (!found) {
      found = await findFunctionCalls(root, projectId, files, targetOf(node), limits, shouldStop, cache);
      results.set(key, found);
      if (found.limited || found.unexamined.length) limit('일부 파일은 끝까지 확인하지 못했어요.');
    }
    const facts = cache.parsed.get(node.fileId)!;
    const fn = facts.functions.find(fn => fn.startIndex === node.range.startUtf16 && fn.endIndex === node.range.endUtf16)!;
    node.range = { startUtf16: fn.startIndex, endUtf16: fn.endIndex, ...lineRange(fn) };
    const event = node.name.match(/^(on[A-Z]\w*) 함수(?: \(\d+행\))?$/);
    if (event) node.event = event[1];
    return { found, facts, fn };
  };
  const back = add('back', route.handler, 0)!;
  const backQueue = [back];
  const backSeen = new Set<string>();
  while (backQueue.length) {
    const node = backQueue.shift()!;
    if (backSeen.has(node.id)) continue;
    backSeen.add(node.id);
    const { found, facts, fn } = await inspect(node);
    const outside = found.calls.filter(call => call.status === 'external' || call.status === 'unknown').map(call => call.text);
    // Only callbacks passed directly as arguments to a call in this body, one nested level.
    // Each callback is a whole call search, and only a few lines of it are shown: the first three are read.
    const callbacks = facts.functions.filter(child => child.parent?.type === 'arguments' && child.parent.parent?.type === 'call_expression'
      && enclosing(child) && sameRange(enclosing(child)!, fn));
    if (callbacks.length > 3) limit('안쪽 함수는 함수마다 3개까지만 봐요.');
    for (const callback of callbacks.slice(0, 3)) {
      if (shouldStop()) throw new AppError('CANCELLED', '기능 흐름 찾기를 취소했어요.');
      const nested = await findFunctionCalls(root, projectId, files, routeSite(callback, facts), limits, shouldStop, cache);
      outside.push(...nested.calls.filter(call => call.status === 'external' || call.status === 'unknown').map(call => `안쪽 함수에서 ${call.text}`));
    }
    node.outside = outside.slice(0, 6);
    node.outsideOmitted = Math.max(0, outside.length - 6);
    for (const call of found.calls) {
      if (call.status !== 'linked' && call.status !== 'typed') continue;
      if (node.depth >= 3) { limit('백엔드 호출은 깊이 3까지만 따라가요.'); continue; }
      const next = add('back', call.target, node.depth + 1);
      if (next) { edge(node, next, call.status === 'typed' ? 'typed' : 'calls', call); backQueue.push(next); }
    }
  }
  const links = routes.links.filter(link => link.routeIndex === routeIndex).sort((a, b) => Number(b.sure) - Number(a.sure));
  if (links.length > 5) limit('프론트 요청은 확실한 연결부터 5개까지만 보여요.');
  const queue: FlowNode[] = [];
  const viaInside = new Set<string>();
  for (const link of links.slice(0, 5)) {
    const request = routes.requests[link.requestIndex];
    const node = add('request', { ...request, name: `${request.methods?.join(' / ') ?? '방식 모름'} ${request.args?.[0]?.text.slice(1, -1) ?? request.path}` }, 0)!;
    node.range.endLine = request.endLine;
    edge(node, back, 'route', request, link.reasons, link.sure);
    if (request.inFunction) {
      const fn = add('front', { fileId: request.fileId, fileHash: request.fileHash, ...request.inFunction }, 1);
      if (fn) { edge(fn, node, 'calls', request); queue.push(fn); }
    }
  }
  const expanded = new Set<string>();
  /** Each file's name references by start, so a JSX tag finds its own without scanning them all. */
  const referencesByStart = new Map<string, Map<number, FileFacts['references'][number]>>();
  const hookExpanded = new Set<string>();
  while (queue.length) {
    const node = queue.shift()!;
    const needsHook = viaInside.has(node.id) && /^use[A-Z]/.test(node.name) && !hookExpanded.has(node.id);
    if (expanded.has(node.id) && !needsHook) continue;
    const already = expanded.has(node.id);
    expanded.add(node.id);
    const { found, facts, fn } = await inspect(node);
    const next = nextRouteOf(node.relativePath, files.map(file => file.relativePath));
    if (next?.kind === 'page' && facts.exports.get('default')?.some(item => item.fn && sameRange(item.fn, fn))) {
      node.screen = formatNextPath(next.segments); continue;
    }
    const allCallers = [...(found.callers ?? []), ...found.typedCallers].filter(site => !site.inTest);
    if (allCallers.length > 50) limit('함수마다 부르는 곳은 50개까지만 따라가요.');
    const callers = allCallers.slice(0, 50);
    if (!already) {
      for (const caller of callers) if (caller.inFunction) {
        const parent = add('front', { fileId: caller.fileId, fileHash: caller.fileHash, ...caller.inFunction }, 0);
        if (parent) { edge(parent, node, 'basis' in caller ? 'typed' : /^on[A-Z]\w* 함수(?: \(\d+행\))?$/.test(parent.name) ? 'event' : 'calls', caller); queue.push(parent); }
      }
      if (!callers.length) {
        const outer = enclosing(fn);
        if (outer) {
          const parent = add('front', { ...routeSite(outer, facts), name: functionName(outer) }, 0);
          if (parent) { edge(parent, node, 'inside', routeSite(fn, facts)); viaInside.add(parent.id); queue.push(parent); }
        }
      }
    }
    if (needsHook) {
      hookExpanded.add(node.id);
      let uses = 0;
      for (const caller of callers) {
        const info = cache.parsed.get(caller.fileId);
        const call = info?.calls.find(item => item.node.startIndex === caller.startUtf16);
        if (!info || !call?.fn) continue;
        const declarator = call.node.parent;
        if (declarator?.type !== 'variable_declarator' || !field(declarator, 'value') || !sameRange(field(declarator, 'value')!, call.node)) continue;
        const variables = info.variables.filter(item => item.source && sameRange(item.source, declarator) && item.node && !reassigned(info, item.node.text, item.scope));
        for (const variable of variables) for (const use of info.calls) {
          if (shouldStop()) throw new AppError('CANCELLED', '기능 흐름 찾기를 취소했어요.');
          if (!use.fn || use.node.startIndex < call.fn.startIndex || use.node.endIndex > call.fn.endIndex) continue;
          const callee = field(use.node, 'function');
          const name = variable.shape === 'plain' && callee?.type === 'member_expression' ? field(callee, 'object') : callee?.type === 'identifier' && variable.shape === 'destructured' ? callee : null;
          if (!name || name.text !== variable.node!.text || nearest(use.scope, name.text)?.scope !== variable.scope) continue;
          if (uses >= 3) { limit('훅 결과를 쓰는 곳은 훅마다 3개까지만 보여요.'); continue; }
          const parent = add('front', { ...routeSite(use.fn, info), name: functionName(use.fn) }, 0);
          if (parent) { edge(parent, node, 'hook', requestSite(use, info), [`훅이 돌려준 값 ${shortName(name.text)}를 써요`], false); queue.push(parent); uses++; }
        }
      }
    }
    if (!already && /^[A-Z]/.test(node.name)) {
      // A component's same-name import or default import must resolve to exactly this file.
      for (const info of cache.parsed.values()) {
        if (shouldStop()) throw new AppError('CANCELLED', '기능 흐름 찾기를 취소했어요.');
        if (!info.complete || info.unclear || isTestFile(info.file.relativePath)) continue;
        const names = new Set<string>();
        if (info.file.id === facts.file.id) names.add(node.name);
        for (const [local, declarations] of info.program.names) {
          if (declarations.length !== 1 || declarations[0].kind !== 'import' || reassigned(info, local, info.program)) continue;
          const imported = declarations[0];
          if (!imported.specifier || !isRelative(imported.specifier)) continue;
          const candidates = candidatesFor(info.file.relativePath, imported.specifier, known);
          if (candidates?.length !== 1 || known.get(candidates[0])?.id !== facts.file.id) continue;
          if (imported.imported !== 'default' && (local !== imported.imported || !found.names.exported.includes(imported.imported))) continue;
          if (imported.imported === 'default' && !found.names.exported.includes('default')) continue;
          names.add(local);
        }
        if (!names.size) continue;
        const anchor = info.functions[0] ?? info.references[0]?.node;
        if (!anchor) continue;
        let tree = anchor;
        while (tree.parent) tree = tree.parent;
        const tags = tree.descendantsOfType(['jsx_opening_element', 'jsx_self_closing_element']);
        if (!referencesByStart.has(info.file.id)) referencesByStart.set(info.file.id, new Map(info.references.map(ref => [ref.node.startIndex, ref])));
        const references = referencesByStart.get(info.file.id)!;
        for (const tag of tags) {
          if (shouldStop()) throw new AppError('CANCELLED', '기능 흐름 찾기를 취소했어요.');
          const name = field(tag, 'name');
          const outer = enclosing(tag);
          if (!name || !names.has(name.text) || !outer || outer.startIndex === fn.startIndex && info.file.id === facts.file.id) continue;
          // Scope references avoid a JSX name shadowed by a local parameter or declaration.
          const candidate = references.get(name.startIndex);
          const reference = candidate && sameRange(candidate.node, name) ? candidate : undefined;
          const resolved = reference && nearest(reference.scope, name.text);
          if (resolved && resolved.scope !== info.program && !(info.file.id === facts.file.id && resolved.declared.some(item => item.kind === 'function' && sameRange(item.fn, fn)))) continue;
          const parent = add('front', { ...routeSite(outer, info), name: functionName(outer) }, 0);
          if (parent) { edge(parent, node, 'placed', routeSite(tag, info)); queue.push(parent); }
        }
      }
    }
  }
  // Longest path toward a request, ignoring DFS back edges. Keep those edges in the displayed graph.
  const distances = new Map<string, number>();
  const visiting = new Set<string>();
  const distance = (id: string): number => {
    if (distances.has(id)) return distances.get(id)!;
    visiting.add(id);
    let value = 0;
    for (const arrow of flow.edges.filter(edge => edge.from === id && edge.kind !== 'route')) {
      const target = flow.nodes.find(node => node.id === arrow.to)!;
      if (target.side === 'back' || visiting.has(target.id)) continue;
      value = Math.max(value, 1 + distance(target.id));
    }
    visiting.delete(id);
    distances.set(id, value);
    return value;
  };
  for (const node of flow.nodes) if (node.side === 'front') node.depth = distance(node.id);
  assertResultSize(flow);
  return flow;
}
