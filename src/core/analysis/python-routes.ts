import type Parser from 'tree-sitter';
import type { ProjectFile, Route } from '../../shared/contracts';
import { firstLine, lineRange } from './names';
import { normalize } from './python-imports';
import { pythonFunction } from './python-syntax';
import { bounded, ROUTE_LIMITS, shortName } from './routes';
import { parse } from './syntax';

type Node = Parser.SyntaxNode;
type Framework = 'fastapi' | 'flask';
type Factory = { framework: Framework; kind: 'app' | 'router' | 'module' };
/** What the call that made an app or router says, read once: its arguments can be as long as the file. */
type App = { framework: Framework; factory: string; router: boolean; spread: boolean; prefix: string | null; unsupported: boolean };
type Shape = Pick<Route, 'segments' | 'typed' | 'unmatched'>;
const frameworks = {
  fastapi: { app: 'FastAPI', router: 'APIRouter', prefix: 'prefix', path: 'path', route: 'api_route',
    attributes: new Set(['FastAPI', 'APIRouter', 'get', 'post', 'put', 'patch', 'delete', 'api_route']),
    decoratorKeywords: null, appKeywords: null, shape: fastapiShape },
  flask: { app: 'Flask', router: 'Blueprint', prefix: 'url_prefix', path: 'rule', route: 'route',
    attributes: new Set(['Flask', 'Blueprint', 'get', 'post', 'put', 'patch', 'delete', 'route']),
    decoratorKeywords: new Set(['rule', 'methods', 'endpoint', 'defaults', 'strict_slashes', 'merge_slashes', 'provide_automatic_options']),
    appKeywords: new Set(['import_name', 'static_folder', 'static_url_path', 'template_folder', 'instance_path', 'instance_relative_config', 'root_path']),
    routingNames: new Set(['converters', 'host_matching', 'subdomain_matching', 'default_subdomain', 'url_rule_class', 'url_map_class', 'view_functions', 'DispatcherMiddleware']),
    shape: flaskShape },
};
const nameOf = (node: Node | null | undefined) => normalize(node?.text ?? '');
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
  return { path, prefix, selected, shape: unmatched ? { unmatched: true as const } : shape };
}

/**
 * How deep the walk goes. Finding a node's parent costs as much as the node is deep, so a small file nested
 * tens of thousands of levels would take minutes; real code stays below 40 levels.
 */
export const PYTHON_WALK_DEPTH = 100;

/** One parse and one bounded walk of a Python file, shared by every reader of its routes. */
export function walkPython(text: string, relativePath: string, nodeBudget: number) {
  const root = parse(text, relativePath);
  // 1. Every node up to the budget, each marked as module scope or inside a function or class body.
  // The type is read once here: every reader filters by it, and each read of a node's property is a call into the parser.
  const nodes: { node: Node; module: boolean; type: string }[] = [];
  const pending = [{ node: root, module: true, depth: 0 }];
  let tooDeep = false;
  // Visit siblings lazily so even a very wide argument list respects the node budget.
  while (pending.length && nodes.length < nodeBudget) {
    const { node, module: outerModule, depth } = pending.pop()!;
    if (node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, module: outerModule, depth });
    // Defaults and class bases run in the enclosing scope; only the bodies introduce a local scope.
    const owner = node.parent;
    const body = owner && ['function_definition', 'class_definition', 'lambda'].includes(owner.type)
      && owner.childForFieldName('body')?.id === node.id;
    const module = outerModule && !body;
    nodes.push({ node, module, type: node.type });
    if (!node.firstNamedChild) continue;
    if (depth < PYTHON_WALK_DEPTH) pending.push({ node: node.firstNamedChild, module, depth: depth + 1 });
    else tooDeep = true;
  }
  // What lies deeper was not looked at, so the file counts as partly read, like one past the node budget.
  const complete = !pending.length && !tooDeep;
  return { root, nodes, complete };
}

/** The FastAPI and Flask routes one Python file declares. Nothing is run: only decorators on module-level functions are read. */
export function pythonRoutes(file: ProjectFile, walk: ReturnType<typeof walkPython>, hash: string, maxRoutes: number):
  { routes: Route[]; routers: Framework[]; complete: boolean; cut: boolean; odd: boolean } {
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
    apps.set(nameOf(left), readApp(factory.framework, nameOf(receiver), kind === 'router', argumentsOf(right)));
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
      const receiver = node.childForFieldName('object');
      if (receiver?.type !== 'identifier' || !tracked.has(nameOf(receiver))) continue;
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
    const { path, prefix, selected, shape } = readRoute(app, args, method, rootPath, redirectSlashes);
    for (const selectedMethod of selected) {
      if (routes.length >= maxRoutes) { cut = true; break; }
      if (app.router && !routers.includes(app.framework)) routers.push(app.framework);
      const declaration = handler.declaration;
      routes.push({ method: selectedMethod as Route['method'], path, framework: app.framework, prefix,
        handler: { fileId: file.id, fileHash: hash, startUtf16: declaration.startIndex, endUtf16: declaration.endIndex,
          startLine: declaration.startPosition.row + 1, name: shortName(handler.name) },
        basis: { text: firstLine(node), range: { fileId: file.id, fileHash: hash, startUtf16: node.startIndex,
          endUtf16: node.endIndex, ...lineRange(node), text: firstLine(node) } },
        ...(!complete || odd ? { unmatched: true as const } : shape),
      });
    }
  }
  return { routes, routers, complete, cut, odd: complete && odd };
}
