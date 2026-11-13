import type Parser from 'tree-sitter';
import type { CallTarget, ProjectFile, Route } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { firstLine, lineRange } from './names';
import { initFactsOf, mentionsMachinery, normalize, pythonImportsOf, resolvePythonImport, type InitFacts, type PythonImport } from './python-imports';
import { djangoShape, labelPosition, parameterPosition, plainString, pythonRouteMachinery, typePosition, type walkPython } from './python-routes';
import { pythonFunction } from './python-syntax';
import { bounded, ROUTE_LIMITS, shortName } from './routes';

type Node = Parser.SyntaxNode;
/** A view expression in urlpatterns, optionally followed by .as_view(). */
interface ViewRef { local: string; attribute: string | null; asView: boolean }
interface DjangoEntry { path: string | null; shape: Pick<Route, 'segments' | 'typed' | 'unmatched'>; view: ViewRef | null; basis: Route['basis'] }
type DjangoView = { kind: 'function'; handler: CallTarget; methods: Route['method'][] }
  | { kind: 'class'; methods: { method: Route['method']; handler: CallTarget }[] };
/** Values only: syntax trees are released after each file is read. */
export interface DjangoFile {
  entries: DjangoEntry[];
  includes: number;
  imports: Map<string, PythonImport>;
  views: Map<string, DjangoView>;
  plain: boolean;
  init: InitFacts | null;
  odd: boolean;
}
/** What may still be kept for the whole project, and whether something was left out because a count ran out. */
export interface DjangoRoom { entries: number; views: number; entriesCut?: boolean; viewsCut?: boolean }
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const changesDispatch = new Set(['as_view', 'dispatch', 'http_method_names', 'setup']);
const argumentsOf = (node: Node) => node.childForFieldName('arguments')?.namedChildren.filter(child => child.type !== 'comment') ?? [];

export function djangoFile(file: ProjectFile, walk: ReturnType<typeof walkPython>, hash: string, room: DjangoRoom): DjangoFile {
  const { root, nodes, complete } = walk;
  const result: DjangoFile = { entries: [], includes: 0, imports: new Map(), views: new Map(), plain: complete && !root.hasError, init: null, odd: false };
  // 1. Bound names are normalized once, after rejecting text too long to be a route name.
  const names = new Map<number, string>();
  const nameOf = (node: Node | null | undefined): string => {
    if (!node) return '';
    const cached = names.get(node.id);
    if (cached !== undefined) return cached;
    const text = node.text;
    const name = text.length <= ROUTE_LIMITS.name ? normalize(text) : '';
    names.set(node.id, name.length <= ROUTE_LIMITS.name ? name : '');
    return names.get(node.id)!;
  };
  const bindings = new Map<string, Set<number>>();
  const bind = (node: Node) => {
    const name = nameOf(node);
    if (!name) return;
    const places = bindings.get(name) ?? new Set<number>();
    places.add(node.id);
    bindings.set(name, places);
  };
  const django = new Map<string, string>();
  const imports = new Map<string, PythonImport>();
  const definitions = new Map<string, Node>();
  for (const { node, module, type } of nodes) {
    // Every name the import check looks for starts with two underscores, so other names are not handed to it.
    if (type === 'identifier' && nameOf(node).startsWith('__') && mentionsMachinery(node)) result.plain = false;
    if (!module || type !== 'import_statement' && type !== 'import_from_statement' || node.hasError) continue;
    if (node.namedChildren.some(child => child.type === 'wildcard_import')) result.plain = false;
    // A dotted path is walked once for every name that uses it: one deeper or longer than any real module is not kept.
    const items = pythonImportsOf(node).map(item => item.module.length > ROUTE_LIMITS.segments
      || item.module.some(part => part.length > ROUTE_LIMITS.name) ? null : item);
    const from = node.type === 'import_from_statement';
    for (const [index, imported] of node.childrenForFieldName('name').entries()) {
      const original = imported.type === 'aliased_import' ? imported.childForFieldName('name')! : imported;
      const binding = imported.childForFieldName('alias') ?? original.firstNamedChild!;
      bind(binding);
      if (node.parent?.id !== root.id) continue;
      const item = items[from ? 0 : index];
      if (!item || original.text.length > ROUTE_LIMITS.name) continue;
      const name = nameOf(binding);
      imports.set(name, { ...item, module: !from && !imported.childForFieldName('alias') ? item.module.slice(0, 1) : item.module,
        names: from ? [nameOf(original)] : null });
      if (from && nameOf(node.childForFieldName('module_name')) === 'django.urls' && ['path', 're_path', 'include'].includes(nameOf(original))) django.set(name, nameOf(original));
    }
  }
  for (const { node, type } of nodes) {
    if (type !== 'function_definition' && type !== 'class_definition') continue;
    const declaration = node.parent?.type === 'decorated_definition' ? node.parent : node;
    if (declaration.parent?.id !== root.id) continue;
    const name = node.childForFieldName('name')!;
    bind(name);
    if (nameOf(name)) definitions.set(nameOf(name), node);
  }

  // 2. A name is trusted only at its binding and its specified reading positions.
  const invalid = new Set<string>();
  let odd = false;
  for (const { node, module, type } of nodes) {
    if (type !== 'identifier') continue;
    const name = nameOf(node), parent = node.parent;
    // `setattr(Detail, 'get', other)` reads the name as an argument but changes what it holds.
    if (['setattr', 'delattr', 'vars'].includes(name) && parent?.type === 'call' && parent.childForFieldName('function')?.id === node.id) {
      let receiver = argumentsOf(parent)[0];
      while (receiver?.type === 'attribute') receiver = receiver.childForFieldName('object')!;
      if (receiver?.type === 'identifier' && (definitions.has(nameOf(receiver)) || imports.has(nameOf(receiver)))) invalid.add(nameOf(receiver));
      odd ||= receiver?.type === 'identifier' && (django.has(nameOf(receiver)) || nameOf(receiver) === 'urlpatterns');
    }
    if (parent?.type === 'global_statement') invalid.add(name);
    const label = labelPosition(node);
    odd ||= pythonRouteMachinery.has(name) && !label;
    if (!module || label || parameterPosition(node) || bindings.get(name)?.has(node.id)) continue;
    const called = parent?.type === 'call' && parent.childForFieldName('function')?.id === node.id;
    if (django.has(name)) { if (!called) invalid.add(name); continue; }
    if (!definitions.has(name) && !imports.has(name)) continue;
    const argument = parent?.type === 'argument_list' && parent.parent?.type === 'call'
      || parent?.type === 'keyword_argument' && parent.childForFieldName('value')?.id === node.id;
    const attributeCall = parent?.type === 'attribute' && parent.childForFieldName('object')?.id === node.id
      && parent.parent?.type === 'call' && parent.parent.childForFieldName('function')?.id === parent.id;
    // Imported modules are read through their view attribute as well as through as_view().
    // `views.results` and `admin.site.urls` are a level or two; a longer chain is not followed.
    let access = node;
    for (let level = 0; level < 4 && imports.has(name); level++) {
      const outer = access.parent;
      if (outer?.type !== 'attribute' || outer.childForFieldName('object')?.id !== access.id) break;
      access = outer;
    }
    const importedRead = access !== node && (access.parent?.type === 'argument_list'
      || access.parent?.type === 'call' && access.parent.childForFieldName('function')?.id === access.id
      || access.parent?.type === 'keyword_argument' && access.parent.childForFieldName('value')?.id === access.id);
    if (!called && !argument && !attributeCall && !importedRead && !typePosition(node)) invalid.add(name);
  }
  for (const [name, places] of bindings) if (places.size !== 1) invalid.add(name);
  result.odd = result.plain && odd;
  result.init = result.plain && file.relativePath.split('/').at(-1) === '__init__.py' ? initFactsOf(root) : null;

  // 3. Read only literal list entries assigned directly to module-level urlpatterns.
  const lists = new Set<number>();
  for (const { node, type } of nodes) {
    if (type !== 'assignment' && type !== 'augmented_assignment' || node.parent?.parent?.id !== root.id) continue;
    if (nameOf(node.childForFieldName('left')) !== 'urlpatterns') continue;
    if (node.type === 'augmented_assignment' && node.childForFieldName('operator')?.text !== '+=') continue;
    const right = node.childForFieldName('right');
    const pending = right ? [right] : [];
    while (pending.length) {
      const value = pending.pop()!;
      if (value.type === 'list') { lists.add(value.id); continue; }
      if (value.type !== 'binary_operator' || value.childForFieldName('operator')?.text !== '+') continue;
      pending.push(value.childForFieldName('right')!, value.childForFieldName('left')!);
    }
  }
  for (const { node: call, type } of lists.size ? nodes : []) {
    if (type !== 'call' || !lists.has(call.parent?.id ?? -1)) continue;
    if (room.entries <= 0) { room.entriesCut = true; break; }
    if (call.childForFieldName('function')?.type !== 'identifier') continue;
    const callee = nameOf(call.childForFieldName('function'));
    if (invalid.has(callee) || !['path', 're_path'].includes(django.get(callee) ?? '')) continue;
    const args = argumentsOf(call), positions = args.filter(arg => !['keyword_argument', 'list_splat', 'dictionary_splat'].includes(arg.type));
    const keyword = (name: string) => args.find(arg => arg.type === 'keyword_argument' && nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
    let expression: Node | null | undefined = positions[1] ?? keyword('view');
    const include = expression?.type === 'call' ? expression.childForFieldName('function') : null;
    if (include?.type === 'identifier' && django.get(nameOf(include)) === 'include' && !invalid.has(nameOf(include))) { result.includes++; continue; }
    let asView = false;
    if (expression?.type === 'call') {
      const fn = expression.childForFieldName('function');
      const viewArgs = argumentsOf(expression);
      const safe = viewArgs.every(arg => arg.type === 'keyword_argument' && !['dispatch', 'setup', 'http_method_names'].includes(nameOf(arg.childForFieldName('name'))));
      asView = safe && fn?.type === 'attribute' && nameOf(fn.childForFieldName('attribute')) === 'as_view';
      expression = asView ? fn!.childForFieldName('object')! : undefined;
    }
    const local = expression?.type === 'attribute' ? expression.childForFieldName('object') : expression;
    const attribute = expression?.type === 'attribute' ? nameOf(expression.childForFieldName('attribute')) : null;
    const view = local?.type === 'identifier' && nameOf(local) && (attribute === null || attribute)
      ? { local: nameOf(local), attribute, asView } : null;
    const pathNode = positions[0] ?? keyword('route');
    const written = pathNode ? plainString(pathNode) : null;
    const regex = django.get(callee) === 're_path';
    // `bounded` looks at the length first, so an overlong route is never split or matched.
    const path = written === null ? null : bounded(regex ? written : '/' + written);
    const shape = regex || args.some(arg => arg.type === 'list_splat' || arg.type === 'dictionary_splat') ? { unmatched: true as const } : path === null ? {} : djangoShape(path);
    result.entries.push({ path, shape, view, basis: { text: firstLine(call), range: { fileId: file.id, fileHash: hash,
      startUtf16: call.startIndex, endUtf16: call.endIndex, ...lineRange(call), text: firstLine(call) } } });
    room.entries--;
  }
  const used = new Set(result.entries.map(entry => entry.view?.local));
  for (const [name, item] of imports) if (used.has(name) && !invalid.has(name)) result.imports.set(name, item);
  if (!result.plain) return result;

  // 4. Keep analyzer-compatible function ranges, and only directly declared class handlers.
  const handlerName = (name: string) => methods.has(name.toUpperCase()) && name === name.toLowerCase();
  // The statements written directly in a class body, from the top down. Assignments and `del` can replace a
  // method written above them, so every name they mention counts, within a budget: past it the class is left out.
  const handlersOf = (cls: Node): Map<string, Node | null> | null => {
    const found = new Map<string, Node | null>();
    let budget = 2_000;
    for (const statement of cls.childForFieldName('body')?.namedChildren ?? []) {
      const definition = statement.type === 'decorated_definition' ? statement.childForFieldName('definition') : statement;
      if (definition?.type === 'function_definition') {
        const method = nameOf(definition.childForFieldName('name'));
        if (changesDispatch.has(method)) return null;
        if (handlerName(method)) found.set(method, found.has(method) ? null : definition);
        continue;
      }
      const written = statement.type === 'expression_statement' ? statement.firstNamedChild : statement;
      if (!written || !['assignment', 'augmented_assignment', 'delete_statement'].includes(written.type)) continue;
      const pending = [written];
      while (pending.length) {
        if (--budget < 0) return null;
        const node = pending.pop()!;
        if (node.type !== 'identifier') { pending.push(...node.namedChildren); continue; }
        const name = nameOf(node);
        if (labelPosition(node) || !handlerName(name) && !changesDispatch.has(name)) continue;
        if (changesDispatch.has(name)) return null;
        found.set(name, null);
      }
    }
    return found;
  };
  const target = (node: Node): CallTarget => {
    const fn = pythonFunction(node)!;
    return { fileId: file.id, fileHash: hash, startUtf16: fn.declaration.startIndex, endUtf16: fn.declaration.endIndex,
      startLine: fn.declaration.startPosition.row + 1, name: shortName(fn.name) };
  };
  for (const [name, node] of definitions) {
    if (room.views <= 0) { room.viewsCut = true; break; }
    if (invalid.has(name) || node.hasError) continue;
    if (node.type === 'class_definition') {
      const handlers = handlersOf(node);
      if (!handlers) continue;
      result.views.set(name, { kind: 'class', methods: [...handlers].filter(([, node]) => node !== null)
        .map(([method, node]) => ({ method: method.toUpperCase() as Route['method'], handler: target(node!) })) });
      room.views--;
      continue;
    }
    let selected: Route['method'][] = ['ALL'];
    const decorators = node.parent?.type === 'decorated_definition' ? node.parent.namedChildren.filter(child => child.type === 'decorator') : [];
    let restrictions = 0;
    for (const decorator of decorators) {
      const expression = decorator.firstNamedChild!;
      const fn = expression.type === 'call' ? expression.childForFieldName('function') : expression;
      const method = nameOf(fn?.type === 'attribute' ? fn.childForFieldName('attribute') : fn);
      if (!['require_GET', 'require_POST', 'require_safe', 'require_http_methods', 'api_view'].includes(method)) continue;
      if (['require_http_methods', 'api_view'].includes(method) && expression.type !== 'call') continue;
      restrictions++;
      if (method === 'require_GET' || method === 'require_safe') { selected = ['GET']; continue; }
      if (method === 'require_POST') { selected = ['POST']; continue; }
      const args = expression.type === 'call' ? argumentsOf(expression) : [];
      if (expression.type === 'call' && method === 'api_view' && !args.length) { selected = ['GET']; continue; }
      const values = args[0] && ['list', 'tuple', 'set'].includes(args[0].type)
        ? args[0].namedChildren.filter(child => child.type !== 'comment').map(plainString) : null;
      selected = !values || values.includes(null) ? ['ALL']
        : [...new Set(values.filter(value => value!.length <= 6).map(value => value!.toUpperCase()).filter(value => methods.has(value)))] as Route['method'][];
    }
    result.views.set(name, { kind: 'function', handler: target(node), methods: restrictions > 1 ? ['ALL'] : selected });
    room.views--;
  }
  return result;
}

/** Resolve each urlconf using only the existing import resolver's single, certain file. */
export function djangoRoutes(files: ReadonlyMap<string, DjangoFile>, known: ReadonlySet<string>, maxRoutes: number, shouldStop: () => boolean):
  { routes: Route[]; skipped: number; cut: boolean; oddFiles: string[] } {
  const routes: Route[] = [];
  const oddFiles = new Set<string>();
  let skipped = 0, cut = false;
  const facts = { init: (path: string) => files.get(path)?.init ?? null, plain: (path: string) => files.get(path)?.plain ?? false };
  const ordered = [...files].sort(([a], [b]) => a.localeCompare(b));
  const resolved = new Map<string, Map<string, { path: string; name: string | null }>>();
  // 5. Imports resolve once per local binding, even when thousands of entries use that view.
  for (const [path, file] of ordered) {
    if (!file.plain) continue;
    const imports = new Map<string, { path: string; name: string | null }>();
    resolved.set(path, imports);
    for (const [name, item] of file.imports) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      const targets = resolvePythonImport(path, item, known, facts);
      const found = targets.length === 1 && targets[0].kind === 'file' ? targets[0] : null;
      // A target that is not plain offers no views, so it needs no check here.
      if (!found) continue;
      imports.set(name, { path: found.relativePath, name: found.names === 'all' ? null : found.names[0] });
    }
  }
  const entries = ordered.flatMap(([path, file]) => file.entries.map(entry => ({ path, file, entry })));
  for (const { path, file, entry } of entries) {
    if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
    const ref = entry.view;
    // A urlconf that is not plain has no views of its own and no resolved imports, so its entries fall out below.
    if (!ref) { skipped++; continue; }
    let view = ref.attribute === null ? file.views.get(ref.local) : undefined;
    let viewPath = path;
    const imported = resolved.get(path)?.get(ref.local);
    if (!view && imported) {
      viewPath = imported.path;
      const name = ref.attribute === null ? imported.name : imported.name === null ? ref.attribute : null;
      view = name === null ? undefined : files.get(viewPath)?.views.get(name);
    }
    if (!view || ref.asView !== (view.kind === 'class')) { skipped++; continue; }
    if (view.kind === 'class' && !view.methods.length) { skipped++; continue; }
    const handlers = view.kind === 'function' ? view.methods.map(method => ({ method, handler: view.handler })) : view.methods;
    // 6. Odd files stay visible, but their routes have no matchable shape.
    const odd = file.odd || files.get(viewPath)!.odd;
    for (const { method, handler } of handlers) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      if (routes.length >= maxRoutes) { cut = true; continue; }
      if (file.odd) oddFiles.add(path);
      if (files.get(viewPath)!.odd) oddFiles.add(viewPath);
      routes.push({ framework: 'django', prefix: 'unknown', method, handler, path: entry.path, basis: entry.basis,
        ...(odd ? { unmatched: true as const } : entry.shape) });
    }
  }
  return { routes, skipped, cut, oddFiles: [...oddFiles] };
}
