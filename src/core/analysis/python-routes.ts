import type Parser from 'tree-sitter';
import type { ProjectFile, Route } from '../../shared/contracts';
import { firstLine, lineRange } from './names';
import { normalize } from './python-imports';
import { pythonFunction } from './python-syntax';
import { bounded, shortName } from './routes';
import { parse } from './syntax';

type Node = Parser.SyntaxNode;
type Factory = 'FastAPI' | 'APIRouter' | 'module';
const nameOf = (node: Node | null | undefined) => normalize(node?.text ?? '');
const argumentsOf = (node: Node) => node.childForFieldName('arguments')?.namedChildren.filter(child => child.type !== 'comment') ?? [];
const keyword = (args: Node[], name: string) => args.find(arg => arg.type === 'keyword_argument' && nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
const spread = (args: Node[]) => args.some(arg => arg.type === 'list_splat' || arg.type === 'dictionary_splat');
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const watchedAttributes = new Set(['FastAPI', 'APIRouter', 'get', 'post', 'put', 'patch', 'delete', 'api_route']);
const machinery = new Set(['globals', 'locals', 'exec', 'eval', '__import__', '__builtins__']);

function plainString(node: Node | null | undefined): string | null {
  if (node?.type !== 'string' || node.text.includes('\\')) return null;
  const quote = node.firstNamedChild?.text;
  // A bare quote: every prefix (f, r, b, u and their mixes) changes what the text means.
  if (!quote || !['"', "'", '"""', "'''"].includes(quote)) return null;
  return node.text.slice(quote.length, -quote.length);
}

function typePosition(node: Node): boolean {
  let current = node;
  while (current.parent && ['attribute', 'generic_type', 'type_parameter', 'parenthesized_expression'].includes(current.parent.type)) current = current.parent;
  return current.parent?.type === 'type';
}

/** The FastAPI routes one Python file declares. Nothing is run: only decorators on module-level functions are read. */
export function fastapiRoutes(file: ProjectFile, text: string, hash: string, nodeBudget: number, maxRoutes: number):
  { routes: Route[]; usesRouter: boolean; complete: boolean; cut: boolean; odd: boolean } {
  const root = parse(text, file.relativePath);
  // 1. Every node up to the budget, each marked as module scope or inside a function or class body.
  const nodes: { node: Node; module: boolean }[] = [];
  const pending = [{ node: root, module: true }];
  // Visit siblings lazily so even a very wide argument list respects the node budget.
  while (pending.length && nodes.length < nodeBudget) {
    const { node, module: outerModule } = pending.pop()!;
    if (node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, module: outerModule });
    // Defaults and class bases run in the enclosing scope; only the bodies introduce a local scope.
    const owner = node.parent;
    const body = owner && ['function_definition', 'class_definition', 'lambda'].includes(owner.type)
      && owner.childForFieldName('body')?.id === node.id;
    const module = outerModule && !body;
    nodes.push({ node, module });
    if (node.firstNamedChild) pending.push({ node: node.firstNamedChild, module });
  }
  const complete = !pending.length;
  const visited = new Set(nodes.map(({ node }) => node.id));
  // 2. The names this file gets from `fastapi`, and the apps and routers made from them at the top of the module.
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
    const fromFastapi = node.type === 'import_from_statement' && nameOf(node.childForFieldName('module_name')) === 'fastapi';
    for (const imported of node.childrenForFieldName('name')) {
      const original = imported.type === 'aliased_import' ? imported.childForFieldName('name')! : imported;
      const binding = imported.childForFieldName('alias') ?? original.firstNamedChild!;
      const name = nameOf(binding);
      bind(name, binding);
      if (node.parent?.id !== root.id || !visited.has(binding.id)) continue;
      const kind = fromFastapi && ['FastAPI', 'APIRouter'].includes(nameOf(original)) ? nameOf(original) as Factory
        : node.type === 'import_statement' && nameOf(original) === 'fastapi' ? 'module' : null;
      if (kind) factories.set(name, kind);
    }
  }
  const apps = new Map<string, { factory: string; router: boolean; args: Node[] }>();
  for (const { node } of nodes) {
    if (node.type !== 'assignment' || node.hasError || node.parent?.parent?.id !== root.id) continue;
    const left = node.childForFieldName('left'), right = node.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call') continue;
    const callee = right.childForFieldName('function');
    const receiver = callee?.type === 'attribute' ? callee.childForFieldName('object') : callee;
    if (receiver?.type !== 'identifier') continue;
    const factory = factories.get(nameOf(receiver));
    const kind = factory === 'module' && callee?.type === 'attribute' ? nameOf(callee.childForFieldName('attribute'))
      : callee?.type === 'identifier' ? factory : null;
    if (kind !== 'FastAPI' && kind !== 'APIRouter') continue;
    bind(nameOf(left), left);
    apps.set(nameOf(left), { factory: nameOf(receiver), router: kind === 'APIRouter', args: argumentsOf(right) });
  }
  // 3. A name is trusted only where it is made once and otherwise read. Code that can swap a name or an
  // attribute while running makes the whole file `odd`: its routes are listed but never linked.
  const tracked = new Set([...factories.keys(), ...apps.keys()]);
  const invalid = new Set<string>();
  let odd = false;
  let rootPath = false;
  let redirectSlashes = false;
  for (const { node, module } of nodes) {
    if (node.type === 'identifier') {
      const name = nameOf(node);
      rootPath ||= name === 'root_path';
      redirectSlashes ||= name === 'redirect_slashes';
      if (node.parent?.type === 'global_statement') invalid.add(name);
      const parent = node.parent;
      const parameter = parent?.type === 'parameters' || parent?.type === 'lambda_parameters'
        || parent?.type === 'typed_parameter' && parent.childForFieldName('type')?.id !== node.id
        || parent && ['default_parameter', 'typed_default_parameter'].includes(parent.type) && parent.childForFieldName('name')?.id === node.id
        || parent && ['list_splat_pattern', 'dictionary_splat_pattern'].includes(parent.type)
          && ['parameters', 'lambda_parameters', 'typed_parameter'].includes(parent.parent?.type ?? '');
      const label = parent?.type === 'attribute' && parent.childForFieldName('attribute')?.id === node.id
        || parent?.type === 'keyword_argument' && parent.childForFieldName('name')?.id === node.id
        || parent?.type === 'dotted_name' && ['import_statement', 'import_from_statement', 'aliased_import', 'relative_import'].includes(parent.parent?.type ?? '')
        || parent?.type === 'aliased_import';
      // `model.eval()` is another object's method, not the builtin that can rebind names.
      odd ||= machinery.has(name) && !label;
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
      odd ||= attribute.startsWith('__') || watchedAttributes.has(attribute) && !called && !typePosition(node);
    }
    if (node.type !== 'call' || !['setattr', 'delattr', 'vars'].includes(nameOf(node.childForFieldName('function')))) continue;
    let receiver = argumentsOf(node)[0];
    while (receiver?.type === 'attribute') receiver = receiver.childForFieldName('object')!;
    odd ||= receiver?.type === 'identifier' && tracked.has(nameOf(receiver));
  }
  for (const [name, places] of bindings) if (places.size !== 1) invalid.add(name);
  // 4. The route decorators on module-level functions.
  const routes: Route[] = [];
  let usesRouter = false;
  let cut = false;
  if (star) return { routes, usesRouter, complete, cut, odd: complete && odd };
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
    if (!['get', 'post', 'put', 'patch', 'delete', 'api_route'].includes(method)) continue;
    const args = argumentsOf(call!);
    const position = args.find(arg => !['keyword_argument', 'list_splat', 'dictionary_splat'].includes(arg.type));
    const pathArg = position ?? keyword(args, 'path');
    const written = pathArg ? plainString(pathArg) : '';
    const prefixArg = keyword(app.args, 'prefix');
    const prefixText = app.router && !spread(app.args) ? plainString(prefixArg) ?? '' : '';
    const path = written === null ? null : bounded(prefixText + written);
    const redirectUnknown = !app.router && (redirectSlashes || spread(app.args));
    const parts = path?.startsWith('/') ? path.slice(1).split('/') : [];
    if (path?.endsWith('/')) parts.pop();
    const segments = parts.map((part, index): NonNullable<Route['segments']>[number] | null => {
      if (/^[A-Za-z0-9._~-]+$/.test(part)) return { text: part };
      const param = part.match(/^\{([A-Za-z_][A-Za-z0-9_]*)(:path)?\}$/);
      if (!param) return null;
      if (!param[2]) return { param: param[1] };
      if (index !== parts.length - 1 || path!.endsWith('/') || redirectUnknown) return null;
      return { catchAll: param[1], optional: true };
    });
    const unsupportedPath = path !== null && (!path.startsWith('/') || path.endsWith('/') && redirectUnknown || segments.includes(null));
    const methodsArg = keyword(args, 'methods');
    const methodValues = methodsArg && ['list', 'tuple', 'set'].includes(methodsArg.type)
      ? methodsArg.namedChildren.filter(child => child.type !== 'comment').map(plainString) : null;
    const unknownMethod = method === 'api_route' && !!methodsArg && (!methodValues || methodValues.includes(null));
    const selected = method !== 'api_route' ? [method.toUpperCase()] : unknownMethod ? ['ALL']
      : methodsArg ? [...new Set(methodValues!.map(value => value!.toUpperCase()).filter(value => methods.has(value)))] : ['GET'];
    const unmatched = !complete || odd || spread(args) || unknownMethod || unsupportedPath;
    for (const selectedMethod of selected) {
      if (routes.length >= maxRoutes) { cut = true; break; }
      usesRouter ||= app.router;
      const declaration = handler.declaration;
      routes.push({ method: selectedMethod as Route['method'], path, framework: 'fastapi',
        prefix: app.router || rootPath || spread(app.args) ? 'unknown' : 'known',
        handler: { fileId: file.id, fileHash: hash, startUtf16: declaration.startIndex, endUtf16: declaration.endIndex,
          startLine: declaration.startPosition.row + 1, name: shortName(handler.name) },
        basis: { text: firstLine(node), range: { fileId: file.id, fileHash: hash, startUtf16: node.startIndex,
          endUtf16: node.endIndex, ...lineRange(node), text: firstLine(node) } },
        ...(unmatched ? { unmatched: true as const } : path !== null ? { segments: segments.filter(segment => segment !== null) } : {}),
      });
    }
  }
  return { routes, usesRouter, complete, cut, odd: complete && odd };
}
