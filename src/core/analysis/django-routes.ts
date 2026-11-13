import type Parser from 'tree-sitter';
import { posix } from 'node:path';
import type { CallTarget, ProjectFile, Route } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { firstLine, lineRange } from './names';
import { initFactsOf, mentionsMachinery, moduleFile, normalize, pythonImportsOf, resolvePythonImport, type InitFacts, type PythonImport } from './python-imports';
import { djangoShape, labelPosition, parameterPosition, plainString, pythonRouteMachinery, typePosition, type walkPython } from './python-routes';
import { pythonFunction } from './python-syntax';
import { bounded, ROUTE_LIMITS, shortName } from './routes';

type Node = Parser.SyntaxNode;
/** A view expression in urlpatterns, optionally followed by .as_view(). */
interface ViewRef { local: string; attribute: string | null; asView: boolean }
interface DjangoEntry {
  path: string | null;
  /** Original path text; null for unreadable, regex or spread entries that cannot be prefixed. */
  written: string | null;
  shape: Pick<Route, 'segments' | 'typed' | 'unmatched'>;
  view: ViewRef | null;
  basis: Route['basis'];
}
/** One path entry whose literal include can be joined from the manage.py folder. */
interface DjangoInclude { written: string; module: string[] }
type DjangoView = { kind: 'function'; handler: CallTarget; methods: Route['method'][] }
  | { kind: 'class'; methods: { method: Route['method']; handler: CallTarget }[] };
/** Values only: syntax trees are released after each file is read. */
export interface DjangoFile {
  entries: DjangoEntry[];
  includes: DjangoInclude[];
  unfollowed: number;
  imports: Map<string, PythonImport>;
  views: Map<string, DjangoView>;
  plain: boolean;
  init: InitFacts | null;
  odd: boolean;
  /** The plainly stated ROOT_URLCONF module, if this file settles it. */
  root: string[] | null;
  /** Mentions of the setting or code that moves URL matching which cannot be settled. */
  rootUnclear: boolean;
  /** Whether the read entries remain in urlpatterns after the module runs. */
  listFinal: boolean;
  /** Whether this file can reach another module's urlpatterns by name. */
  reachesList: boolean;
}
/** What may still be kept for the whole project, and whether something was left out because a count ran out. */
export interface DjangoRoom { entries: number; views: number; entriesCut?: boolean; viewsCut?: boolean }
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const changesDispatch = new Set(['as_view', 'dispatch', 'http_method_names', 'setup']);
const argumentsOf = (node: Node) => node.childForFieldName('arguments')?.namedChildren.filter(child => child.type !== 'comment') ?? [];

export function djangoFile(file: ProjectFile, walk: ReturnType<typeof walkPython>, hash: string, room: DjangoRoom): DjangoFile {
  const { root, nodes, complete } = walk;
  const text = root.text.normalize('NFKC');
  let mentions = 0;
  for (let at = text.indexOf('ROOT_URLCONF'); at !== -1; at = text.indexOf('ROOT_URLCONF', at + 'ROOT_URLCONF'.length)) mentions++;
  const result: DjangoFile = { entries: [], includes: [], unfollowed: 0, imports: new Map(), views: new Map(), plain: complete && !root.hasError,
    init: null, odd: false, root: null, rootUnclear: false, listFinal: false,
    reachesList: (!complete || root.hasError) && text.includes('urlpatterns') };
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
  let lastStar = -1;
  for (const { node, module, type } of nodes) {
    // Every name the import check looks for starts with two underscores, so other names are not handed to it.
    if (type === 'identifier' && nameOf(node).startsWith('__') && mentionsMachinery(node)) result.plain = false;
    if (!module || type !== 'import_statement' && type !== 'import_from_statement' || node.hasError) continue;
    if (node.namedChildren.some(child => child.type === 'wildcard_import')) { result.plain = false; lastStar = node.startIndex; }
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
  let stated = 0, firstRoot = -1, rootValue: string | null = null, conflicting = false;
  let listAssigned = false, invalidList = false;
  let stringEnd = 0;
  // The first statement of a body, found once per body: a sibling getter in the binding rescans the earlier siblings,
  // so stepping back over thousands of comments before a docstring would cost the square of their number.
  const firstStatements = new Map<number, number | undefined>();
  const firstStatement = (body: Node) => {
    if (!firstStatements.has(body.id)) firstStatements.set(body.id, body.namedChildren.find(child => child.type !== 'comment')?.id);
    return firstStatements.get(body.id);
  };
  for (const { node, module, type } of nodes) {
    if (type === 'assignment' && complete && !root.hasError && !node.hasError
      && node.parent?.type === 'expression_statement' && node.parent.parent?.id === root.id) {
      const left = node.childForFieldName('left');
      const value = left?.type === 'identifier' && nameOf(left) === 'ROOT_URLCONF' ? plainString(node.childForFieldName('right')) : null;
      // A Python file is read up to 256 KiB, so splitting the whole value once is cheap; the part limits below
      // accept exactly the module names an include accepts.
      if (value !== null) {
        const parts = value.split('.');
        if (parts.length <= ROUTE_LIMITS.segments && parts.every(part => part.length <= ROUTE_LIMITS.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
          if (!stated) { rootValue = value; firstRoot = node.startIndex; }
          conflicting ||= rootValue !== value;
          stated++;
        }
      }
    }
    if (type === 'string') {
      // A string inside another string (an f-string's expression) is part of the outer string's text, and an outer
      // string with an expression is never a docstring, so only outermost strings are checked: nested strings would
      // otherwise read the same text once for every level.
      if (node.startIndex < stringEnd || result.reachesList) continue;
      stringEnd = node.endIndex;
      if (!node.text.normalize('NFKC').includes('urlpatterns')) continue;
      const statement = node.parent, body = statement?.parent;
      const docstring = !!body && statement?.type === 'expression_statement' && statement.namedChildCount === 1
        && (body.id === root.id || body.type === 'block' && ['class_definition', 'function_definition'].includes(body.parent?.type ?? ''))
        && firstStatement(body) === statement.id
        && !node.namedChildren.some(child => child.type === 'interpolation');
      if (!docstring) result.reachesList = true;
      continue;
    }
    if (type !== 'identifier') continue;
    const name = nameOf(node), parent = node.parent;
    if (name === 'urlpatterns') {
      const first = !listAssigned && parent?.type === 'assignment' && parent.childForFieldName('left')?.id === node.id
        && parent.parent?.type === 'expression_statement' && parent.parent.parent?.id === root.id;
      if (first) listAssigned = true;
      // The walk visits nodes in source order, so an addition seen once the first assignment is known comes after it.
      const addition = listAssigned && parent?.type === 'augmented_assignment'
        && parent.childForFieldName('left')?.id === node.id && parent.childForFieldName('operator')?.text === '+=';
      let allowed = first || addition;
      const right = allowed ? parent!.childForFieldName('right') : null;
      const pending = right ? [right] : [];
      if (allowed && !right) allowed = false;
      while (pending.length && allowed) {
        const value = pending.pop()!;
        if (value.type === 'list') continue;
        if (value.type !== 'binary_operator' || value.childForFieldName('operator')?.text !== '+') { allowed = false; break; }
        pending.push(value.childForFieldName('right')!, value.childForFieldName('left')!);
      }
      invalidList ||= !allowed;
      // A name in a label position names something else's attribute and can reach another module's list: an attribute
      // (`m.urlpatterns`), an import, a keyword (`vars(m).update(urlpatterns=[])`), a dotted or class pattern
      // (`case ModuleType(urlpatterns=p)`), an attribute in a type (`-> holder[0].urlpatterns`, run when the def runs).
      // These are all the label positions among the grammar's nodes that hold an identifier directly (node-types.json
      // of tree-sitter-python 0.23); the others read or bind this file's own name. After a star import, any other use
      // may be another module's list.
      const label = labelPosition(node) || ['keyword_pattern', 'dotted_name', 'member_type'].includes(parent?.type ?? '');
      if (label || lastStar !== -1 && !allowed) result.reachesList = true;
    }
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
  result.rootUnclear = ['urlconf', 'SCRIPT_NAME', 'script_prefix'].some(word => text.includes(word))
    || mentions !== stated || conflicting || stated > 0 && (odd || lastStar > firstRoot);
  result.root = stated > 0 && !result.rootUnclear ? rootValue!.split('.') : null;
  result.listFinal = result.plain && !invalidList;
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
    const pathNode = positions[0] ?? keyword('route');
    const written = pathNode ? plainString(pathNode) : null;
    const regex = django.get(callee) === 're_path';
    const spread = args.some(arg => arg.type === 'list_splat' || arg.type === 'dictionary_splat');
    const include = expression?.type === 'call' ? expression.childForFieldName('function') : null;
    if (include?.type === 'identifier' && django.get(nameOf(include)) === 'include' && !invalid.has(nameOf(include))) {
      room.entries--;
      const includeArgs = argumentsOf(expression!);
      const positional = includeArgs.filter(arg => arg.type !== 'keyword_argument');
      const module = positional.length === 1 ? plainString(positional[0]) : null;
      const allowed = includeArgs.every(arg => arg.type !== 'keyword_argument' || nameOf(arg.childForFieldName('name')) === 'namespace');
      if (regex || spread || written === null || written.length > ROUTE_LIMITS.pathLength || !allowed
        || module === null || module.length > (ROUTE_LIMITS.name + 1) * ROUTE_LIMITS.segments - 1) { result.unfollowed++; continue; }
      const parts = module.split('.');
      if (parts.length > ROUTE_LIMITS.segments || parts.some(part => part.length > ROUTE_LIMITS.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) { result.unfollowed++; continue; }
      result.includes.push({ written, module: parts });
      continue;
    }
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
    // `bounded` looks at the length first, so an overlong route is never split or matched.
    const path = written === null ? null : bounded(regex ? written : '/' + written);
    const shape = regex || spread ? { unmatched: true as const } : path === null ? {} : djangoShape(path);
    result.entries.push({ path, written: regex || spread || written === null || written.length > ROUTE_LIMITS.pathLength ? null : written,
      shape, view, basis: { text: firstLine(call), range: { fileId: file.id, fileHash: hash,
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

/** Join literal includes from manage.py folders; resolve views with the existing import rules. */
export function djangoRoutes(files: ReadonlyMap<string, DjangoFile>, known: ReadonlySet<string>, maxRoutes: number, shouldStop: () => boolean, allRead: boolean):
  { routes: Route[]; skipped: number; cut: boolean; oddFiles: string[]; unfollowed: number } {
  const routes: Route[] = [];
  const oddFiles = new Set<string>();
  let skipped = 0, cut = false, unfollowed = 0;
  const facts = { init: (path: string) => files.get(path)?.init ?? null, plain: (path: string) => files.get(path)?.plain ?? false };
  const ordered = [...files].sort(([a], [b]) => a.localeCompare(b));
  const projectFolder = (filePath: string): string | null => {
    let folder = posix.dirname(filePath);
    while (!known.has(posix.join(folder, 'manage.py'))) {
      if (folder === '.') return null;
      folder = posix.dirname(folder);
    }
    return folder;
  };
  const starts = new Set<string>();
  if (allRead && !ordered.some(([, file]) => file.rootUnclear || file.reachesList)) {
    const settings = new Map<string, Set<string>>();
    for (const [filePath, file] of ordered) {
      if (!file.root) continue;
      const folder = projectFolder(filePath);
      if (folder === null) continue;
      const modules = settings.get(folder) ?? new Set<string>();
      modules.add(file.root.join('.'));
      settings.set(folder, modules);
    }
    for (const [folder, modules] of settings) {
      if (modules.size !== 1) continue;
      const target = moduleFile(folder, [...modules][0].split('.'), known, facts);
      if (target === null) continue;
      const file = files.get(target);
      if (file?.plain && file.listFinal && projectFolder(target) === folder) starts.add(target);
    }
  }
  // Includes are edges only when one module is reachable from the nearest manage.py.
  const edges = new Map<string, { target: string; written: string; sameFolder: boolean }[]>();
  const incoming = new Set<string>();
  for (const [filePath, file] of ordered) {
    unfollowed += file.unfollowed;
    if (!file.includes.length) continue;
    if (!file.plain) { unfollowed += file.includes.length; continue; }
    const root = projectFolder(filePath);
    const outgoing: { target: string; written: string; sameFolder: boolean }[] = [];
    edges.set(filePath, outgoing);
    for (const include of file.includes) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      const target = root === null ? null : moduleFile(root, include.module, known, facts);
      if (target === null || !files.has(target)) { unfollowed++; continue; }
      outgoing.push({ target, written: include.written, sameFolder: root === projectFolder(target) });
      incoming.add(target);
    }
  }
  // Keep fragment validity separately: joining '<int:' and 'id>' cannot create a converter.
  const incomplete = (written: string) => /[<>]/.test(written.replace(/<[^<>]*>/g, ''));
  type Prefix = { written: string; known: boolean; incomplete: boolean; oddPaths: string[] };
  /** What a file has when nothing is joined in front of it: its routes as written. */
  const bare = (filePath: string, file: DjangoFile): Prefix => ({ written: '', known: starts.has(filePath), incomplete: false, oddPaths: file.odd ? [filePath] : [] });
  const prefixes = new Map<string, Prefix[]>();
  const pending: { file: string; prefix: Prefix; chain: string[] }[] = [];
  const otherSources: typeof pending = [];
  const seen = new Set<string>();
  for (const [filePath, file] of ordered) {
    if (!starts.has(filePath) && incoming.has(filePath)) continue;
    const prefix = bare(filePath, file);
    prefixes.set(filePath, [prefix]);
    const sources = starts.has(filePath) ? pending : otherSources;
    sources.push({ file: filePath, prefix, chain: [filePath] });
    if (starts.has(filePath)) seen.add(JSON.stringify([filePath, '', false, file.odd]));
  }
  let attempts = 0, created = 0;
  // Finish root chains before seeding other sources: deduplication keeps the first arrival.
  propagate: for (let index = 0; index < pending.length + otherSources.length; index++) {
    if (index === pending.length) pending.push(...otherSources.splice(0));
    const current = pending[index];
    for (const edge of edges.get(current.file) ?? []) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      if (++attempts > 200_000) { cut = true; break propagate; }
      if (current.chain.includes(edge.target)) continue;
      const written = current.prefix.written + edge.written;
      if (current.chain.length >= 10 || written.length > ROUTE_LIMITS.pathLength) { cut = true; continue; }
      const prefix: Prefix = { written, known: current.prefix.known && files.get(edge.target)!.listFinal && edge.sameFolder, incomplete: current.prefix.incomplete || incomplete(edge.written),
        oddPaths: files.get(edge.target)!.odd ? [...current.prefix.oddPaths, edge.target] : current.prefix.oddPaths };
      // Two chains that attach a file with the same text make the same routes: only the first is kept.
      const key = JSON.stringify([edge.target, written, prefix.incomplete, prefix.oddPaths.length > 0]);
      if (seen.has(key)) continue;
      if (created >= 5_000) { cut = true; break propagate; }
      seen.add(key);
      const collected = prefixes.get(edge.target) ?? [];
      collected.push(prefix);
      prefixes.set(edge.target, collected);
      pending.push({ file: edge.target, prefix, chain: [...current.chain, edge.target] });
      created++;
    }
  }
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
  const prepared: { path: string; file: DjangoFile; entry: DjangoEntry; viewPath: string;
    handlers: { method: Route['method']; handler: CallTarget }[] }[] = [];
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
    if (!handlers.length) continue;
    prepared.push({ path, file, entry, viewPath, handlers });
  }
  // Every prepared combination produces a route. Stop the entire product at the first extra route.
  build: for (const { path, file, entry, viewPath, handlers } of prepared) {
    const collected = prefixes.get(path) ?? [bare(path, file)];
    for (let index = 0; index < collected.length * handlers.length; index++) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      if (routes.length >= maxRoutes) { cut = true; break build; }
      const prefix = collected[Math.floor(index / handlers.length)];
      const { method, handler } = handlers[index % handlers.length];
      const joined = entry.written === null ? entry.path : bounded('/' + prefix.written + entry.written);
      const odd = prefix.oddPaths.length > 0 || files.get(viewPath)!.odd;
      prefix.oddPaths.forEach(oddPath => oddFiles.add(oddPath));
      if (files.get(viewPath)!.odd) oddFiles.add(viewPath);
      const shape = entry.written === null || !prefix.written ? entry.shape : joined === null ? {} : djangoShape(joined);
      // A bracket left open in the entry needs its other half in a prefix fragment, which is then incomplete too.
      routes.push({ framework: 'django', prefix: prefix.known && entry.written !== null ? 'known' : 'unknown', method, handler, path: joined, basis: entry.basis,
        ...(odd || prefix.incomplete ? { unmatched: true as const } : shape) });
    }
  }
  return { routes, skipped, cut, oddFiles: [...oddFiles], unfollowed };
}
