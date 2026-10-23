import type { FeatureFlow, FlowEdge, FlowAfter, FlowAsk, FlowNode, FlowStop, FlowStore, Route } from '../../shared/contracts';

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

const kindLabels: Record<StoryStep['kind'], string> = {
  screen: '화면', front: '프론트 처리', request: '요청', handler: '서버 받는 곳', back: '서버 처리', store: '저장소', result: '화면 결과',
};

const tags: Record<string, string> = { button: '버튼을', a: '링크를', Link: '링크를', form: '입력 양식을', input: '입력 칸을', select: '고르기 칸을', textarea: '글 칸을' };

const verbs: Record<string, string> = { onClick: '누르면', onSubmit: '보내면', onChange: '바꾸면', onInput: '입력하면' };

const storeVerbs: Record<FlowStore['action'], string> = {
  read: '읽기', count: '세기', create: '새로 저장하기', update: '바꾸기',
  upsert: '없으면 새로 저장하고 있으면 바꾸기', delete: '지우기', raw: 'SQL 직접 실행',
};
export const storeText = (store: FlowStore): string => store.action === 'raw' ? storeVerbs.raw : `${store.model} ${storeVerbs[store.action]}`;

const stopNames: Record<string, string> = {
  NotFoundException: '찾을 수 없음', BadRequestException: '잘못된 요청', UnauthorizedException: '로그인 필요',
  ForbiddenException: '권한 없음', ConflictException: '충돌', UnprocessableEntityException: '처리할 수 없는 내용',
  InternalServerErrorException: '서버 오류',
};
export function stopText(stop: FlowStop): string {
  const text = stop.message !== null ? `“${stop.message}” 오류를 내요` : `${stop.kind} 오류를 내요`;
  return text + (Object.hasOwn(stopNames, stop.kind) ? ` (${stopNames[stop.kind]})` : '');
}

export function afterText(after: FlowAfter): string {
  switch (after.action) {
    case 'refresh': return '목록을 새로 불러오게 하기';
    case 'cache': return '저장해 둔 데이터 바로 바꾸기';
    case 'cancel': return '하던 불러오기 멈추기';
    case 'navigate': return after.target === null ? '다른 화면으로 이동하기' : `화면 ${after.target}로 이동하기`;
    case 'state': return `화면 값 ${after.target} 바꾸기`;
    case 'notify': return '알림 보여 주기';
    case 'call': return `\`${after.target}\` 부르기`;
  }
}

export const afterOrder = ['success', 'error', 'settled'] as const;
export const byWhen = (items: FlowAfter[]) => afterOrder.map(when => ({ when, items: items.filter(item => item.when === when) }))
  .filter(group => group.items.length > 0);
export const afterWhen: Record<FlowAfter['when'], string> = { success: '성공하면', error: '실패하면', settled: '끝나면' };

interface Listed<T> { items: T[]; omitted: number }

export interface StoryStep {
  storyId: string;
  kind: 'screen' | 'front' | 'request' | 'handler' | 'back' | 'store' | 'result';
  label: string;
  title: string;
  text: string;
  representative: FlowNode;
  nodes: FlowNode[];
  others: FlowNode[];
  inferred: boolean;
  reasons: string[];
  typed: boolean;
  stopped: boolean;
  asks: Listed<FlowAsk & { nodeId: string }>;
  afterGroups: { groups: { node: FlowNode; items: FlowAfter[] }[]; omitted: number };
  stops: Listed<FlowStop & { nodeId: string }>;
  storeGroups: { groups: { node: FlowNode; items: FlowStore[] }[]; omitted: number };
  outside: Listed<string>;
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
      nodes: FlowNode[], edges: FlowEdge[], alternatives: FlowNode[] = [],
      details: Partial<Pick<StoryStep, 'stops' | 'storeGroups' | 'outside' | 'asks' | 'afterGroups'>> = {}) => {
      const step: StoryStep = { storyId, kind, label: kindLabels[kind], title, text, representative, nodes, others: alternatives,
        inferred: edges.some(edge => !edge.sure), reasons: [...new Set(edges.filter(edge => !edge.sure).flatMap(edge => edge.reasons))],
        typed: edges.some(edge => edge.kind === 'typed'), stopped: [...nodes, ...alternatives].some(node => cycles.has(node.id)),
        asks: { items: [], omitted: 0 }, afterGroups: { groups: [], omitted: 0 }, stops: { items: [], omitted: 0 }, storeGroups: { groups: [], omitted: 0 }, outside: { items: [], omitted: 0 }, ...details };
      result.push(step);
    };
    if (path.length) {
      const first = path[0];
      const eventIndex = path.findIndex(node => node.event !== null);
      const screenEnd = Math.max(0, eventIndex);
      const event = eventIndex >= 0 ? path[eventIndex] : null;
      const processing = path.slice(screenEnd + 1);
      const screenNodes = path.slice(0, screenEnd + 1);
      const asksOf = (nodes: FlowNode[]) => ({ items: nodes.flatMap(node => node.asks.map(ask => ({ ...ask, nodeId: node.id }))), omitted: 0 });
      const control = event?.control;
      const action = control && event?.event && verbs[event.event]
        ? `에서 ${control.texts.length ? control.texts.map(text => `‘${text}’`).join(' 또는 ') + ' ' : ''}${tags[control.tag] ?? `<${control.tag}>를`} ${verbs[event.event]} 시작해요`
        : event ? `에서 ${event.event} 동작이 일어나요` : '에서 시작해요';
      add('screen', event ? '화면 동작에서 시작해요' : first.screen !== null ? '화면에서 시작해요' : '이 함수에서 시작해요',
        (first.screen !== null ? `화면 ${first.screen}` : `${first.relativePath} · ${first.name}`)
        + action, event ?? first, screenNodes,
        processing.length ? arrows.slice(0, screenEnd) : arrows, processing.length ? [] : others, { asks: asksOf(screenNodes) });
      if (processing.length) add('front', '화면 쪽 코드가 요청을 준비해요', processing.map(node => node.name).join(' → ')
        + (processing.length === 1 ? '가 요청을 준비해요' : ' 순서로 이어져요'), path.at(-1)!, processing,
        arrows.slice(screenEnd), others, { asks: asksOf(processing) });
    }
    if (request) add('request', '서버에 요청을 보내요', `${request.name} 요청을 보내요`, request, [request],
      flow.edges.filter(edge => edge.from === request.id && byId.get(edge.to)?.side === 'back'));
    if (handler) {
      const next = back.find(node => node.depth === 1);
      // serverFacts skips other nested functions; direct callbacks are not flow nodes, so sites cannot overlap.
      add('handler', '서버가 요청을 받아요', `${handler.name}가 요청을 받아요${next ? ` → ${next.name}에 넘겨요` : ''}`,
        handler, [handler], flow.edges.filter(edge => edge.from === handler.id && byId.get(edge.to)?.side === 'back'), [],
        { stops: { items: handler.stops.map(stop => ({ ...stop, nodeId: handler.id })), omitted: handler.stopsOmitted } });
      const functions = back.filter(node => node.depth >= 1);
      // One line each: a call's first line can run long (a whole transaction opening).
      const outside = back.flatMap(node => node.outside).map(text => text.length > 48 ? `${text.slice(0, 48)}…` : text);
      const omitted = Math.max(0, outside.length - 4) + back.reduce((sum, node) => sum + node.outsideOmitted, 0);
      if (functions.length || outside.length) {
        add('back', '서버가 일을 처리해요', functions.map(node => node.name).join(' → '),
          next ?? handler, back, flow.edges.filter(edge => byId.get(edge.from)?.side === 'back' && byId.get(edge.to)?.side === 'back'), [],
          { stops: { items: functions.flatMap(node => node.stops.map(stop => ({ ...stop, nodeId: node.id }))),
            omitted: functions.reduce((sum, node) => sum + node.stopsOmitted, 0) }, outside: { items: outside.slice(0, 4), omitted } });
      }
      const groups = back.filter(node => node.stores.length > 0)
        .map(node => ({ node, items: node.stores.toSorted((a, b) => a.site.startUtf16 - b.site.startUtf16) }));
      if (groups.length) {
        const storeNodes = groups.map(group => group.node);
        const text = groups.map(({ node, items }) => {
          const labels = items.map(storeText);
          return `${node.name}: ${labels.filter((label, index) => label !== labels[index - 1]).join(' → ')}`;
        }).join(' · ');
        const ids = new Set(storeNodes.map(node => node.id));
        add('store', '저장소(DB)를 써요', text, storeNodes[0], storeNodes,
          flow.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), [],
          { storeGroups: { groups, omitted: back.reduce((sum, node) => sum + node.storesOmitted, 0) } });
      }
    }
    const groups = path.filter(node => node.after.length > 0)
      .map(node => ({ node, items: node.after.toSorted((a, b) => a.site.startUtf16 - b.site.startUtf16) }));
    if (groups.length) {
      const nodes = groups.map(group => group.node);
      const ids = new Set(nodes.map(node => node.id));
      const text = groups.map(({ node, items }) => `${node.name} · ${byWhen(items)
        .map(({ when, items }) => `${afterWhen[when]}: ${items.map(afterText).join(' → ')}`).join(' · ')}`).join(' · ');
      add('result', '응답이 온 뒤 화면이 바뀌어요', text, nodes[0], nodes,
        flow.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), [],
        { afterGroups: { groups, omitted: nodes.reduce((sum, node) => sum + node.afterOmitted, 0) } });
    }
  }
  return result;
}
