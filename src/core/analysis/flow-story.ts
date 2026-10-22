import type { FeatureFlow, FlowEdge, FlowNode, Route } from '../../shared/contracts';

const methodNames: Record<Route['method'], string> = {
  GET: '보기', POST: '만들기·보내기', PUT: '바꾸기', PATCH: '고치기', DELETE: '지우기', ALL: '받기',
};

export function codeNameOf(route: Route): string {
  return `${methodNames[route.method]} · ${route.path ?? '주소 모름'}`;
}

export function groupNameOf(route: Route, relativePath: string): string {
  if (route.framework === 'next' || route.framework === 'express') return route.path?.split('/').find(Boolean) ?? '주소 모름';
  return relativePath.split('/').at(-1)?.replace(/\.[^.]+$/, '').replace(/\.(?:controller|routes?|router|handler)$/, '') || '이름 모름';
}

export interface StoryStep {
  storyId: string;
  kind: 'screen' | 'front' | 'request' | 'handler' | 'back';
  title: string;
  text: string;
  representative: FlowNode;
  nodes: FlowNode[];
  others: FlowNode[];
  inferred: boolean;
  reasons: string[];
  typed: boolean;
  stopped: boolean;
}

/** Reorders the existing graph without adding claims about execution or changing its analysis. */
export function storyOf(flow: FeatureFlow): StoryStep[] {
  const byId = new Map(flow.nodes.map(node => [node.id, node]));
  const requests = flow.nodes.filter(node => node.side === 'request');
  const back = flow.nodes.filter(node => node.side === 'back').sort((a, b) => a.depth - b.depth);
  const handler = back.find(node => node.depth === 0);
  // Functions a screen event leads to: the story follows the click, not a component that only sets the hook up.
  const fromEvent = new Set<string>();
  const pending = flow.nodes.filter(node => node.event !== null);
  while (pending.length) {
    const node = pending.pop()!;
    if (fromEvent.has(node.id)) continue;
    fromEvent.add(node.id);
    for (const edge of flow.edges) if (edge.from === node.id && byId.get(edge.to)?.side === 'front') pending.push(byId.get(edge.to)!);
  }
  const result: StoryStep[] = [];
  for (const request of requests.length ? requests : [null]) {
    const storyId = request?.id ?? 'server';
    const upstream = new Set<string>();
    const cycles = new Set<string>();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    // A recursion stack distinguishes a cycle from two branches sharing a function.
    const collect = (node: FlowNode, side: 'front' | 'back') => {
      if (visiting.has(node.id)) { cycles.add(node.id); return; }
      if (visited.has(node.id)) return;
      visiting.add(node.id);
      if (node.side === 'front') upstream.add(node.id);
      for (const edge of flow.edges) {
        const next = byId.get(side === 'front' ? edge.from : edge.to);
        if (next?.side !== side || (side === 'front' ? edge.to : edge.from) !== node.id) continue;
        if (visiting.has(next.id)) cycles.add(node.id);
        collect(next, side);
      }
      visiting.delete(node.id);
      visited.add(node.id);
    };
    if (request) collect(request, 'front');
    if (handler) collect(handler, 'back');

    const path: FlowNode[] = [];
    const arrows: FlowEdge[] = [];
    const seen = new Set<string>();
    let current = request;
    while (current) {
      seen.add(current.id);
      const incoming = flow.edges.filter(edge => edge.to === current!.id && byId.get(edge.from)?.side === 'front')
        .sort((a, b) => Number(fromEvent.has(b.from)) - Number(fromEvent.has(a.from))
          || byId.get(b.from)!.depth - byId.get(a.from)!.depth || Number(b.sure) - Number(a.sure));
      const next = incoming[0];
      if (!next) break;
      if (seen.has(next.from)) { cycles.add(current.id); break; }
      arrows.unshift(next);
      current = byId.get(next.from)!;
      path.unshift(current);
    }
    const others = flow.nodes.filter(node => upstream.has(node.id) && !seen.has(node.id));
    const add = (kind: StoryStep['kind'], title: string, text: string, representative: FlowNode,
      nodes: FlowNode[], edges: FlowEdge[], alternatives: FlowNode[] = []) => {
      result.push({ storyId, kind, title, text, representative, nodes, others: alternatives,
        inferred: edges.some(edge => !edge.sure), reasons: [...new Set(edges.filter(edge => !edge.sure).flatMap(edge => edge.reasons))],
        typed: edges.some(edge => edge.kind === 'typed'), stopped: [...nodes, ...alternatives].some(node => cycles.has(node.id)) });
    };
    if (path.length) {
      const first = path[0];
      const eventIndex = path.findIndex(node => node.event !== null);
      const screenEnd = Math.max(0, eventIndex);
      const event = eventIndex >= 0 ? path[eventIndex] : null;
      const processing = path.slice(screenEnd + 1);
      add('screen', '화면', (first.screen !== null ? `화면 ${first.screen}` : `시작: ${first.relativePath} · ${first.name}`)
        + (event ? ` · ${event.event}(버튼 등)을 눌러요` : ''), event ?? first, path.slice(0, screenEnd + 1),
        processing.length ? arrows.slice(0, screenEnd) : arrows, processing.length ? [] : others);
      if (processing.length) add('front', '프론트 처리', processing.map(node => node.name).join(' → '), path.at(-1)!, processing,
        arrows.slice(screenEnd), others);
    }
    if (request) add('request', '요청', `서버에 ${request.name} 요청을 보내요`, request, [request],
      flow.edges.filter(edge => edge.from === request.id && byId.get(edge.to)?.side === 'back'));
    if (handler) {
      const next = back.find(node => node.depth === 1);
      add('handler', '서버 받는 곳', `${handler.name}가 요청을 받아요${next ? ` → ${next.name}에 넘겨요` : ''}`,
        handler, [handler], flow.edges.filter(edge => edge.from === handler.id && byId.get(edge.to)?.side === 'back'));
      const functions = back.filter(node => node.depth >= 1);
      // One line each: a call's first line can run long (a whole transaction opening).
      const outside = back.flatMap(node => node.outside).map(text => text.length > 48 ? `${text.slice(0, 48)}…` : text);
      const omitted = Math.max(0, outside.length - 4) + back.reduce((sum, node) => sum + node.outsideOmitted, 0);
      if (functions.length || outside.length) add('back', '서버 처리', [functions.map(node => node.name).join(' → '),
        outside.length ? `바깥 호출: ${outside.slice(0, 4).join(' · ')}${omitted ? ' …' : ''}` : ''].filter(Boolean).join(' · '),
      next ?? handler, back, flow.edges.filter(edge => byId.get(edge.from)?.side === 'back' && byId.get(edge.to)?.side === 'back'));
    }
  }
  return result;
}
