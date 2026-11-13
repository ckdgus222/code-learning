import type Parser from 'tree-sitter';
import type { ProjectFile, Route } from '../../shared/contracts';
import { firstLine, lineRange } from './names';
import { normalize } from './python-imports';
import { pythonFunction } from './python-syntax';
import { pythonAttributeNames, pythonParenthesizedValue, pythonValueAccess } from './python-values';
import { bounded, ROUTE_LIMITS, shortName } from './routes';
import { parseTree } from './syntax';

type Node = Parser.SyntaxNode;
type Framework = 'fastapi' | 'flask';
type Factory = { framework: Framework; kind: 'app' | 'router' | 'module' };
/** What the call that made an app or router says, read once: its arguments can be as long as the file. */
type App = { framework: Framework; factory: string; router: boolean; spread: boolean; prefix: string | null; unsupported: boolean };
type Shape = Pick<Route, 'segments' | 'typed' | 'unmatched'>;
const frameworks = {
  fastapi: { app: 'FastAPI', router: 'APIRouter', prefix: 'prefix', path: 'path', route: 'api_route',
    attributes: new Set(['FastAPI', 'APIRouter', 'get', 'post', 'put', 'patch', 'delete', 'api_route', 'include_router']),
    decoratorKeywords: null, appKeywords: null, shape: fastapiShape },
  flask: { app: 'Flask', router: 'Blueprint', prefix: 'url_prefix', path: 'rule', route: 'route',
    attributes: new Set(['Flask', 'Blueprint', 'get', 'post', 'put', 'patch', 'delete', 'route', 'register_blueprint']),
    decoratorKeywords: new Set(['rule', 'methods', 'endpoint', 'defaults', 'strict_slashes', 'merge_slashes', 'provide_automatic_options']),
    appKeywords: new Set(['import_name', 'static_folder', 'static_url_path', 'template_folder', 'instance_path', 'instance_relative_config', 'root_path']),
    routingNames: new Set(['converters', 'host_matching', 'subdomain_matching', 'default_subdomain', 'url_rule_class', 'url_map_class', 'view_functions', 'DispatcherMiddleware']),
    shape: flaskShape },
};
const nameOf = (node: Node | null | undefined) => normalize(node?.text ?? '');
function identifierInParens(node: Node | null): Node | null {
  for (let depth = 0; node && depth < 100; depth++) {
    if (node.type === 'identifier') return node;
    node = pythonParenthesizedValue(node);
  }
  return null;
}
const argumentsOf = (node: Node) => node.childForFieldName('arguments')?.namedChildren.filter(child => child.type !== 'comment') ?? [];
const keyword = (args: Node[], name: string) => args.find(arg => arg.type === 'keyword_argument' && nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
const spread = (args: Node[]) => args.some(arg => arg.type === 'list_splat' || arg.type === 'dictionary_splat');
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const pythonRouteMachinery = new Set(['globals', 'locals', 'exec', 'eval', '__import__', '__builtins__']);

function factoryKind(framework: Framework, name: string): 'app' | 'router' | null {
  if (name === frameworks[framework].app) return 'app';
  if (name === frameworks[framework].router) return 'router';
  return null;
}

export function plainString(node: Node | null | undefined): string | null {
  if (node?.type !== 'string' || node.text.includes('\\')) return null;
  const quote = node.firstNamedChild?.text;
  // A bare quote: every prefix (f, r, b, u and their mixes) changes what the text means.
  if (!quote || !['"', "'", '"""', "'''"].includes(quote)) return null;
  return node.text.slice(quote.length, -quote.length);
}

export function typePosition(node: Node): boolean {
  let current = node;
  // A written type is a few levels at most (`Optional[f.FastAPI]`); a longer climb is not followed.
  for (let level = 0; level < 8; level++) {
    const parent = current.parent;
    if (!parent || !['attribute', 'generic_type', 'type_parameter', 'parenthesized_expression'].includes(parent.type)) break;
    current = parent;
  }
  return current.parent?.type === 'type';
}

function fastapiShape(path: string, redirectUnknown: boolean): Shape {
  if (!path.startsWith('/') || path.endsWith('/') && redirectUnknown) return { unmatched: true };
  const parts = path.slice(1).split('/');
  if (path.endsWith('/')) parts.pop();
  const segments: NonNullable<Route['segments']> = [];
  let typed = false;
  for (const [index, part] of parts.entries()) {
    if (/^[A-Za-z0-9._~-]+$/.test(part)) { segments.push({ text: part }); continue; }
    const param = part.match(/^\{([A-Za-z_][A-Za-z0-9_]*)(?::(str|int|float|uuid|path))?\}$/);
    if (!param) return { unmatched: true };
    const [, name, converter] = param;
    if (converter !== 'path') {
      segments.push({ param: name });
      typed ||= !!converter && converter !== 'str';
      continue;
    }
    if (index !== parts.length - 1 || path.endsWith('/') || redirectUnknown) return { unmatched: true };
    segments.push({ catchAll: name, optional: true });
  }
  return { segments, ...(typed ? { typed: true } : {}) };
}

function flaskShape(path: string): Shape {
  if (!path.startsWith('/')) return { unmatched: true };
  const parts = path.slice(1).split('/');
  if (path.endsWith('/')) parts.pop();
  const segments: NonNullable<Route['segments']> = [];
  let typed = false;
  for (const [index, part] of parts.entries()) {
    if (/^[A-Za-z0-9._~-]+$/.test(part)) { segments.push({ text: part }); continue; }
    const param = part.match(/^<(?:(string|int|float|uuid|path)(\([^()<>]*\))?:)?([A-Za-z_][A-Za-z0-9_]*)>$/);
    if (!param) return { unmatched: true };
    const [, converter, args, name] = param;
    if (converter !== 'path') {
      segments.push({ param: name });
      typed ||= !!args || !!converter && converter !== 'string';
      continue;
    }
    if (args || index !== parts.length - 1 || path.endsWith('/')) return { unmatched: true };
    segments.push({ catchAll: name, optional: false });
  }
  return { segments, ...(typed ? { typed: true } : {}) };
}

/** A parameter of a function or lambda: a local name, not the module's. */
export function parameterPosition(node: Node): boolean {
  const parent = node.parent;
  return !!parent && (parent.type === 'parameters' || parent.type === 'lambda_parameters'
    || parent.type === 'typed_parameter' && parent.childForFieldName('type')?.id !== node.id
    || ['default_parameter', 'typed_default_parameter'].includes(parent.type) && parent.childForFieldName('name')?.id === node.id
    || ['list_splat_pattern', 'dictionary_splat_pattern'].includes(parent.type)
      && ['parameters', 'lambda_parameters', 'typed_parameter'].includes(parent.parent?.type ?? ''));
}

/** A name written as an attribute, a keyword or a part of an import: it neither reads nor binds the variable of that name. */
export function labelPosition(node: Node): boolean {
  const parent = node.parent;
  return !!parent && (parent.type === 'attribute' && parent.childForFieldName('attribute')?.id === node.id
    || parent.type === 'keyword_argument' && parent.childForFieldName('name')?.id === node.id
    || parent.type === 'dotted_name' && ['import_statement', 'import_from_statement', 'aliased_import', 'relative_import'].includes(parent.parent?.type ?? '')
    || parent.type === 'aliased_import');
}

/** Django converters occupy a whole segment; a path converter consumes a nonempty suffix. */
export function djangoShape(path: string): Shape {
  const parts = path.slice(1).split('/');
  if (path.endsWith('/')) parts.pop();
  const segments: NonNullable<Route['segments']> = [];
  let typed = false;
  for (const [index, part] of parts.entries()) {
    if (/^[A-Za-z0-9._~-]+$/.test(part)) { segments.push({ text: part }); continue; }
    const param = part.match(/^<(?:(str|int|slug|uuid|path):)?([A-Za-z_][A-Za-z0-9_]*)>$/);
    if (!param) return { unmatched: true };
    const [, converter, name] = param;
    if (converter !== 'path') {
      segments.push({ param: name });
      typed ||= !!converter && converter !== 'str';
      continue;
    }
    if (index !== parts.length - 1 || path.endsWith('/')) return { unmatched: true };
    segments.push({ catchAll: name, optional: false });
  }
  return { segments, ...(typed ? { typed: true } : {}) };
}

function routeMethods(args: Node[], method: string, multiple: string) {
  if (method !== multiple) return { selected: [method.toUpperCase()], unknown: false };
  const arg = keyword(args, 'methods');
  if (!arg) return { selected: ['GET'], unknown: false };
  const values = ['list', 'tuple', 'set'].includes(arg.type)
    ? arg.namedChildren.filter(child => child.type !== 'comment').map(plainString) : null;
  if (!values || values.includes(null)) return { selected: ['ALL'], unknown: true };
  return { selected: [...new Set(values.map(value => value!.toUpperCase()).filter(value => methods.has(value)))], unknown: false };
}

const positional = (arg: Node) => !['keyword_argument', 'list_splat', 'dictionary_splat'].includes(arg.type);

function readApp(framework: Framework, factory: string, router: boolean, args: Node[]): App {
  const rules = frameworks[framework];
  const spreads = spread(args);
  // A Flask app can be given routing settings by position or by keywords this reader does not know.
  const unsupported = framework === 'flask' && !router && (spreads || args.filter(positional).length > 1
    || args.some(arg => arg.type === 'keyword_argument' && !rules.appKeywords!.has(nameOf(arg.childForFieldName('name')))));
  return { framework, factory, router, spread: spreads, unsupported, prefix: router && !spreads ? plainString(keyword(args, rules.prefix)) : null };
}

function readRoute(app: App, args: Node[], method: string, rootPath: boolean, redirectSlashes: boolean) {
  const rules = frameworks[app.framework];
  const flask = app.framework === 'flask';
  const pathArg = args.find(positional) ?? keyword(args, rules.path);
  const written = pathArg ? plainString(pathArg) : '';
  const prefixText = app.prefix;
  // A prefix can be as long as the file and is joined once for every route: text past the path limit is never
  // trimmed or joined, so a small hostile file cannot stall the analysis.
  const short = (text: string | null) => text === null || text.length <= ROUTE_LIMITS.pathLength;
  // Blueprint joins trim only the boundary; FastAPI keeps both strings exactly as written.
  const path = written === null || !short(prefixText) || !short(written) ? null
    : bounded(flask && prefixText !== null && written
      ? prefixText.replace(/\/+$/, '') + '/' + written.replace(/^\/+/, '') : (prefixText ?? '') + written);
  const redirectUnknown = !app.router && (redirectSlashes || app.spread);
  const shape = path === null ? {} : rules.shape(path, redirectUnknown);
  const { selected, unknown } = routeMethods(args, method, rules.route);
  const unsupportedKeyword = args.some(arg => arg.type === 'keyword_argument'
    && rules.decoratorKeywords && !rules.decoratorKeywords.has(nameOf(arg.childForFieldName('name'))));
  const unmatched = spread(args) || unknown || unsupportedKeyword || app.unsupported
    || flask && method !== rules.route && !!keyword(args, 'methods');
  const prefix: Route['prefix'] = app.router || !flask && (rootPath || app.spread) ? 'unknown' : 'known';
  return { path, prefix, selected, writtenPath: written, unsupported: unmatched, shape: unmatched ? { unmatched: true as const } : shape };
}

type WrittenPrefix = { kind: 'missing' | 'none' | 'dynamic' } | { kind: 'literal'; text: string };
type RouteOwner = { id: number; name: string; app: App; end: number; args: Node[]; lastRouteEnd: number };
type RouteTemplate = { ownerId: number; writtenPath: string | null; base: Route; unsupported: boolean };
const writtenPrefix = (node: Node | null | undefined): WrittenPrefix => {
  if (!node) return { kind: 'missing' };
  if (node.type === 'none') return { kind: 'none' };
  const text = plainString(node);
  return text === null ? { kind: 'dynamic' } : { kind: 'literal', text };
};

/**
 * How deep the walk goes. Finding a node's parent costs as much as the node is deep, so a small file nested
 * tens of thousands of levels would take minutes; real code stays below 40 levels.
 */
export const PYTHON_WALK_DEPTH = 100;

/** One parse and one bounded walk of a Python file, shared by every reader of its routes. */
export function walkPython(text: string, relativePath: string, nodeBudget: number) {
  const root = parseTree(text, relativePath);
  // 1. Every node up to the budget, each marked as module scope or inside a function or class body.
  // The type is read once here: every reader filters by it, and each read of a node's property is a call into the parser.
  const nodes: { node: Node; module: boolean; type: string; scopeBodyId: number }[] = [];
  const pending = [{ node: root, module: true, depth: 0, scopeBodyId: root.id }];
  let tooDeep = false;
  // Visit siblings lazily so even a very wide argument list respects the node budget.
  while (pending.length && nodes.length < nodeBudget) {
    const { node, module: outerModule, depth, scopeBodyId: outerScope } = pending.pop()!;
    if (node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, module: outerModule, depth, scopeBodyId: outerScope });
    // Defaults and class bases run in the enclosing scope; only the bodies introduce a local scope.
    const owner = node.parent;
    const body = owner && ['function_definition', 'class_definition', 'lambda'].includes(owner.type)
      && owner.childForFieldName('body')?.id === node.id;
    const module = outerModule && !body;
    const scopeBodyId = body ? node.id : outerScope;
    nodes.push({ node, module, type: node.type, scopeBodyId });
    if (!node.firstNamedChild) continue;
    if (depth < PYTHON_WALK_DEPTH) pending.push({ node: node.firstNamedChild, module, depth: depth + 1, scopeBodyId });
    else tooDeep = true;
  }
  // What lies deeper was not looked at, so the file counts as partly read, like one past the node budget.
  const complete = !pending.length && !tooDeep;
  return { root, nodes, complete, tooDeep };
}

/** The FastAPI and Flask routes declared at module level or inside a simple returned-app factory. */
export function pythonRoutes(file: ProjectFile, walk: ReturnType<typeof walkPython>, hash: string, maxRoutes: number):
  { routes: Route[]; routers: Framework[]; complete: boolean; cut: boolean; odd: boolean; factoryRoutes?: number; registrationUncertain?: boolean } {
  const { root, nodes, complete } = walk;
  const visited = new Set(nodes.map(({ node }) => node.id));
  // 2. Imported framework names and the apps and routers made at the top of the module.
  const factories = new Map<string, Factory>();
  const bindings = new Map<string, Set<number>>();
  const bind = (name: string, node: Node) => {
    const places = bindings.get(name) ?? new Set<number>();
    places.add(node.id);
    bindings.set(name, places);
  };
  let star = false;
  for (const { node, module } of nodes) {
    if (!module || !['import_statement', 'import_from_statement'].includes(node.type) || node.hasError) continue;
    if (node.namedChildren.some(child => child.type === 'wildcard_import')) star = true;
    const from = node.type === 'import_from_statement' ? nameOf(node.childForFieldName('module_name')) : null;
    for (const imported of node.childrenForFieldName('name')) {
      const original = imported.type === 'aliased_import' ? imported.childForFieldName('name')! : imported;
      const binding = imported.childForFieldName('alias') ?? original.firstNamedChild!;
      const name = nameOf(binding);
      bind(name, binding);
      if (node.parent?.id !== root.id || !visited.has(binding.id)) continue;
      const framework = from ?? nameOf(original);
      if (framework !== 'fastapi' && framework !== 'flask') continue;
      const kind = from ? factoryKind(framework, nameOf(original)) : 'module';
      if (kind) factories.set(name, { framework, kind });
    }
  }
  const apps = new Map<string, App>();
  const owners = new Map<string, RouteOwner>();
  for (const { node } of nodes) {
    if (node.type !== 'assignment' || node.hasError || node.parent?.parent?.id !== root.id) continue;
    const left = node.childForFieldName('left'), right = node.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call') continue;
    const callee = right.childForFieldName('function');
    const receiver = callee?.type === 'attribute' ? callee.childForFieldName('object') : callee;
    if (receiver?.type !== 'identifier') continue;
    const factory = factories.get(nameOf(receiver));
    if (!factory) continue;
    const attribute = callee?.type === 'attribute' ? nameOf(callee.childForFieldName('attribute')) : null;
    const kind = factory.kind === 'module' && attribute ? factoryKind(factory.framework, attribute)
      : callee?.type === 'identifier' ? factory.kind : null;
    if (kind !== 'app' && kind !== 'router') continue;
    bind(nameOf(left), left);
    const args = argumentsOf(right), app = readApp(factory.framework, nameOf(receiver), kind === 'router', args);
    apps.set(nameOf(left), app);
    owners.set(nameOf(left), { id: node.id, name: nameOf(left), app, end: node.endIndex, args, lastRouteEnd: 0 });
  }
  // 3. Only names made once are trusted; dynamic name, attribute or routing changes disable all links in the file.
  const tracked = new Map([...factories, ...apps].map(([name, value]) => [name, value.framework]));
  const tracksFlask = [...tracked.values()].includes('flask');
  const invalid = new Set<string>();
  let odd = false;
  let rootPath = false;
  let redirectSlashes = false;
  for (const { node, module } of nodes) {
    if (node.type === 'identifier') {
      const name = nameOf(node);
      rootPath ||= name === 'root_path';
      redirectSlashes ||= name === 'redirect_slashes';
      odd ||= tracksFlask && frameworks.flask.routingNames.has(name);
      if (node.parent?.type === 'global_statement') invalid.add(name);
      const parent = node.parent;
      const parameter = parameterPosition(node);
      const label = labelPosition(node);
      // `model.eval()` is another object's method, not the builtin that can rebind names.
      odd ||= pythonRouteMachinery.has(name) && !label;
      const made = bindings.get(name)?.has(node.id);
      const reading = parent?.type === 'attribute' && parent.childForFieldName('object')?.id === node.id
        || parent?.type === 'argument_list' && parent.parent?.type === 'call'
        || parent?.type === 'keyword_argument' && parent.childForFieldName('value')?.id === node.id
        || factories.has(name) && (parent?.type === 'call' && parent.childForFieldName('function')?.id === node.id || typePosition(node));
      if (tracked.has(name) && module && !parameter && !label && !made && !reading) invalid.add(name);
    }
    if (node.type === 'attribute') {
      const receiver = identifierInParens(node.childForFieldName('object'));
      if (!receiver || !tracked.has(nameOf(receiver))) continue;
      const attribute = nameOf(node.childForFieldName('attribute'));
      const called = node.parent?.type === 'call' && node.parent.childForFieldName('function')?.id === node.id;
      odd ||= attribute.startsWith('__') || frameworks[tracked.get(nameOf(receiver))!].attributes.has(attribute) && !called && !typePosition(node);
    }
    if (node.type !== 'call' || !['setattr', 'delattr', 'vars'].includes(nameOf(node.childForFieldName('function')))) continue;
    let receiver = argumentsOf(node)[0];
    while (receiver?.type === 'attribute') receiver = receiver.childForFieldName('object')!;
    odd ||= receiver?.type === 'identifier' && tracked.has(nameOf(receiver));
  }
  for (const [name, places] of bindings) if (places.size !== 1) invalid.add(name);
  // 4. The route decorators on module-level functions.
  const routes: Route[] = [];
  const templates: RouteTemplate[] = [];
  const routers: Framework[] = [];
  let cut = false;
  if (star) return { routes, routers, complete, cut, odd: complete && odd };
  for (const { node } of nodes) {
    if (node.type !== 'decorator' || node.hasError || node.parent?.parent?.id !== root.id) continue;
    const fn = node.parent.childForFieldName('definition');
    const handler = fn && pythonFunction(fn);
    const call = node.firstNamedChild;
    const callee = call?.type === 'call' ? call.childForFieldName('function') : null;
    const receiver = callee?.type === 'attribute' ? callee.childForFieldName('object') : null;
    if (!handler || receiver?.type !== 'identifier') continue;
    const app = apps.get(nameOf(receiver));
    if (!app || invalid.has(nameOf(receiver)) || invalid.has(app.factory)) continue;
    const method = nameOf(callee?.childForFieldName('attribute'));
    if (!['get', 'post', 'put', 'patch', 'delete', frameworks[app.framework].route].includes(method)) continue;
    const args = argumentsOf(call!);
    const { path, prefix, selected, shape, writtenPath, unsupported } = readRoute(app, args, method, rootPath, redirectSlashes);
    const owner = owners.get(nameOf(receiver))!;
    owner.lastRouteEnd = Math.max(owner.lastRouteEnd, handler.declaration.endIndex);
    for (const selectedMethod of selected) {
      if (routes.length >= maxRoutes) { cut = true; break; }
      if (app.router && !routers.includes(app.framework)) routers.push(app.framework);
      const declaration = handler.declaration;
      const route: Route = { method: selectedMethod as Route['method'], path, framework: app.framework, prefix,
        handler: { fileId: file.id, fileHash: hash, startUtf16: declaration.startIndex, endUtf16: declaration.endIndex,
          startLine: declaration.startPosition.row + 1, name: shortName(handler.name) },
        basis: { text: firstLine(node), range: { fileId: file.id, fileHash: hash, startUtf16: node.startIndex,
          endUtf16: node.endIndex, ...lineRange(node), text: firstLine(node) } },
        ...(!complete || odd ? { unmatched: true as const } : shape),
      };
      routes.push(route);
      templates.push({ ownerId: owner.id, writtenPath,
        base: route, unsupported: !complete || odd || unsupported });
    }
  }
  const registered = registeredRoutes(templates, owners, walk, maxRoutes, invalid, odd, rootPath, redirectSlashes);
  const local = appFactoryRoutes(file, walk, hash, maxRoutes - registered.routes.length, factories, bindings, invalid, odd, rootPath, redirectSlashes);
  registered.routes.push(...local.routes);
  return { routes: registered.routes, routers: registered.routers, complete, cut: cut || registered.cut || local.cut, odd: complete && odd,
    ...(local.routes.length ? { factoryRoutes: local.routes.length } : {}), ...(registered.uncertain ? { registrationUncertain: true } : {}) };
}

/** Registration metadata stays inside this file snapshot; public routes retain the decorator evidence. */
function registeredRoutes(templates: RouteTemplate[], owners: Map<string, RouteOwner>, walk: ReturnType<typeof walkPython>,
  maxRoutes: number, invalid: Set<string>, odd: boolean, rootPath: boolean, redirectSlashes: boolean):
  { routes: Route[]; routers: Framework[]; cut: boolean; uncertain: boolean } {
  const byId = new Map([...owners.values()].map(owner => [owner.id, owner]));
  const byOwner = new Map<number, RouteTemplate[]>();
  for (const template of templates) {
    const group = byOwner.get(template.ownerId) ?? [];
    group.push(template); byOwner.set(template.ownerId, group);
  }
  const original = () => ({ routes: templates.map(template => template.base), cut: false, uncertain: false,
    routers: [...new Set(templates.flatMap(template => byId.get(template.ownerId)?.app.router ? [template.base.framework as Framework] : []))] });
  if (!walk.complete || walk.root.hasError) return original();
  type Registration = { parent: RouteOwner | null; child: RouteOwner | null; at: number; prefix: WrittenPrefix; settled: boolean; name: string | null };
  const registrations: Registration[] = [];
  const registrationArguments = new Set<number>();
  const unsafe = new Set<number>();
  const unresolved = new Set<number>();
  const uncertainParents = new Set<number>();
  const fastOptions = new Set(['router', 'prefix', 'tags', 'dependencies', 'responses', 'deprecated', 'include_in_schema', 'default_response_class', 'callbacks', 'generate_unique_id_function']);
  const flaskOptions = new Set(['blueprint', 'url_prefix', 'name']);
  const short = (text: string) => text.length <= ROUTE_LIMITS.pathLength;
  const ownerPrefixes = new Map<number, WrittenPrefix>();
  const blueprintNames = new Map<number, string | null>();
  const plainName = (node: Node | null | undefined): string | null => {
    const names = pythonAttributeNames(node ?? null);
    return names?.length === 1 ? names[0] : null;
  };
  const keywordsValid = (args: Node[], allowed: Set<string>) => {
    const names = args.filter(arg => arg.type === 'keyword_argument').map(arg => nameOf(arg.childForFieldName('name')));
    return !spread(args) && names.length === new Set(names).size && names.every(name => allowed.has(name));
  };
  const constructorSafe = (owner: RouteOwner) => {
    if (invalid.has(owner.name) || invalid.has(owner.app.factory) || owner.app.spread || owner.app.unsupported) return false;
    const keywords = owner.args.filter(arg => arg.type === 'keyword_argument').map(arg => nameOf(arg.childForFieldName('name')));
    if (keywords.length !== new Set(keywords).size) return false;
    const positions = owner.args.filter(positional);
    if (!owner.app.router) {
      if (keyword(owner.args, 'routes')) return false;
      return owner.app.framework === 'fastapi' ? positions.length === 0
        : positions.length <= 1 && !!positions[0] !== !!keyword(owner.args, 'import_name');
    }
    if (owner.app.framework === 'fastapi') {
      return !owner.args.some(positional) && keywordsValid(owner.args, new Set([...fastOptions].filter(name => name !== 'router')));
    }
    const name = blueprintNames.get(owner.id);
    return !!name && !name.includes('.') && positions.length <= 2
      && !!positions[0] !== !!keyword(owner.args, 'name') && !!positions[1] !== !!keyword(owner.args, 'import_name') && keywordsValid(owner.args,
      new Set(['name', 'import_name', 'url_prefix', 'template_folder', 'root_path', 'cli_group']));
  };
  for (const owner of owners.values()) {
    ownerPrefixes.set(owner.id, writtenPrefix(keyword(owner.args, frameworks[owner.app.framework].prefix)));
    const name = owner.app.framework === 'flask' && owner.app.router ? plainString(owner.args.find(positional) ?? keyword(owner.args, 'name')) : null;
    blueprintNames.set(owner.id, name !== null && name.length <= ROUTE_LIMITS.name ? name : null);
    if (!constructorSafe(owner)) unsafe.add(owner.id);
  }
  for (const { node, type } of walk.nodes) {
    if (type !== 'call') continue;
    const called = pythonAttributeNames(node.childForFieldName('function'));
    const method = called?.at(-1);
    if (method !== 'include_router' && method !== 'register_blueprint') continue;
    const framework: Framework = method === 'include_router' ? 'fastapi' : 'flask';
    const args = argumentsOf(node), positions = args.filter(positional);
    const childKey = framework === 'fastapi' ? 'router' : 'blueprint';
    const input = positions[0] ?? keyword(args, childKey);
    const parent = called?.length === 2 ? owners.get(called[0]) ?? null : null;
    const child = owners.get(plainName(input) ?? '') ?? null;
    if (!parent && !child) continue;
    if (parent?.app.router) unsafe.add(parent.id);
    if (child && input) registrationArguments.add(input.id);
    const prefix = writtenPrefix(keyword(args, framework === 'fastapi' ? 'prefix' : 'url_prefix'));
    const nameOption = keyword(args, 'name');
    const writtenName = framework === 'flask' ? nameOption ? plainString(nameOption) : child ? blueprintNames.get(child.id) ?? null : null : null;
    const name = writtenName !== null && writtenName.length <= ROUTE_LIMITS.name ? writtenName : null;
    const settled = !!parent && !!child && !parent.app.router && child.app.router
      && parent.app.framework === framework && child.app.framework === framework
      && node.parent?.type === 'expression_statement' && node.parent.parent?.id === walk.root.id
      && parent.end < node.startIndex && child.end < node.startIndex
      && positions.length <= 1 && !(positions.length && keyword(args, childKey))
      && keywordsValid(args, framework === 'fastapi' ? fastOptions : flaskOptions)
      && (framework !== 'flask' || !!name);
    registrations.push({ parent, child, at: node.startIndex, prefix, name, settled });
  }
  if (!registrations.length) return original();
  // Reads that hand mutable router state to other code cannot justify a complete registration list.
  for (const { node, type } of walk.nodes) {
    if (type === 'attribute') {
      const names = pythonAttributeNames(node);
      const owner = names && owners.get(names[0]);
      if (owner && names!.slice(1).some(name => ['prefix', 'url_prefix', 'routes', 'deferred_functions', 'url_map', 'view_functions', '__dict__'].includes(name))) unsafe.add(owner.id);
    }
    if (type === 'call') {
      const names = pythonAttributeNames(node.childForFieldName('function'));
      const owner = names?.length === 2 ? owners.get(names[0]) : null;
      if (owner && !frameworks[owner.app.framework].attributes.has(names![1])) unsafe.add(owner.id);
      const routeMethod = owner && ['get', 'post', 'put', 'patch', 'delete', frameworks[owner.app.framework].route].includes(names![1]);
      if (owner && routeMethod && (node.parent?.type !== 'decorator' || node.parent.parent?.parent?.id !== walk.root.id)) unsafe.add(owner.id);
    }
    if (type !== 'identifier' || labelPosition(node) || parameterPosition(node)) continue;
    const owner = owners.get(nameOf(node));
    if (!owner) continue;
    if (node.parent?.id === owner.id && node.parent.childForFieldName('left')?.id === node.id) continue;
    const access = pythonValueAccess(node), parent = access.node.parent;
    if (access.names.length === 1 && registrationArguments.has(access.node.id)) continue;
    const called = parent?.type === 'call' && parent.childForFieldName('function')?.id === access.node.id;
    if (called && access.names.length === 2 && frameworks[owner.app.framework].attributes.has(access.names[1])) continue;
    unsafe.add(owner.id);
  }
  const namesByParent = new Map<number, Map<string, Registration>>();
  for (const registration of registrations) {
    const { parent, child, name } = registration;
    if (!parent || !child || child.app.framework !== 'flask' || name === null) continue;
    const names = namesByParent.get(parent.id) ?? new Map<string, Registration>();
    const prior = names.get(name);
    if (prior) { prior.settled = false; registration.settled = false; }
    names.set(name, prior ?? registration); namesByParent.set(parent.id, names);
  }
  const prefixText = (prefix: WrittenPrefix, noneAllowed: boolean): string | null => prefix.kind === 'literal' ? prefix.text
    : prefix.kind === 'missing' || noneAllowed && prefix.kind === 'none' ? '' : null;
  const validFastPrefix = (value: string) => value === '' || value.startsWith('/') && !value.endsWith('/');
  const composition = (registration: Registration, template: RouteTemplate): { path: string | null; invalid: boolean } | null => {
    const { child, prefix } = registration;
    if (!child) return null;
    const flask = child.app.framework === 'flask';
    const own = ownerPrefixes.get(child.id)!;
    const registrationPrefix = prefixText(prefix, flask);
    const constructorPrefix = prefixText(own, flask);
    const selected = flask && prefix.kind === 'literal' ? prefix.text : constructorPrefix;
    if (registrationPrefix === null || selected === null || !flask && constructorPrefix === null) return null;
    const raw = template.writtenPath;
    if (raw === null || !short(raw) || !short(registrationPrefix) || !short(selected)) return { path: null, invalid: true };
    const value = flask ? selected && raw ? selected.replace(/\/+$/, '') + '/' + raw.replace(/^\/+/, '') : selected + raw
      : registrationPrefix + selected + raw;
    const path = bounded(value);
    return { path, invalid: !flask && (!validFastPrefix(registrationPrefix) || !validFastPrefix(selected))
      || path !== null && !!frameworks[child.app.framework].shape(path, redirectSlashes).unmatched };
  };
  const byChild = new Map<number, Registration[]>();
  // Bound validation before output as well: output limits alone do not cap templates × registrations.
  let workLeft = ROUTE_LIMITS.work, workCut = false;
  const validations = new Map<number, Map<string, { settled: boolean; invalid: boolean }>>();
  const validate = (registration: Registration, templates: RouteTemplate[]) => {
    const child = registration.child!;
    const prefix = registration.prefix;
    const key = prefix.kind === 'literal' ? short(prefix.text) ? `literal:${prefix.text}` : 'overlong' : prefix.kind;
    const cached = validations.get(child.id) ?? new Map<string, { settled: boolean; invalid: boolean }>();
    if (cached.has(key)) return cached.get(key)!;
    const result = { settled: true, invalid: false };
    const own = ownerPrefixes.get(child.id)!;
    const flask = child.app.framework === 'flask';
    const selected = flask && prefix.kind === 'literal' ? prefix : own;
    const addedText = prefixText(prefix, flask), ownText = prefixText(selected, flask);
    result.settled = addedText !== null && ownText !== null;
    result.invalid = !result.settled || !short(addedText ?? '') || !short(ownText ?? '')
      || !flask && (!validFastPrefix(addedText ?? '') || !validFastPrefix(ownText ?? ''));
    for (const template of templates) {
      if (!result.settled) break;
      const cost = 1 + (template.writtenPath?.length ?? 0) + (prefix.kind === 'literal' ? Math.min(prefix.text.length, 301) : 0)
        + (own.kind === 'literal' ? Math.min(own.text.length, 301) : 0);
      if (cost > workLeft) { workCut = true; result.settled = false; result.invalid = true; break; }
      workLeft -= cost;
      const joined = composition(registration, template);
      if (!joined) { result.settled = false; result.invalid = true; break; }
      result.invalid ||= template.unsupported || !joined.path || joined.invalid;
    }
    cached.set(key, result); validations.set(child.id, cached);
    return result;
  };
  for (const registration of registrations) {
    const { parent, child, at } = registration;
    const templates = child ? byOwner.get(child.id) ?? [] : [];
    registration.settled &&= !!parent && !!child && !odd && !unsafe.has(parent.id) && !unsafe.has(child.id)
      && child.lastRouteEnd < at;
    const validation = registration.settled ? validate(registration, templates) : null;
    registration.settled &&= !!validation?.settled;
    if (child) {
      const group = byChild.get(child.id) ?? [];
      group.push(registration); byChild.set(child.id, group);
      if (!registration.settled) unresolved.add(child.id);
    }
    if (parent && (!registration.settled || validation?.invalid)) uncertainParents.add(parent.id);
  }
  // A child with an unhandled registration may also contain unrepresented competing addresses.
  for (const registration of registrations) {
    if (registration.parent && registration.child && unresolved.has(registration.child.id)) uncertainParents.add(registration.parent.id);
  }
  const routes: Route[] = [], routers = new Set<Framework>();
  const append = (route: Route) => { if (routes.length >= maxRoutes) return false; routes.push(route); return true; };
  const rebuilt = (template: RouteTemplate, path: string | null, prefix: Route['prefix'], unmatched = false): Route => {
    const { segments: _segments, typed: _typed, unmatched: _unmatched, ...base } = template.base;
    const shape = path === null ? {} : frameworks[base.framework as Framework].shape(path, redirectSlashes);
    return { ...base, path, prefix, ...(template.unsupported || unmatched ? { unmatched: true as const } : shape) };
  };
  const uncertain = registrations.some(registration => !registration.settled) || uncertainParents.size > 0;
  for (const template of templates) {
    const owner = byId.get(template.ownerId)!;
    const registrations = byChild.get(owner.id) ?? [];
    if (!owner.app.router || !registrations.length) {
      if (owner.app.router) routers.add(owner.app.framework);
      const route = uncertainParents.has(owner.id) ? { ...template.base, prefix: 'unknown' as const } : template.base;
      if (!append(route)) return { routes, routers: [...routers], cut: true, uncertain };
      continue;
    }
    for (const registration of registrations) {
      if (!registration.settled) continue;
      const joined = composition(registration, template)!;
      const parent = registration.parent!;
      const prefix = uncertainParents.has(parent.id) || parent.app.framework === 'fastapi' && rootPath ? 'unknown' : 'known';
      if (!append(rebuilt(template, joined.path, prefix, joined.invalid))) return { routes, routers: [...routers], cut: true, uncertain };
    }
    if (!unresolved.has(owner.id)) continue;
    routers.add(owner.app.framework);
    if (!append(rebuilt(template, template.writtenPath !== null && short(template.writtenPath) ? template.writtenPath : null, 'unknown'))) {
      return { routes, routers: [...routers], cut: true, uncertain };
    }
  }
  return { routes, routers: [...routers], cut: workCut, uncertain };
}

/** Each factory owns its app names. Its existence is evidence of code, not of invocation or deployment. */
function appFactoryRoutes(file: ProjectFile, walk: ReturnType<typeof walkPython>, hash: string, maxRoutes: number,
  factories: Map<string, Factory>, moduleBindings: Map<string, Set<number>>, moduleInvalid: Set<string>, fileOdd: boolean,
  rootPath: boolean, redirectSlashes: boolean): { routes: Route[]; cut: boolean } {
  const routes: Route[] = [];
  if (!walk.complete || walk.root.hasError || !factories.size) return { routes, cut: false };
  type Entry = (typeof walk.nodes)[number];
  type Scope = { fn: Node; body: Node; name: Node; entries: Entry[] };
  const scopes: Scope[] = [];
  const declarations = new Map<string, Set<number>>();
  let current: Scope | null = null;
  // Nodes are in source order. Group whole top-level functions in one pass rather than rescanning for each factory.
  for (const entry of walk.nodes) {
    const { node, type, module } = entry;
    if (current && node.startIndex >= current.fn.endIndex) current = null;
    if (type === 'function_definition' && node.parent?.id === walk.root.id) {
      const body = node.childForFieldName('body'), name = node.childForFieldName('name');
      if (body && name) { current = { fn: node, body, name, entries: [] }; scopes.push(current); }
    }
    current?.entries.push(entry);
    if (type !== 'identifier' || !module || labelPosition(node) || parameterPosition(node)) continue;
    const parent = node.parent;
    const read = parent?.type === 'call' && parent.childForFieldName('function')?.id === node.id
      || parent?.type === 'argument_list' || typePosition(node);
    if (read) continue;
    const name = nameOf(node), places = declarations.get(name) ?? new Set<number>();
    places.add(node.id);
    declarations.set(name, places);
  }
  const fromScope = (scope: Scope, room: number): { routes: Route[]; cut: boolean } | null => {
    const routes: Route[] = [];
    const { fn, body, name, entries } = scope;
    if (fn.firstChild?.type === 'async' || declarations.get(nameOf(name))?.size !== 1 || moduleBindings.has(nameOf(name))) return null;
    const own = entries.filter(entry => entry.scopeBodyId === body.id);
    const returns = own.filter(entry => entry.type === 'return_statement');
    const statements = own.filter(entry => entry.node.parent?.id === body.id && !['comment', 'line_continuation'].includes(entry.type));
    const last = statements.at(-1)?.node;
    const returned = last?.type === 'return_statement' ? last.namedChildren.find(child => child.type !== 'comment') : null;
    if (returns.length !== 1 || own.some(entry => entry.type === 'yield') || returned?.type !== 'identifier') return null;
    const appName = nameOf(returned);
    const assignments = own.filter(entry => entry.type === 'assignment' && nameOf(entry.node.childForFieldName('left')) === appName);
    if (assignments.length !== 1) return null;
    const assignment = assignments[0].node;
    if (assignment.parent?.parent?.id !== body.id) return null;
    const left = assignment.childForFieldName('left'), right = assignment.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call') return null;
    const callee = right.childForFieldName('function');
    const receiver = callee?.type === 'attribute' ? callee.childForFieldName('object') : callee;
    if (receiver?.type !== 'identifier') return null;
    const constructor = nameOf(receiver), factory = factories.get(constructor);
    if (!factory || moduleInvalid.has(constructor)) return null;
    const kind = factory.kind === 'module' ? factoryKind(factory.framework, nameOf(callee?.childForFieldName('attribute')))
      : callee?.type === 'identifier' ? factory.kind : null;
    if (kind !== 'app') return null;
    const parameters = fn.childForFieldName('parameters');
    let invalid = false, odd = fileOdd;
    for (const entry of entries) {
      const { node, type, scopeBodyId } = entry;
      if (type === 'identifier') {
        const name = nameOf(node), parent = node.parent;
        if (labelPosition(node)) continue;
        odd ||= pythonRouteMachinery.has(name);
        if ([appName, constructor].includes(name) && ['global_statement', 'nonlocal_statement'].includes(parent?.type ?? '')) invalid = true;
        const parameter = parameterPosition(node);
        const ownParameter = parameter && parameters && node.startIndex >= parameters.startIndex && node.endIndex <= parameters.endIndex;
        if (!ownParameter && (scopeBodyId !== body.id || parameter)) continue;
        if (name !== appName && name !== constructor) continue;
        const made = node.id === left.id || node.id === returned.id;
        const reading = parent?.type === 'attribute' && parent.childForFieldName('object')?.id === node.id
          || parent?.type === 'argument_list' || parent?.type === 'keyword_argument' && parent.childForFieldName('value')?.id === node.id
          || name === constructor && (parent?.type === 'call' && parent.childForFieldName('function')?.id === node.id || typePosition(node));
        if (!made && (!reading || ownParameter)) invalid = true;
      }
      if (scopeBodyId === body.id && ['import_statement', 'import_from_statement'].includes(type)) {
        if (node.namedChildren.some(child => child.type === 'wildcard_import')) invalid = true;
        invalid ||= node.childrenForFieldName('name').some(imported => {
          const original = imported.childForFieldName('name') ?? imported;
          const binding = imported.childForFieldName('alias') ?? original.firstNamedChild ?? original;
          return [appName, constructor].includes(nameOf(binding));
        });
      }
      if (type === 'attribute') {
        const names = pythonAttributeNames(node);
        if (names?.length !== 2 || ![appName, constructor].includes(names[0])) continue;
        const attribute = names[1];
        const called = node.parent?.type === 'call' && node.parent.childForFieldName('function')?.id === node.id;
        odd ||= attribute.startsWith('__') || frameworks[factory.framework].attributes.has(attribute) && !called && !typePosition(node);
      }
      if (type !== 'call') continue;
      const called = pythonAttributeNames(node.childForFieldName('function'));
      if (called?.length !== 1 || !['setattr', 'delattr', 'vars'].includes(called[0])) continue;
      const object = pythonAttributeNames(argumentsOf(node)[0]);
      odd ||= !!object && [appName, constructor].includes(object[0]);
    }
    if (invalid) return null;
    const app = readApp(factory.framework, constructor, false, argumentsOf(right));
    for (const { node, type } of own) {
      if (type !== 'decorator' || node.parent?.parent?.id !== body.id || node.startIndex < assignment.endIndex) continue;
      const definition = node.parent.childForFieldName('definition'), handler = definition && pythonFunction(definition);
      const call = node.firstNamedChild, callee = call?.type === 'call' ? call.childForFieldName('function') : null;
      const object = callee?.type === 'attribute' ? callee.childForFieldName('object') : null;
      if (!handler || object?.type !== 'identifier' || nameOf(object) !== appName) continue;
      const method = nameOf(callee?.childForFieldName('attribute'));
      if (!['get', 'post', 'put', 'patch', 'delete', frameworks[app.framework].route].includes(method)) continue;
      const { path, selected, shape } = readRoute(app, argumentsOf(call!), method, rootPath, redirectSlashes);
      for (const selectedMethod of selected) {
        if (routes.length >= room) return { routes, cut: true };
        const declaration = handler.declaration;
        routes.push({ method: selectedMethod as Route['method'], path, framework: app.framework, prefix: 'unknown',
          handler: { fileId: file.id, fileHash: hash, startUtf16: declaration.startIndex, endUtf16: declaration.endIndex,
            startLine: declaration.startPosition.row + 1, name: shortName(handler.name) },
          basis: { text: firstLine(node), range: { fileId: file.id, fileHash: hash, startUtf16: node.startIndex,
            endUtf16: node.endIndex, ...lineRange(node), text: firstLine(node) } },
          ...(odd ? { unmatched: true as const } : shape) });
      }
    }
    return { routes, cut: false };
  };
  for (const scope of scopes) {
    const found = fromScope(scope, maxRoutes - routes.length);
    if (!found) continue;
    routes.push(...found.routes);
    if (found.cut) return { routes, cut: true };
  }
  return { routes, cut: false };
}
