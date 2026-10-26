import { randomUUID } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { CallSite, ProjectFile, ProjectRoutes, Request, Route, ValueSite } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { MAX_FILE_BYTES, readAllowed } from '../project/files';
import { candidatesFor, codeFile, isRelative, MAP_LIMITS, type MapLimits } from './project-map';
import { formatNextPath, nextRouteOf } from './next-routes';
import { firstLine, hasUnsupportedCertainty, lineRange, nearest, readFacts, reassigned, sameRange, simpleProperties, type CallFact, type FileFacts, type Scope } from './names';
import { functionName, functionTypes } from './syntax';

type Node = Parser.SyntaxNode;
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL']);
// A small file can still multiply into many routes (arrays of paths on both decorators), so the result is capped.
export const ROUTE_LIMITS = { routes: 1000, requests: 1000, links: 5000, pathLength: 300, segments: 30, name: 200, args: 5, work: 5_000_000,
  bytes: 4 * 1024 * 1024 } as const;
/** Names repeat in every route and request, so a long one is cut like other source text. */
export const shortName = (name: string) => name.length > ROUTE_LIMITS.name ? `${name.slice(0, ROUTE_LIMITS.name)}…` : name;
/** The last guard: whatever else a crafted project finds to repeat, a result this large is not sent on. */
export function assertResultSize(value: unknown): void {
  // Counted while walking, never by building the JSON: that string would be the very memory this guards. Shared
  // objects count each time, as they would when sent. Strings count at UTF-8's worst case.
  let total = 0;
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') total += item.length * 3 + 2;
    else if (Array.isArray(item)) { total += 2; for (const entry of item) pending.push(entry); }
    else if (item && typeof item === 'object') for (const [key, entry] of Object.entries(item)) { total += key.length + 4; pending.push(entry); }
    else total += 8;
    if (total > ROUTE_LIMITS.bytes) throw new AppError('LIMIT', '결과가 너무 커서 보여 주지 않았어요.');
  }
}
// A longer path is treated as unreadable: it would multiply the result's size and the matching work.
const bounded = (path: string): string | null =>
  path.length <= ROUTE_LIMITS.pathLength && path.split('/').length - 1 <= ROUTE_LIMITS.segments ? path : null;
export const isTestFile = (name: string) => /(^|\/)__tests__\//.test(name) || /\.(test|spec)\.[^/]+$/.test(name);
const children = (node: Node | null | undefined) => node?.namedChildren.filter(child => child.type !== 'comment') ?? [];
const argsOf = (node: Node) => children(node.childForFieldName('arguments'));
const field = (node: Node | null | undefined, name: string) => node?.childForFieldName(name) ?? null;
export const literal = (node: Node | null | undefined): string | null => node && (node.type === 'string' || node.type === 'template_string')
  && !node.text.includes('\\') && !node.namedChildren.some(child => child.type === 'template_substitution') ? node.text.slice(1, -1) : null;
const keyOf = (node: Node): string | null => {
  if (node.type === 'shorthand_property_identifier') return node.text;
  const key = field(node, 'key') ?? field(node, 'name');
  return key && ['property_identifier', 'identifier'].includes(key.type) ? key.text : literal(key);
};
const property = (node: Node | null) => node?.type === 'member_expression' ? field(node, 'property')?.text : null;
const joinPath = (...parts: string[]) => '/' + parts.flatMap(part => part.split('/').filter(Boolean)).join('/');
export const routeSite = (node: Node, facts: FileFacts): ValueSite => ({ fileId: facts.file.id, fileHash: facts.hash,
  startUtf16: node.startIndex, endUtf16: node.endIndex, ...lineRange(node), text: firstLine(node) });
export function requestSite(call: CallFact, facts: FileFacts): CallSite {
  return { ...routeSite(call.node, facts), args: argsOf(call.node).slice(0, ROUTE_LIMITS.args).map(node => ({ text: firstLine(node), spread: node.type === 'spread_element' })),
    inTest: isTestFile(facts.file.relativePath), inFunction: call.fn ? { name: shortName(functionName(call.fn)), startUtf16: call.fn.startIndex,
      endUtf16: call.fn.endIndex, startLine: call.fn.startPosition.row + 1 } : null };
}

/** Reads only the registered files, with the same byte/file/tree budgets as the map. */
export async function findProjectRoutes(root: string, projectId: string, files: ProjectFile[], limits: MapLimits = MAP_LIMITS,
  shouldStop: () => boolean = () => false): Promise<ProjectRoutes> {
  const result: ProjectRoutes = { projectId, routesId: randomUUID(), routes: [], requests: [], links: [], prefix: null, limited: false, notes: [] };
  const known = new Map(files.map(file => [file.relativePath, file]));
  const facts = new Map<string, FileFacts>();
  const trees = new Map<string, Node[]>();
  let bytes = 0;
  let count = 0;
  let incomplete = false;
  let omitted = false;
  const room = (list: unknown[], max: number) => { if (list.length < max) return true; omitted = true; return false; };
  // Files read but not fully parsed: their raw text can still prove a setting is absent.
  const partial: string[] = [];
  for (const file of files.filter(file => codeFile.test(file.relativePath) && !isTestFile(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
    const left = limits.bytes - bytes;
    if (count >= limits.files || left <= 0) { incomplete = true; result.limited = true; continue; }
    count++;
    try {
      const source = await readAllowed(root, file.relativePath, Math.min(MAX_FILE_BYTES, left));
      bytes += Buffer.byteLength(source.text);
      const info = readFacts(file, source.text, source.hash, limits.nodesPerFile, true);
      facts.set(file.id, info);
      if (!info.complete) { partial.push(source.text); result.limited = true; result.notes.push(`${file.relativePath}: ${info.incompleteReason ?? '일부만 확인했어요.'}`); }
      // readFacts already has a parsed tree, including files without functions or calls via references.
      const anchor = info.functions[0] ?? info.calls[0]?.node ?? info.references[0]?.node ?? info.variables[0]?.source;
      if (!anchor) { trees.set(file.id, []); continue; }
      let tree = anchor;
      while (tree.parent) tree = tree.parent;
      const nodes: Node[] = [];
      const pending = [tree];
      while (pending.length && nodes.length < limits.nodesPerFile) {
        const node = pending.pop()!;
        nodes.push(node);
        if (!node.isError && !node.isMissing) pending.push(...node.namedChildren.toReversed());
      }
      if (pending.length) { partial.push(source.text); result.limited = true; }
      trees.set(file.id, nodes);
    } catch (error) {
      incomplete = true;
      result.limited = true;
      result.notes.push(`${file.relativePath}: ${error instanceof AppError ? error.message : '파일을 읽지 못했어요.'}`);
    }
  }
  const declaration = (info: FileFacts, scope: Scope, name: string) => {
    const found = nearest(scope, name);
    return info.complete && !info.unclear && found?.declared.length === 1 && !reassigned(info, name, found.scope) ? found.declared[0] : null;
  };
  const imported = (info: FileFacts, scope: Scope, name: string, pkg: string, exported: string) => {
    const item = declaration(info, scope, name);
    return item?.kind === 'import' && item.specifier === pkg && item.imported === exported;
  };
  const importedFacts = (info: FileFacts, specifier: string | null) => {
    if (!specifier || !isRelative(specifier)) return null;
    const candidates = candidatesFor(info.file.relativePath, specifier, known);
    return candidates?.length === 1 ? facts.get(known.get(candidates[0])!.id) ?? null : null;
  };
  const resolveFunction = (info: FileFacts, scope: Scope, node: Node): { info: FileFacts; fn: Node } | null => {
    if (functionTypes.has(node.type)) return { info, fn: node };
    if (node.type !== 'identifier') return null;
    const item = declaration(info, scope, node.text);
    if (item?.kind === 'function') return { info, fn: item.fn };
    if (item?.kind !== 'import' || item.imported !== node.text) return null;
    const other = importedFacts(info, item.specifier);
    const entries = other?.exports.get(item.imported);
    if (!other || entries?.length !== 1 || !entries[0].fn || !entries[0].local) return null;
    const target = declaration(other, other.program, entries[0].local);
    return target?.kind === 'function' ? { info: other, fn: target.fn } : null;
  };
  const target = (info: FileFacts, fn: Node) => ({ fileId: info.file.id, fileHash: info.hash, startUtf16: fn.startIndex,
    endUtf16: fn.endIndex, startLine: fn.startPosition.row + 1, name: shortName(functionName(fn)) });
  const prefixes = [...facts.values()].flatMap(info => info.calls.filter(call => property(field(call.node, 'function')) === 'setGlobalPrefix').map(call => ({ info, call })));
  const prefixTexts = prefixes.map(({ call }) => argsOf(call.node).length === 1 ? literal(argsOf(call.node)[0]) : null);
  // An unread file, or a partly parsed one that mentions the call, could hold a prefix this scan missed.
  const prefixHidden = incomplete || partial.some(text => text.includes('setGlobalPrefix'));
  const prefixKnown = !prefixHidden && !prefixTexts.includes(null) && new Set(prefixTexts).size <= 1;
  const globalPrefix = prefixKnown ? prefixTexts[0] ?? '' : '';
  if (prefixKnown && prefixes.length) result.prefix = { text: globalPrefix, site: routeSite(prefixes[0].call.node, prefixes[0].info) };
  if (!prefixKnown) result.notes.push('앱 전체 앞 경로를 확정하지 못했어요');
  if (prefixHidden) result.notes.push('모든 파일을 읽지 못해 앞 경로를 확정하지 않았어요');
  const versioning = [...facts.values()].some(info => info.calls.some(call => (property(field(call.node, 'function')) ?? field(call.node, 'function')?.text) === 'enableVersioning'));
  const decorators = (node: Node) => {
    const found = children(node).filter(child => child.type === 'decorator');
    if (node.type === 'method_definition') for (let previous = node.previousNamedSibling; previous; previous = previous.previousNamedSibling) {
      if (previous.type === 'comment') continue;
      if (previous.type !== 'decorator') break;
      found.unshift(previous);
    }
    return found;
  };
  const decoratorName = (node: Node) => field(children(node)[0], 'function')?.text ?? children(node)[0]?.text;
  const pathsOf = (decorator: Node, controller = false): (string | null)[] => {
    let arg = argsOf(children(decorator)[0])[0];
    if (!arg) return [''];
    if (controller && arg.type === 'object') arg = field(children(arg).find(item => keyOf(item) === 'path'), 'value')!;
    if (!arg) return [null];
    if (arg.type === 'array') { const values = children(arg).map(literal); return values.includes(null) ? [null] : values; }
    return [literal(arg)];
  };
  for (const info of facts.values()) {
    if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
    for (const cls of trees.get(info.file.id) ?? []) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      if (!['class_declaration', 'abstract_class_declaration'].includes(cls.type)) continue;
      const classDecorators = [...decorators(cls), ...(cls.parent?.type === 'export_statement' ? decorators(cls.parent) : [])];
      const controller = classDecorators.find(node => decoratorName(node) === 'Controller');
      if (!controller) continue;
      for (const fn of children(field(cls, 'body')).filter(node => node.type === 'method_definition' && field(node, 'body'))) {
        for (const decorator of decorators(fn)) {
          const method = decoratorName(decorator)?.toUpperCase();
          if (!method || !methods.has(method)) continue;
          const paths = pathsOf(decorator);
          for (const base of pathsOf(controller, true)) for (const path of paths) {
            if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
            if (!room(result.routes, ROUTE_LIMITS.routes)) break;
            result.routes.push({ method: method as Route['method'], path: base === null || path === null ? null : bounded(joinPath(globalPrefix, base, path)),
              prefix: prefixKnown && !versioning && ![...classDecorators, ...decorators(fn)].some(node => decoratorName(node) === 'Version') ? 'known' : 'unknown',
              framework: 'nest', handler: target(info, fn), basis: { text: firstLine(decorator), range: routeSite(decorator, info) } });
          }
        }
      }
    }
    const next = nextRouteOf(info.file.relativePath, files.map(file => file.relativePath));
    if (next?.kind === 'route' || next?.kind === 'pages-api') {
      const configRoot = next.root.replace(/(?:^|\/)(?:src\/)?(?:app|pages)$/, '');
      const configs = files.filter(file => file.relativePath.replace(/(?:^|\/)next\.config\.[^/]+$/, '') === configRoot && /(?:^|\/)next\.config\./.test(file.relativePath));
      const prefix = configs.some(file => !facts.has(file.id) || facts.get(file.id)!.text.includes('basePath')) ? 'unknown' : 'known';
      for (const [name, entries] of info.exports) {
        const method = next.kind === 'pages-api' ? name === 'default' ? 'ALL' : null : methods.has(name) && name !== 'ALL' ? name : null;
        if (!method) continue;
        for (const entry of entries) if (entry.fn && room(result.routes, ROUTE_LIMITS.routes)) result.routes.push({ method: method as Route['method'], path: bounded(formatNextPath(next.segments)),
          prefix, framework: 'next', segments: next.segments, handler: target(info, entry.fn), basis: { text: info.file.relativePath, range: routeSite(entry.fn, info) } });
      }
    }
    for (const call of info.calls) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      const callee = field(call.node, 'function');
      const receiver = field(callee, 'object');
      const method = property(callee)?.toUpperCase();
      if (!method || !methods.has(method) || receiver?.type !== 'identifier') continue;
      const item = declaration(info, call.scope, receiver.text);
      if (item?.kind !== 'variable' || item.info?.role !== 'const' || item.info.value?.type !== 'call_expression') continue;
      const create = field(item.info.value, 'function');
      const isApp = create?.type === 'identifier' && imported(info, item.info.scope, create.text, 'express', 'default');
      const isRouter = create?.type === 'identifier' && imported(info, item.info.scope, create.text, 'express', 'Router')
        || property(create) === 'Router' && imported(info, item.info.scope, field(create, 'object')?.text ?? '', 'express', 'default');
      if (!isApp && !isRouter) continue;
      const args = argsOf(call.node);
      const path = literal(args[0]);
      const last = args.at(-1);
      const handler = last && args.length >= 2 ? resolveFunction(info, call.scope, last) : null;
      if (path === null || !handler || !room(result.routes, ROUTE_LIMITS.routes)) continue;
      result.routes.push({ method: method as Route['method'], path: bounded(joinPath(path)), prefix: isApp ? 'known' : 'unknown', framework: 'express',
        handler: target(handler.info, handler.fn), basis: { text: firstLine(call.node), range: routeSite(call.node, info) } });
    }
  }

  interface Sender { wrapped?: boolean; fixedMethod?: string | null; axios: boolean; method: string | null; base: string; unknown: boolean; forwards: boolean }
  // Any defaults write may occur outside the current file. Unread files cannot establish its absence.
  const axiosDefaults = incomplete || partial.some(text => /\bdefaults\b/.test(text)) || [...facts.values()].some(info => (trees.get(info.file.id) ?? []).some(node =>
    ['assignment_expression', 'augmented_assignment_expression', 'update_expression'].includes(node.type)
      && /\.defaults\.baseURL\b/.test(field(node, 'left')?.text ?? node.text)));
  // Facts each call would otherwise look up across the whole file: computed once per file.
  const fetchShadowed = new Map<string, boolean>();
  const shadowsFetch = (info: FileFacts) => {
    if (!fetchShadowed.has(info.file.id)) fetchShadowed.set(info.file.id, info.variables.some(item => item.node?.text === 'fetch')
      || info.program.names.has('fetch') || info.functionDeclarations.some(item => item.name === 'fetch'));
    return fetchShadowed.get(info.file.id)!;
  };
  const defaultsWrites = new Map<string, string[]>();
  const writesDefaults = (info: FileFacts, name: string) => {
    if (!defaultsWrites.has(info.file.id)) defaultsWrites.set(info.file.id, (trees.get(info.file.id) ?? [])
      .filter(node => ['assignment_expression', 'augmented_assignment_expression', 'update_expression'].includes(node.type))
      .map(node => field(node, 'left')?.text ?? node.text));
    return defaultsWrites.get(info.file.id)!.some(text => text.startsWith(`${name}.defaults`));
  };
  function withConfig(sender: Sender, config: Node | null | undefined): Sender {
    if (!config) return sender;
    if (config.type !== 'object') return { ...sender, unknown: true };
    const parts = children(config);
    const base = parts.filter(node => keyOf(node) === 'baseURL');
    if (parts.some(node => keyOf(node) === null) || base.length > 1) return { ...sender, unknown: true };
    if (!base.length) return sender;
    const value = literal(field(base[0], 'value'));
    return value === null ? { ...sender, unknown: true } : { ...sender, base: value };
  }
  const instance = (info: FileFacts, scope: Scope, name: string, follow = true): Sender | null => {
    const item = declaration(info, scope, name);
    if (item?.kind === 'import' && follow && item.imported === name) {
      const other = importedFacts(info, item.specifier);
      const exported = other?.exports.get(name);
      return other && exported?.length === 1 && exported[0].local === name ? instance(other, other.program, name, false) : null;
    }
    if (item?.kind !== 'variable' || item.info?.value?.type !== 'call_expression') return null;
    const create = field(item.info.value, 'function');
    if (property(create) !== 'create' || !imported(info, item.info.scope, field(create, 'object')?.text ?? '', 'axios', 'default')) return null;
    const defaults = writesDefaults(info, name);
    return withConfig({ axios: true, method: null, base: '', unknown: axiosDefaults || defaults, forwards: true }, argsOf(item.info.value)[0]);
  };
  const wrappers = new Map<string, Sender>();
  // A crafted file can hold thousands of wrapper-shaped functions. Work is counted and cancels are checked
  // inside the search; past the budget the search stops and the result says so.
  let work = 0;
  let wrapperSearchCut = false;
  const spend = (amount: number) => {
    if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
    work += amount;
    return work <= ROUTE_LIMITS.work;
  };
  /** Parameters by their function, and nodes and calls in source order, so a function's own share is found by search. */
  const indexes = new Map<string, { parameters: Map<string, FileFacts['variables']>; callStarts: number[]; calls: CallFact[]; nodeStarts: number[] }>();
  const rangeKey = (node: Node) => `${node.startIndex}:${node.endIndex}`;
  const indexOf = (info: FileFacts) => {
    let index = indexes.get(info.file.id);
    if (!index) {
      const parameters = new Map<string, FileFacts['variables']>();
      for (const item of info.variables) if (item.role === 'parameter' && item.owner) {
        if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
        const key = rangeKey(item.owner);
        const list = parameters.get(key);
        if (list) list.push(item); else parameters.set(key, [item]);
      }
      const calls = [...info.calls].sort((a, b) => a.node.startIndex - b.node.startIndex);
      // Trees are walked in preorder, so start positions are already in order.
      index = { parameters, calls, callStarts: calls.map(call => call.node.startIndex), nodeStarts: (trees.get(info.file.id) ?? []).map(node => node.startIndex) };
      indexes.set(info.file.id, index);
    }
    return index;
  };
  const firstAtOrAfter = (starts: number[], value: number) => {
    let low = 0, high = starts.length;
    while (low < high) { const middle = (low + high) >> 1; if (starts[middle] < value) low = middle + 1; else high = middle; }
    return low;
  };
  const parametersOf = (info: FileFacts, fn: Node) => indexOf(info).parameters.get(rangeKey(fn)) ?? [];
  const functionKey = (info: FileFacts, fn: Node) => `${info.file.id}:${fn.startIndex}`;
  const senderOf = (info: FileFacts, call: CallFact): Sender | null => {
    const callee = field(call.node, 'function');
    if (!callee || !info.complete || info.unclear) return null;
    if (callee.type === 'identifier') {
      if (callee.text === 'fetch' && !shadowsFetch(info)) {
        return { axios: false, method: null, base: '', unknown: false, forwards: true };
      }
      if (imported(info, call.scope, callee.text, 'axios', 'default')) return { axios: true, method: null, base: '', unknown: axiosDefaults, forwards: true };
      const fn = resolveFunction(info, call.scope, callee);
      return fn ? wrappers.get(functionKey(fn.info, fn.fn)) ?? null : null;
    }
    const object = field(callee, 'object');
    const name = property(callee);
    if (object?.type !== 'identifier' || !name || !['get', 'post', 'put', 'patch', 'delete', 'request'].includes(name)) return null;
    const sender = imported(info, call.scope, object.text, 'axios', 'default')
      ? { axios: true, method: null, base: '', unknown: axiosDefaults, forwards: true } : instance(info, call.scope, object.text);
    return sender ? { ...sender, method: name === 'request' ? null : name.toUpperCase() } : null;
  };
  // The second parameter is safe only when every use is a permitted pass or a read of a property.
  const forwardsOptions = (info: FileFacts, fn: Node, calls: CallFact[]): boolean => {
    const option = parametersOf(info, fn).find(item => item.index === 1);
    if (!option || option.shape !== 'plain' || !option.node || option.value && (option.value.type !== 'object' || children(option.value).length)) return false;
    const body = field(fn, 'body')!;
    const all = trees.get(info.file.id) ?? [];
    const { nodeStarts } = indexOf(info);
    const nodes = all.slice(firstAtOrAfter(nodeStarts, body.startIndex), firstAtOrAfter(nodeStarts, body.endIndex)).filter(node => node.endIndex <= body.endIndex);
    if (!spend(nodes.length)) { wrapperSearchCut = true; return false; }
    if (nodes.some(node => node.type === 'identifier' && node.text === 'arguments')) return false;
    const allowed = new Set<number>();
    for (const call of calls) {
      const config = argsOf(call.node)[1];
      if (!config) return false;
      if (config.type === 'identifier' && config.text === option.node.text) allowed.add(config.startIndex);
      else if (config.type === 'object') {
        const parts = children(config);
        const spread = parts[0];
        const name = spread?.type === 'spread_element' ? children(spread)[0] : null;
        if (name?.type !== 'identifier' || name.text !== option.node.text || parts.slice(1).some(node => keyOf(node) === null || keyOf(node) === 'method')) return false;
        allowed.add(name.startIndex);
      } else return false;
    }
    return nodes.filter(node => node.type === 'identifier' && node.text === option.node!.text).every(node => {
      if (allowed.has(node.startIndex)) return true;
      let member = node.parent;
      if (member?.type !== 'member_expression' || !sameRange(field(member, 'object')!, node)) return false;
      while (member.parent?.type === 'member_expression' && sameRange(field(member.parent, 'object')!, member)) member = member.parent;
      const parent = member.parent;
      if (!parent || ['assignment_expression', 'augmented_assignment_expression', 'update_expression', 'unary_expression'].includes(parent.type)) return false;
      return !(['call_expression', 'new_expression'].includes(parent.type) && [field(parent, 'function'), field(parent, 'constructor')].some(callee => callee && sameRange(callee, member)));
    });
  };
  // Functions that pass their first parameter on as a call's first argument: found once, then settled repeatedly.
  const candidates: { info: FileFacts; fn: Node; key: string; calls: CallFact[] }[] = [];
  search: for (const info of facts.values()) for (const fn of info.functions) {
    if (!spend(1)) { wrapperSearchCut = true; break search; }
    const first = parametersOf(info, fn).find(item => item.index === 0);
    if (!first?.node || first.shape !== 'plain' || reassigned(info, first.node.text, first.scope)) continue;
    const { calls: sorted, callStarts } = indexOf(info);
    const body = field(fn, 'body')!;
    const inside = sorted.slice(firstAtOrAfter(callStarts, body.startIndex), firstAtOrAfter(callStarts, fn.endIndex));
    if (!spend(inside.length)) { wrapperSearchCut = true; break search; }
    const calls = inside.filter(call => call.node.endIndex <= fn.endIndex
      && argsOf(call.node)[0]?.type === 'identifier' && argsOf(call.node)[0].text === first.node!.text
      && nearest(call.scope, first.node!.text)?.scope === first.scope);
    if (calls.length) candidates.push({ info, fn, key: functionKey(info, fn), calls });
  }
  let changed = true;
  while (changed && !wrapperSearchCut) {
    changed = false;
    for (const { info, fn, key, calls } of candidates) {
      if (wrappers.has(key)) continue;
      if (!spend(calls.length)) { wrapperSearchCut = true; break; }
      const senders = calls.map(call => {
        let sender = senderOf(info, call);
        if (sender?.axios) {
          const option = parametersOf(info, fn).find(item => item.index === 1);
          const configIndex = !sender.wrapped && ['POST', 'PUT', 'PATCH'].includes(sender.method ?? '') ? 2 : 1;
          const config = argsOf(call.node)[configIndex];
          // A bare forwarded parameter is interpreted at the request site. A config written here still
          // supplies its own base URL (including remote hosts), even when method forwarding is unsafe.
          const forwarded = config?.type === 'identifier' && config.text === option?.node?.text
            && nearest(call.scope, config.text)?.scope === option.scope;
          if (!forwarded) sender = withConfig(sender, config);
        }
        return { call, sender };
      }).filter(item => item.sender !== null);
      if (!senders.length) continue;
      const sender = senders[0].sender!;
      // Conflicting terminal requests cannot establish a single method or base path.
      const consistent = senders.every(item => item.sender!.axios === sender.axios && item.sender!.method === sender.method && item.sender!.base === sender.base);
      const forwards = consistent && senders.every(item => item.sender!.forwards) && forwardsOptions(info, fn, senders.map(item => item.call));
      // Inspect every candidate call, including wrappers that have not been registered yet.
      const fixedMethods = !forwards && !hasUnsupportedCertainty(info) ? calls.map(call => {
        const direct = senderOf(info, call);
        if (!direct || direct.wrapped) return null;
        if (direct.method) return direct.method;
        const method = simpleProperties(argsOf(call.node)[1] ?? null)?.get('method');
        return method?.type === 'string' ? literal(method)?.toUpperCase() ?? null : null;
      }) : [];
      const fixedMethod = fixedMethods[0] != null && fixedMethods.every(method => method === fixedMethods[0]) ? fixedMethods[0] : null;
      wrappers.set(key, { ...sender, wrapped: true, fixedMethod, unknown: !consistent || senders.some(item => item.sender!.unknown), forwards });
      changed = true;
    }
  }
  collect: for (const info of facts.values()) for (const call of info.calls) {
    if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
    if (result.requests.length >= ROUTE_LIMITS.requests) { omitted = true; break collect; }
    const sender = senderOf(info, call);
    if (!sender) continue;
    const args = argsOf(call.node);
    const url = args[0];
    if (!url || !['string', 'template_string'].includes(url.type) || url.text.includes('\\')) continue;
    let raw = url.text.slice(1, -1);
    if (url.type === 'template_string') for (const substitution of children(url).filter(node => node.type === 'template_substitution').toReversed()) {
      const start = substitution.startIndex - url.startIndex - 1;
      raw = raw.slice(0, start) + '*' + raw.slice(substitution.endIndex - url.startIndex - 1);
    }
    if (/\s/.test(raw) || !/^(?:\/|https?:\/\/|\*\/)/.test(raw)) continue;
    const configIndex = sender.axios && !sender.wrapped && ['POST', 'PUT', 'PATCH'].includes(sender.method ?? '') ? 2 : 1;
    const config = args[configIndex];
    const configured = sender.axios && sender.forwards ? withConfig(sender, config) : sender;
    let host: string | null = null;
    const unknown = configured.unknown || raw.startsWith('*');
    if (raw.startsWith('*')) raw = raw.slice(1);
    // An explicit URL overrides axios's base URL. A remote base still marks relative requests as remote.
    const full = /^(?:https?:)?\/\//.test(raw) ? raw : configured.base ? configured.base.replace(/\/$/, '') + '/' + raw.replace(/^\//, '') : raw;
    const remote = full.match(/^(?:https?:)?\/\/([^/]+)(.*)$/);
    if (remote) { host = remote[1]; raw = remote[2] || '/'; } else raw = full;
    const path = bounded(joinPath(raw.split(/[?#]/)[0].split('/').map(segment => segment.includes('*') ? '*' : segment).join('/')));
    if (path === null) { omitted = true; continue; }
    let requestMethods: string[] | null = !sender.forwards && sender.fixedMethod ? [sender.fixedMethod] : null;
    if (sender.forwards) {
      if (sender.method) requestMethods = [sender.method];
      else if (!config || config.type === 'object' && !children(config).some(node => keyOf(node) === null)) {
        const entries = children(config).filter(node => keyOf(node) === 'method');
        const method = entries.length === 1 ? field(entries[0], 'value') : null;
        if (!entries.length && !sender.axios) requestMethods = ['GET'];
        else if (literal(method) !== null) requestMethods = [literal(method)!.toUpperCase()];
        else if (method?.type === 'ternary_expression') {
          const values = [literal(field(method, 'consequence')), literal(field(method, 'alternative'))];
          if (values.every(value => value !== null)) requestMethods = [...new Set(values.map(value => value!.toUpperCase()))];
        }
      }
    }
    if (room(result.requests, ROUTE_LIMITS.requests)) result.requests.push({ ...requestSite(call, info), path, host, prefix: unknown ? 'unknown' : 'known', methods: requestMethods });
  }
  if (wrapperSearchCut) { result.limited = true; result.notes.push('감싼 요청 함수가 너무 많아 일부만 찾았어요.'); }
  result.links = linkRoutes(result.routes, result.requests, shouldStop);
  if (result.links.length >= ROUTE_LIMITS.links) omitted = true;
  if (omitted) {
    result.limited = true;
    result.notes.push(`주소·요청·연결이 너무 많아 일부는 생략했어요(받는 곳 ${ROUTE_LIMITS.routes}개·요청 ${ROUTE_LIMITS.requests}개·연결 ${ROUTE_LIMITS.links}개, 경로는 ${ROUTE_LIMITS.pathLength}자·${ROUTE_LIMITS.segments}칸까지).`);
  }
  assertResultSize(result);
  return result;
}

/** Compare segments, retaining every possible candidate and its uncertainty. */
export function linkRoutes(routes: Route[], requests: Request[], shouldStop: () => boolean = () => false,
  maxLinks: number = ROUTE_LIMITS.links): ProjectRoutes['links'] {
  const links: ProjectRoutes['links'] = [];
  // Split once; paths are already bounded, and matching compares from an offset instead of copying.
  const routeShapes = routes.map(route => {
    if (route.path === null) return null;
    const parts = route.segments?.map(segment => 'text' in segment ? segment.text : 'param' in segment ? `:${segment.param}` : '*')
      ?? route.path.split('/').filter(Boolean);
    const catchAll = parts.at(-1) === '*' || !!parts.at(-1)?.endsWith('*');
    if (catchAll) parts[parts.length - 1] = '*';
    const last = route.segments?.at(-1);
    return { parts, catchAll, minRest: last && 'catchAll' in last && !last.optional ? 1 : 0 };
  });
  requests.forEach((request, requestIndex) => {
    if (request.host || links.length >= maxLinks) return;
    const requestParts = request.path.split('/').filter(Boolean);
    const candidates: ProjectRoutes['links'] = [];
    routes.forEach((route, routeIndex) => {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 연결을 취소했어요.');
      const shape = routeShapes[routeIndex];
      if (!shape || request.methods && route.method !== 'ALL' && !request.methods.includes(route.method)) return;
      const { parts: routeParts, catchAll, minRest } = shape;
      const unknownPrefix = route.prefix === 'unknown' || request.prefix === 'unknown';
      /** Route parts from `a`, request parts from `b`, to the end of each. */
      const matches = (a: number, b: number): { matched: boolean; dynamic: boolean } => {
        const fixed = routeParts.length - a - (catchAll ? 1 : 0);
        const rest = requestParts.length - b;
        if (catchAll ? rest < fixed + minRest : routeParts.length - a !== rest) return { matched: false, dynamic: false };
        let dynamic = false;
        for (let index = 0; index < fixed; index++) {
          const want = routeParts[a + index], got = requestParts[b + index];
          if (got === '*' && !want.startsWith(':')) dynamic = true;
          else if (!want.startsWith(':') && want !== got) return { matched: false, dynamic: false };
        }
        return { matched: true, dynamic };
      };
      let matched = matches(0, 0);
      if (!matched.matched && unknownPrefix) {
        // Unknown prefixes can add leading segments, never remove a known trailing segment.
        if (route.prefix === 'unknown') for (let i = 1; i <= requestParts.length && !matched.matched; i++) matched = matches(0, i);
        if (request.prefix === 'unknown') for (let i = 1; i < routeParts.length && !matched.matched; i++) matched = matches(i, 0);
      }
      if (!matched.matched) return;
      const reasons = [...(unknownPrefix ? ['앞부분 모름'] : []), ...(matched.dynamic ? ['경로 값 모름'] : []),
        ...(!request.methods ? ['방식 모름'] : request.methods.length > 1 ? ['방식 후보 둘'] : [])];
      candidates.push({ requestIndex, routeIndex, sure: !reasons.length, reasons });
    });
    if (candidates.length > 1) for (const candidate of candidates) { candidate.sure = false; candidate.reasons.push('후보 여럿'); }
    links.push(...candidates.slice(0, maxLinks - links.length));
  });
  return links;
}
