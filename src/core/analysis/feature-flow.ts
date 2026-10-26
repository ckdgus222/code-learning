import type Parser from 'tree-sitter';
import type { CallTarget, FeatureFlow, FlowEdge, FlowAfter, FlowAsk, FlowControl, FlowNode, FlowStop, FlowStore, FunctionCalls, ProjectFile, ProjectRoutes, ValueSite } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { findFunctionCalls, type CallsCache } from './calls';
import { candidatesFor, isRelative, MAP_LIMITS, type MapLimits } from './project-map';
import { formatNextPath, nextRouteOf } from './next-routes';
import { firstCode, firstLine, lineRange, nearest, reassigned, sameRange, unwrapped, propertyName, type CallFact, type Declaration, type FileFacts } from './names';
import { functionName, functionTypes } from './syntax';
import { assertResultSize, isTestFile, literal, requestSite, routeSite, shortName } from './routes';

type Node = Parser.SyntaxNode;
type ReturnedHook = { hook: Node; properties: { name: string; local: string; declaration: Declaration }[] };
const field = (node: Node | null, name: string) => node?.childForFieldName(name) ?? null;
const enclosing = (node: Node): Node | null => {
  for (let parent = node.parent; parent; parent = parent.parent) if (functionTypes.has(parent.type)) return parent;
  return null;
};
const targetOf = (node: FlowNode): CallTarget => ({ fileId: node.fileId, fileHash: node.fileHash, name: node.name, ...node.range });
const keyOf = (fileId: string, start: number, end: number): string => `${fileId}:${start}:${end}`;

const storeActions = new Map<string, FlowStore['action']>([
  ...['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'aggregate', 'groupBy'].map(op => [op, 'read'] as const),
  ['count', 'count'], ['create', 'create'], ['createMany', 'create'], ['createManyAndReturn', 'create'],
  ['update', 'update'], ['updateMany', 'update'], ['upsert', 'upsert'], ['delete', 'delete'], ['deleteMany', 'delete'],
]);

const clip = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit)}…` : text;

function isDirectCallback(node: Node, fn: Node): boolean {
  if (node.parent?.type !== 'arguments' || node.parent.parent?.type !== 'call_expression') return false;
  const outer = enclosing(node);
  return !!outer && sameRange(outer, fn);
}

function conditionOf(throwNode: Node): string | null {
  for (let parent = throwNode.parent; parent && !functionTypes.has(parent.type); parent = parent.parent) {
    if (parent.type === 'catch_clause') return '오류가 나면';
    if (parent.type !== 'if_statement') continue;
    const test = field(parent, 'condition');
    const consequence = field(parent, 'consequence');
    const alternative = field(parent, 'alternative');
    const within = (branch: Node | null) => branch && throwNode.startIndex >= branch.startIndex && throwNode.endIndex <= branch.endIndex;
    if (!test || !(within(consequence) || within(alternative))) continue;
    const text = test.type === 'parenthesized_expression' ? test.text.slice(1, -1) : test.text;
    return clip(`${within(alternative) ? '아니면: ' : ''}${text}`.replace(/\s+/g, ' ').trim(), 80);
  }
  return null;
}

function isTransactionParameter(receiver: Node, call: CallFact | undefined, facts: FileFacts): boolean {
  if (!call) return false;
  const declared = nearest(call.scope, receiver.text);
  const declaration = declared?.declared.length === 1 ? declared.declared[0] : null;
  const parameter = declaration && 'info' in declaration ? declaration.info : null;
  if (parameter?.role !== 'parameter' || parameter.index !== 0 || parameter.shape !== 'plain' || parameter.clash) return false;
  const owner = parameter.owner;
  const transaction = owner?.parent?.type === 'arguments' && owner.parent.parent?.type === 'call_expression'
    ? field(owner.parent.parent, 'function') : null;
  if (transaction?.type !== 'member_expression' || field(transaction, 'property')?.text !== '$transaction') return false;
  if (reassigned(facts, receiver.text, parameter.scope)) return false;
  return !facts.variables.some(variable => variable !== parameter && variable.owner && owner && sameRange(variable.owner, owner)
    && variable.node?.text === receiver.text);
}

/** Reads this body and directly passed callbacks, without resolving any more calls or files. */
export function serverFacts(fn: Node, facts: FileFacts): Pick<FlowNode, 'stops' | 'stopsOmitted' | 'stores' | 'storesOmitted'> {
  const stops: FlowStop[] = [];
  const stores: FlowStore[] = [];
  let stopsOmitted = 0;
  let storesOmitted = 0;
  let calls: Map<number, CallFact> | undefined;
  const body = field(fn, 'body');
  const pending = body ? [body] : [];
  while (pending.length) {
    const node = pending.pop()!;
    if (functionTypes.has(node.type)) {
      const callbackBody = field(node, 'body');
      if (callbackBody && isDirectCallback(node, fn)) pending.push(callbackBody);
      continue;
    }
    pending.push(...node.namedChildren.toReversed());
    if (node.type === 'throw_statement') {
      const value = firstCode(node);
      const constructor = value?.type === 'new_expression' ? field(value, 'constructor') : null;
      const kind = constructor?.type === 'identifier' ? constructor.text
        : constructor?.type === 'member_expression' ? field(constructor, 'property')?.text : null;
      if (!kind) continue;
      if (stops.length === 6) { stopsOmitted++; continue; }
      const message = literal(firstCode(field(value!, 'arguments')));
      stops.push({ kind, message: message !== null ? clip(message, 120) : null,
        condition: conditionOf(node), site: routeSite(node, facts) });
      continue;
    }
    if (node.type !== 'call_expression') continue;
    const callee = field(node, 'function');
    if (callee?.type !== 'member_expression') continue;
    const op = field(callee, 'property')?.text ?? '';
    let action: FlowStore['action'];
    let model: string | null = null;
    let receiver: Node | null;
    if (/^\$(?:queryRaw|executeRaw)(?:Unsafe)?$/.test(op)) {
      action = 'raw';
      receiver = field(callee, 'object');
    } else {
      const modelAction = storeActions.get(op);
      if (!modelAction) continue;
      const modelAccess = field(callee, 'object');
      if (modelAccess?.type !== 'member_expression') continue;
      const property = field(modelAccess, 'property');
      if (property?.type !== 'property_identifier') continue;
      action = modelAction;
      model = property.text;
      receiver = field(modelAccess, 'object');
    }
    const prisma = receiver?.type === 'identifier' && receiver.text === 'prisma'
      || receiver?.type === 'member_expression' && field(receiver, 'object')?.type === 'this' && field(receiver, 'property')?.text === 'prisma';
    if (!prisma) {
      if (receiver?.type !== 'identifier') continue;
      calls ??= new Map(facts.calls.map(call => [call.node.startIndex, call]));
      if (!isTransactionParameter(receiver, calls.get(node.startIndex), facts)) continue;
    }
    if (stores.length === 8) { storesOmitted++; continue; }
    stores.push({ model, action, site: routeSite(node, facts) });
  }
  return { stops, stopsOmitted, stores, storesOmitted };
}

/** Walks one body, leaving nested functions for their own flow nodes. */
function* bodyNodes(root: Node | null, stop: () => void): Generator<Node> {
  const pending = root ? [root] : [];
  while (pending.length) {
    stop();
    const node = pending.pop()!;
    yield node;
    if (!functionTypes.has(node.type)) pending.push(...node.namedChildren.toReversed());
  }
}

function displayLiteral(node: Node | null): string | null {
  if (!node) return null;
  const value = literal(node);
  if (value !== null || node.type !== 'template_string') return value;
  let text = node.text;
  for (const part of node.namedChildren.toReversed()) {
    if (part.type === 'template_substitution') text = text.slice(0, part.startIndex - node.startIndex) + '…' + text.slice(part.endIndex - node.startIndex);
  }
  return text.slice(1, -1);
}

function attributeFor(fn: Node, resolvesName: (name: Node) => boolean, stop: () => void): Node | null {
  const inline = fn.parent?.type === 'jsx_expression' ? fn.parent.parent : null;
  if (inline?.type === 'jsx_attribute') return inline;
  const outer = enclosing(fn);
  return outer?.descendantsOfType('jsx_attribute').find(attribute => {
    stop();
    if (!/^on[A-Z]/.test(firstCode(attribute)?.text ?? '')) return false;
    const expression = attribute.namedChildren.find(child => child.type === 'jsx_expression');
    const name = firstCode(expression ?? null);
    return name?.type === 'identifier' && resolvesName(name);
  }) ?? null;
}

function visibleBranches(value: Node | null): string[] {
  if (!value) return [];
  value = unwrapped(value);
  if (value.type === 'ternary_expression') return [...visibleBranches(field(value, 'consequence')), ...visibleBranches(field(value, 'alternative'))];
  if (value.type === 'binary_expression' && field(value, 'operator')?.text === '&&') return visibleBranches(field(value, 'right'));
  const text = literal(value);
  return text === null ? [] : [text];
}

function controlTexts(tag: Node, stop: () => void): string[] {
  if (field(tag, 'name')?.text === 'form') return [];
  const attributes = tag.namedChildren.filter(child => child.type === 'jsx_attribute');
  const stringAttribute = (key: string) => literal(attributes.find(attr => firstCode(attr)?.text === key)?.namedChildren[1] ?? null);
  const aria = stringAttribute('aria-label');
  if (aria !== null) return [aria];
  if (tag.type === 'jsx_self_closing_element') {
    const value = stringAttribute('title') ?? stringAttribute('value');
    return value === null ? [] : [value];
  }
  const children = tag.parent!.namedChildren.filter(child => !['jsx_opening_element', 'jsx_closing_element', 'comment'].includes(child.type)
    && !(child.type === 'jsx_text' && !child.text.trim()));
  const expression = children.length === 1 && children[0].type === 'jsx_expression' ? firstCode(children[0]) : null;
  const value = expression && unwrapped(expression);
  if (value && (value.type === 'ternary_expression' || value.type === 'binary_expression' && field(value, 'operator')?.text === '&&')) return visibleBranches(value);
  const parts: string[] = [];
  const pending = [...children].reverse();
  while (pending.length) {
    stop();
    const child = pending.pop()!;
    if (child.type === 'jsx_text') parts.push(child.text);
    if (child.type === 'jsx_expression') parts.push(literal(firstCode(child)) ?? '');
    if (child.type === 'jsx_element') pending.push(...child.namedChildren.toReversed());
  }
  return [parts.join('').replace(/\s+/g, ' ').trim()].filter(Boolean);
}

function controlOf(fn: Node, resolvesName: (name: Node) => boolean, stop: () => void): { event: string; control: FlowControl } | null {
  const attribute = attributeFor(fn, resolvesName, stop);
  const tag = attribute?.parent;
  const event = attribute && firstCode(attribute)?.text;
  if (!tag || !event || !/^on[A-Z]/.test(event) || !['jsx_opening_element', 'jsx_self_closing_element'].includes(tag.type)) return null;
  const texts = controlTexts(tag, stop);
  return { event, control: { tag: field(tag, 'name')?.text ?? '', texts: [...new Set(texts.map(text => clip(text, 30)))].slice(0, 3) } };
}

function askOf(fn: Node, facts: FileFacts): FlowAsk[] {
  const body = field(fn, 'body');
  const first = body?.type === 'statement_block' ? firstCode(body) : null;
  const condition = first?.type === 'if_statement' ? field(first, 'condition') : null;
  const test = condition && unwrapped(condition);
  const argument = test?.type === 'unary_expression' && field(test, 'operator')?.text === '!' ? field(test, 'argument') : null;
  const confirm = argument && unwrapped(argument);
  const callee = confirm?.type === 'call_expression' ? field(confirm, 'function')?.text : null;
  if (callee !== 'confirm' && callee !== 'window.confirm') return [];
  const consequence = first && field(first, 'consequence');
  const returns = consequence?.type === 'statement_block' ? consequence.namedChildren.filter(child => child.type !== 'comment') : consequence ? [consequence] : [];
  if (returns.length !== 1 || returns[0].type !== 'return_statement' || firstCode(returns[0])) return [];
  const message = displayLiteral(firstCode(field(confirm!, 'arguments')));
  return [{ message: message === null ? null : clip(message, 80), site: routeSite(first!, facts) }];
}

function afterSources(fn: Node, fileId: string, requestPairs: Node[], call: Node | null, awaits: Node[], front: Set<string>): { when: FlowAfter['when']; value: Node }[] {
  const callbacks: { when: FlowAfter['when']; value: Node }[] = [];
  const options = (object: Node) => {
    for (const pair of object.namedChildren) {
      const key = propertyName(field(pair, 'key'));
      const when = key === 'onSuccess' ? 'success' : key === 'onError' ? 'error' : key === 'onSettled' ? 'settled' : null;
      const value = field(pair, 'value');
      if (when && value && (functionTypes.has(value.type) || value.type === 'identifier')) callbacks.push({ when, value });
    }
  };
  if (requestPairs.length === 1) {
    const pair = requestPairs[0];
    const value = field(pair, 'value');
    if (value && functionTypes.has(value.type) && front.has(keyOf(fileId, value.startIndex, value.endIndex))) options(pair.parent!);
  }
  const method = call && field(call, 'function');
  if (method?.type === 'member_expression' && ['mutate', 'mutateAsync'].includes(field(method, 'property')?.text ?? '')) {
    const second = field(call!, 'arguments')?.namedChildren.filter(child => child.type !== 'comment')[1];
    if (second?.type === 'object') options(second);
  }
  const awaited = awaits.length === 1 ? awaits[0] : null;
  if (!call || !awaited || awaited.startIndex > call.startIndex || awaited.endIndex < call.endIndex) return callbacks;
  let statement = awaited;
  while (statement.parent && statement.parent.type !== 'statement_block' && !sameRange(statement.parent, fn)) statement = statement.parent;
  const block = statement.parent;
  if (block?.type !== 'statement_block') return callbacks;
  callbacks.push(...block.namedChildren.filter(child => child.startIndex >= statement.endIndex).map(value => ({ when: 'success' as const, value })));
  const parent = block.parent;
  if (parent?.type !== 'try_statement' || field(parent, 'body')?.startIndex !== block.startIndex) return callbacks;
  const caught = field(field(parent, 'handler'), 'body');
  const final = field(field(parent, 'finalizer'), 'body');
  if (caught) callbacks.push({ when: 'error', value: caught });
  if (final) callbacks.push({ when: 'settled', value: final });
  return callbacks;
}

function afterAction(node: Node): Pick<FlowAfter, 'action' | 'target'> {
  const callee = field(node, 'function');
  const name = callee?.type === 'member_expression' ? field(callee, 'property')?.text : callee?.text;
  const object = callee?.type === 'member_expression' ? field(callee, 'object')?.text : null;
  if (['invalidateQueries', 'refetchQueries', 'resetQueries', 'refetch'].includes(name ?? '')) return { action: 'refresh', target: null };
  if (name === 'setQueryData') return { action: 'cache', target: null };
  if (name === 'cancelQueries') return { action: 'cancel', target: null };
  if (object === 'router' && ['push', 'replace'].includes(name ?? '') || !object && ['navigate', 'redirect'].includes(name ?? '')) {
    return { action: 'navigate', target: displayLiteral(firstCode(field(node, 'arguments'))) };
  }
  if (callee?.type === 'identifier' && /^set[A-Z]\w*/.test(callee.text)) {
    return { action: 'state', target: callee.text[3].toLowerCase() + callee.text.slice(4) };
  }
  if (callee?.text === 'alert' || callee?.text === 'window.alert' || callee?.text === 'toast' || object === 'toast') return { action: 'notify', target: null };
  return { action: 'call', target: node.type === 'identifier' ? node.text : clip(firstLine(node), 48) };
}

function frontFacts(fn: Node, facts: FileFacts, toward: ValueSite, inside: boolean, front: Set<string>, stop: () => void): Pick<FlowNode, 'asks' | 'after' | 'afterOmitted'> {
  const asks = inside ? [] : askOf(fn, facts);
  const requestPairs: Node[] = [];
  const awaits: Node[] = [];
  let call: Node | null = null;
  for (const node of bodyNodes(field(fn, 'body'), stop)) {
    if (node.type === 'pair' && ['mutationFn', 'queryFn'].includes(propertyName(field(node, 'key')) ?? '')) requestPairs.push(node);
    if (!inside && node.type === 'call_expression' && node.startIndex === toward.startUtf16) call ??= node;
    if (node.type === 'await_expression') awaits.push(node);
  }
  const callbacks = afterSources(fn, facts.file.id, requestPairs, call, awaits, front);
  const after: FlowAfter[] = [];
  const sites = new Set<number>();
  let afterOmitted = 0;
  for (const { when, value } of callbacks) {
    const root = functionTypes.has(value.type) ? field(value, 'body') : value;
    for (const node of bodyNodes(root, stop)) {
      if (node.type !== 'call_expression' && !(node === value && node.type === 'identifier')) continue;
      if (sites.has(node.startIndex)) continue;
      sites.add(node.startIndex);
      if (after.length >= 6) { afterOmitted++; continue; }
      after.push({ when, ...afterAction(node), site: routeSite(node, facts) });
    }
  }
  after.sort((a, b) => a.site.startUtf16 - b.site.startUtf16);
  return { asks, after, afterOmitted };
}

/** A bounded graph for one receiving route. All arrows describe code, not observed execution. */
export async function buildFeatureFlow(root: string, projectId: string, files: ProjectFile[], routes: ProjectRoutes, routeIndex: number,
  limits: MapLimits = MAP_LIMITS, shouldStop: () => boolean = () => false,
  cache: CallsCache = { texts: new Map(), parsed: new Map() }): Promise<FeatureFlow> {
  const stop = () => { if (shouldStop()) throw new AppError('CANCELLED', '기능 흐름 찾기를 취소했어요.'); };
  const route = routes.routes[routeIndex];
  if (routes.projectId !== projectId || !route) throw new AppError('CHANGED', '기능 목록을 다시 찾아 주세요.');
  const flow: FeatureFlow = { projectId, routesId: routes.routesId, routeIndex, nodes: [], edges: [], limited: routes.limited, notes: [...routes.notes] };
  const parsedFiles = new Set<string>();
  cache = { ...cache, parsedFiles };
  const results = new Map<string, { found: FunctionCalls; facts: FileFacts; fn: Node }>();
  const known = new Map(files.map(file => [file.relativePath, file]));
  const referencesByStart = new Map<string, Map<number, FileFacts['references'][number]>>();
  const referenceAt = (info: FileFacts, node: Node) => {
    let references = referencesByStart.get(info.file.id);
    if (!references) {
      references = new Map(info.references.map(reference => [reference.node.startIndex, reference]));
      referencesByStart.set(info.file.id, references);
    }
    const reference = references.get(node.startIndex);
    return reference && sameRange(reference.node, node) ? reference : undefined;
  };
  const declarationAt = (info: FileFacts, name: Node): Declaration | null => {
    const reference = referenceAt(info, name);
    const resolved = reference && nearest(reference.scope, name.text);
    if (!resolved || resolved.declared.length !== 1 || reassigned(info, name.text, resolved.scope)) return null;
    return resolved.declared[0];
  };
  const resolvesToFn = (info: FileFacts, name: Node, fn: Node): boolean => {
    const declaration = declarationAt(info, name);
    return declaration?.kind === 'function' && sameRange(declaration.fn, fn);
  };
  const importsThisFile = (info: FileFacts, declaration: Declaration, local: string, facts: FileFacts, found: FunctionCalls): boolean => {
    if (declaration.kind !== 'import' || !declaration.specifier || !isRelative(declaration.specifier)) return false;
    const candidates = candidatesFor(info.file.relativePath, declaration.specifier, known);
    if (candidates?.length !== 1 || known.get(candidates[0])?.id !== facts.file.id) return false;
    return declaration.imported === 'default' ? found.names.exported.includes('default')
      : local === declaration.imported && found.names.exported.includes(declaration.imported);
  };
  const returnedHooks = new Map<string, ReturnedHook[]>();
  const hooksOf = (info: FileFacts) => {
    const cached = returnedHooks.get(info.file.id);
    if (cached) return cached;
    const hooks: ReturnedHook[] = [];
    for (const hook of info.functions) {
      stop();
      if (!/^use[A-Z]/.test(functionName(hook))) continue;
      const properties: ReturnedHook['properties'] = [];
      const body = field(hook, 'body');
      for (const pair of bodyNodes(body, stop)) {
        const object = pair.parent;
        if (object?.type !== 'object' || !(object.parent?.type === 'return_statement' || body && sameRange(unwrapped(body), object))) continue;
        const value = pair.type === 'shorthand_property_identifier' ? pair : field(pair, 'value');
        const name = pair.type === 'shorthand_property_identifier' ? pair.text : propertyName(field(pair, 'key'));
        if (!name || !value || !['identifier', 'shorthand_property_identifier'].includes(value.type)) continue;
        const declaration = declarationAt(info, value);
        if (declaration) properties.push({ name, local: value.text, declaration });
      }
      if (properties.length) hooks.push({ hook, properties });
    }
    returnedHooks.set(info.file.id, hooks);
    return hooks;
  };
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
      event: null, control: null, asks: [], after: [], afterOmitted: 0, screen: null, outside: [], outsideOmitted: 0, stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0 };
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
    stop();
    const key = keyOf(node.fileId, node.range.startUtf16, node.range.endUtf16);
    let result = results.get(key);
    if (!result) {
      const found = await findFunctionCalls(root, projectId, files, targetOf(node), limits, shouldStop, cache);
      if (found.limited || found.unexamined.length) limit('일부 파일은 끝까지 확인하지 못했어요.');
      const facts = cache.parsed.get(node.fileId)!;
      const fn = facts.functions.find(fn => fn.startIndex === node.range.startUtf16 && fn.endIndex === node.range.endUtf16)!;
      result = { found, facts, fn };
      results.set(key, result);
    }
    node.range = { startUtf16: result.fn.startIndex, endUtf16: result.fn.endIndex, ...lineRange(result.fn) };
    return result;
  };
  const back = add('back', route.handler, 0)!;
  const backQueue = [back];
  const backSeen = new Set<string>();
  while (backQueue.length) {
    const node = backQueue.shift()!;
    if (backSeen.has(node.id)) continue;
    backSeen.add(node.id);
    const { found, facts, fn } = await inspect(node);
    Object.assign(node, serverFacts(fn, facts));
    const outside = found.calls.filter(call => call.status === 'external' || call.status === 'unknown').map(call => call.text);
    // Only callbacks passed directly as arguments to a call in this body, one nested level.
    // Each callback is a whole call search, and only a few lines of it are shown: the first three are read.
    const callbacks = facts.functions.filter(child => isDirectCallback(child, fn));
    if (callbacks.length > 3) limit('안쪽 함수는 함수마다 3개까지만 봐요.');
    for (const callback of callbacks.slice(0, 3)) {
      stop();
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
  const hookExpanded = new Set<string>();
  const followHookUses = (callers: NonNullable<FunctionCalls['callers']>, destination: FlowNode, properties: Set<string> | null) => {
    let uses = 0;
    for (const caller of callers) {
      const info = cache.parsed.get(caller.fileId);
      const call = info?.calls.find(item => item.node.startIndex === caller.startUtf16);
      if (!info || !call?.fn) continue;
      const declarator = call.node.parent;
      if (declarator?.type !== 'variable_declarator' || !field(declarator, 'value') || !sameRange(field(declarator, 'value')!, call.node)) continue;
      const variables = info.variables.filter(item => item.source && sameRange(item.source, declarator) && item.node && !reassigned(info, item.node.text, item.scope));
      for (const variable of variables) for (const use of info.calls) {
        stop();
        if (!use.fn || use.node.startIndex < call.fn.startIndex || use.node.endIndex > call.fn.endIndex) continue;
        const callee = field(use.node, 'function');
        const name = variable.shape === 'plain' && callee?.type === 'member_expression' ? field(callee, 'object') : callee?.type === 'identifier' && variable.shape === 'destructured' ? callee : null;
        if (!name || name.text !== variable.node!.text || nearest(use.scope, name.text)?.scope !== variable.scope) continue;
        const binding = variable.node!.parent;
        const key = variable.shape === 'plain' ? field(callee, 'property')?.text
          : binding?.type === 'pair_pattern' ? propertyName(field(binding, 'key')) : variable.node!.text;
        if (properties !== null && (!key || !properties.has(key))) continue;
        if (uses >= 3) { limit('훅 결과를 쓰는 곳은 훅마다 3개까지만 보여요.'); continue; }
        const parent = add('front', { ...routeSite(use.fn, info), name: functionName(use.fn) }, 0);
        if (parent) { edge(parent, destination, 'hook', requestSite(use, info), properties === null ? [`훅이 돌려준 값 ${shortName(name.text)}를 써요`] : [`훅이 돌려준 ${key} 함수를 불러요`], false); queue.push(parent); uses++; }
      }
    }
  };
  while (queue.length) {
    const node = queue.shift()!;
    const needsHook = viaInside.has(node.id) && /^use[A-Z]/.test(node.name) && !hookExpanded.has(node.id);
    if (expanded.has(node.id) && !needsHook) continue;
    const already = expanded.has(node.id);
    expanded.add(node.id);
    const { found, facts, fn } = await inspect(node);
    if (!already && node.event === null) Object.assign(node, controlOf(fn, name => resolvesToFn(facts, name, fn), stop));
    const next = nextRouteOf(node.relativePath, files.map(file => file.relativePath));
    if (next?.kind === 'page' && facts.exports.get('default')?.some(item => item.fn && sameRange(item.fn, fn))) {
      node.screen = formatNextPath(next.segments); continue;
    }
    const allCallers = [...(found.callers ?? []), ...found.typedCallers].filter(site => !site.inTest);
    if (allCallers.length > 50) limit('함수마다 부르는 곳은 50개까지만 따라가요.');
    const callers = allCallers.slice(0, 50);
    if (!already) {
      for (const caller of callers) {
        if (!caller.inFunction) continue;
        const parent = add('front', { fileId: caller.fileId, fileHash: caller.fileHash, ...caller.inFunction }, 0);
        if (!parent) continue;
        if (!expanded.has(parent.id)) {
          const info = cache.parsed.get(parent.fileId)!;
          const fn = info.functions.find(fn => fn.startIndex === parent.range.startUtf16 && fn.endIndex === parent.range.endUtf16)!;
          Object.assign(parent, controlOf(fn, name => resolvesToFn(info, name, fn), stop));
        }
        edge(parent, node, 'basis' in caller ? 'typed' : parent.event !== null ? 'event' : 'calls', caller);
        queue.push(parent);
      }
      if (!callers.length) {
        const outer = enclosing(fn);
        if (outer) {
          const parent = add('front', { ...routeSite(outer, facts), name: functionName(outer) }, 0);
          if (parent) { edge(parent, node, 'inside', routeSite(fn, facts)); viaInside.add(parent.id); queue.push(parent); }
        }
      }
    }
    if (!already) {
      let hooks = 0;
      hookFiles: for (const info of [...parsedFiles].map(id => cache.parsed.get(id)!)) {
        stop();
        if (!info.complete || info.unclear || isTestFile(info.file.relativePath)) continue;
        for (const { hook, properties: returned } of hooksOf(info)) {
          stop();
          const properties = new Set<string>();
          for (const { name, local, declaration } of returned) {
            if (declaration.kind === 'function' && info.file.id === facts.file.id && sameRange(declaration.fn, fn)) { properties.add(name); continue; }
            if (declaration.kind !== 'import' || !importsThisFile(info, declaration, local, facts, found)) continue;
            const exported = facts.exports.get(declaration.imported);
            if (exported?.length !== 1 || exported[0].local && reassigned(facts, exported[0].local, facts.program)) continue;
            properties.add(name);
          }
          if (!properties.size) continue;
          if (hooks >= 3) { limit('돌려주는 훅은 함수마다 3개까지만 봐요.'); break hookFiles; }
          hooks++;
          const target = { ...routeSite(hook, info), name: functionName(hook) };
          const key = keyOf(target.fileId, target.startUtf16, target.endUtf16);
          let hookCalls = results.get(key)?.found;
          if (!hookCalls) {
            hookCalls = await findFunctionCalls(root, projectId, files, target, limits, shouldStop, cache);
            results.set(key, { found: hookCalls, facts: info, fn: hook });
            if (hookCalls.limited || hookCalls.unexamined.length) limit('일부 파일은 끝까지 확인하지 못했어요.');
          }
          const callers = [...(hookCalls.callers ?? []), ...hookCalls.typedCallers].filter(caller => !caller.inTest);
          followHookUses(callers, node, properties);
        }
      }
    }
    if (needsHook) {
      hookExpanded.add(node.id);
      followHookUses(callers, node, null);
    }

    if (!already && /^[A-Z]/.test(node.name)) {
      // A component's same-name import or default import must resolve to exactly this file.
      for (const id of parsedFiles) {
        const info = cache.parsed.get(id)!;
        stop();
        if (!info.complete || info.unclear || isTestFile(info.file.relativePath)) continue;
        const names = new Set<string>();
        if (info.file.id === facts.file.id) names.add(node.name);
        for (const [local, declarations] of info.program.names) {
          if (declarations.length !== 1 || declarations[0].kind !== 'import' || reassigned(info, local, info.program)) continue;
          if (!importsThisFile(info, declarations[0], local, facts, found)) continue;
          names.add(local);
        }
        if (!names.size) continue;
        const anchor = info.functions[0] ?? info.references[0]?.node;
        if (!anchor) continue;
        let tree = anchor;
        while (tree.parent) tree = tree.parent;
        const tags = tree.descendantsOfType(['jsx_opening_element', 'jsx_self_closing_element']);
        for (const tag of tags) {
          stop();
          const name = field(tag, 'name');
          const outer = enclosing(tag);
          if (!name || !names.has(name.text) || !outer || outer.startIndex === fn.startIndex && info.file.id === facts.file.id) continue;
          // Scope references avoid a JSX name shadowed by a local parameter or declaration.
          const reference = referenceAt(info, name);
          const resolved = reference && nearest(reference.scope, name.text);
          if (resolved && resolved.scope !== info.program && !(info.file.id === facts.file.id && resolvesToFn(info, name, fn))) continue;
          const parent = add('front', { ...routeSite(outer, info), name: functionName(outer) }, 0);
          if (parent) { edge(parent, node, 'placed', routeSite(tag, info)); queue.push(parent); }
        }
      }
    }
  }
  // Count positions only after every upstream branch has been discovered.
  const front = flow.nodes.filter(node => node.side === 'front');
  const frontKeys = new Set(front.map(node => keyOf(node.fileId, node.range.startUtf16, node.range.endUtf16)));
  for (const node of front) {
    stop();
    const result = results.get(keyOf(node.fileId, node.range.startUtf16, node.range.endUtf16));
    if (!result) continue;
    const { found, facts, fn } = result;
    const outgoing = flow.edges.filter(edge => edge.from === node.id && edge.kind !== 'placed');
    const positions = new Map<string, ValueSite>();
    const sites = [...outgoing.flatMap(edge => edge.site ? [edge.site] : []),
      ...found.calls.filter(call => call.status === 'linked' || call.status === 'typed'),
      ...routes.requests.filter(request => request.fileId === node.fileId && request.inFunction?.startUtf16 === node.range.startUtf16
        && request.inFunction.endUtf16 === node.range.endUtf16)];
    for (const site of sites) positions.set(`${site.fileId}:${site.startUtf16}`, site);
    if (positions.size >= 2) { limit('여러 곳을 부르는 함수는 확인 창과 응답 뒤 할 일을 찾지 않았어요.'); continue; }
    const toward = [...positions.values()][0];
    if (!toward) continue;
    const inside = outgoing.some(edge => edge.kind === 'inside' && edge.site?.startUtf16 === toward.startUtf16);
    Object.assign(node, frontFacts(fn, facts, toward, inside, frontKeys, stop));
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

export const FLOW_BATCH_LIMIT = 200;

/** Every route's flow with one shared read cache; each flow equals the one buildFeatureFlow makes alone. */
export async function buildFeatureFlows(root: string, projectId: string, files: ProjectFile[], routes: ProjectRoutes,
  limits: MapLimits = MAP_LIMITS, shouldStop: () => boolean = () => false): Promise<FeatureFlow[]> {
  if (routes.routes.length > FLOW_BATCH_LIMIT) throw new AppError('LIMIT', `서버 주소가 ${FLOW_BATCH_LIMIT}개를 넘어 화면별로 묶지 않았어요.`);
  if (routes.projectId !== projectId) throw new AppError('CHANGED', '기능 목록을 다시 찾아 주세요.');
  const cache: CallsCache = { texts: new Map(), parsed: new Map() };
  const flows: FeatureFlow[] = [];
  for (let index = 0; index < routes.routes.length; index++) {
    if (shouldStop()) throw new AppError('CANCELLED', '화면별로 묶기를 취소했어요.');
    flows.push(await buildFeatureFlow(root, projectId, files, routes, index, limits, shouldStop, cache));
  }
  if (shouldStop()) throw new AppError('CANCELLED', '화면별로 묶기를 취소했어요.');
  assertResultSize(flows);
  return flows;
}
