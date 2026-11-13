import type Parser from 'tree-sitter';
import { posix } from 'node:path';
import type { CallTarget, ProjectFile, Route, UnresolvedRoute } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { firstLine, lineRange } from './names';
import { initFactsOf, mentionsMachinery, moduleFile, normalize, pythonImportsOf, resolvePythonImport, type InitFacts, type PythonImport } from './python-imports';
import { djangoShape, labelPosition, parameterPosition, plainString, pythonRouteMachinery, typePosition, type walkPython } from './python-routes';
import { pythonFunction } from './python-syntax';
import { bounded, ROUTE_LIMITS, shortName } from './routes';

type Node = Parser.SyntaxNode;
/** A view expression in urlpatterns, optionally followed by .as_view(). */
interface ViewRef {
  local: string; attribute: string | null; asView: boolean;
  actions?: { method: Route['method']; action: string }[] | null;
  drfOnly?: true;
  at?: number;
}
interface DjangoEntry {
  kind: UnresolvedRoute['kind'];
  path: string | null;
  /** Raw regex literals are displayed only, never handed to request matching. */
  displayPath?: string | null;
  /** Original path text; null for unreadable, regex or spread entries that cannot be prefixed. */
  written: string | null;
  shape: Pick<Route, 'segments' | 'typed' | 'unmatched'>;
  view: ViewRef | null;
  basis: Route['basis'];
  invalidRegistration?: true;
  router?: true;
  unresolved?: true;
}
/** One path entry whose literal include can be joined from the manage.py folder. */
interface DjangoInclude { written: string; module: string[] }
interface DjangoStaticAddition {
  prefix: string | null;
  basis: Route['basis'];
  view: ViewRef | null;
  defaultView: boolean;
}
interface DrfAction { action: string; detail: boolean; methods: Route['method'][]; urlPath: string | null }
interface DrfRegistration { prefix: string | null; basename: string | null; view: ViewRef | null; basis: Route['basis']; end: number; valid: boolean }
interface DrfUse { at: number; prefix: string | null; helpers: string[] }
interface DrfRouter {
  name: string; factory: string; end: number; kind: 'SimpleRouter' | 'DefaultRouter';
  trailingSlash: boolean; regex: boolean; safe: boolean;
  registrations: DrfRegistration[]; uses: DrfUse[];
}
interface DrfSymbol { root: string; end: number; name: string }
type DjangoView = { kind: 'function'; handler: CallTarget; methods: Route['method'][] }
  | { kind: 'class'; methods: { method: Route['method']; handler: CallTarget }[] }
  | { kind: 'viewset'; definedAt: number; actions: Map<string, CallTarget | null>; base: string; extraActions: DrfAction[]; routerSafe: boolean; lookupSafe: boolean };
/** Values only: syntax trees are released after each file is read. */
export interface DjangoFile {
  entries: DjangoEntry[];
  includes: DjangoInclude[];
  staticAdditions: DjangoStaticAddition[];
  unfollowed: number;
  imports: Map<string, PythonImport>;
  views: Map<string, DjangoView>;
  viewAliases: Map<string, { view: ViewRef; end: number }>;
  viewsetInvalid: Set<string>;
  routers: DrfRouter[];
  drfMutationImports: Map<string, PythonImport>;
  drfMutationsCut: boolean;
  drfFrameworkUnsafe: boolean;
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
export interface DjangoRoom { entries: number; views: number; entriesCut?: boolean; viewsCut?: boolean; mutationsCut?: boolean }
const mutationRooms = new WeakMap<DjangoRoom, { left: number }>();
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const changesDispatch = new Set(['as_view', 'dispatch', 'http_method_names', 'setup']);
const viewsetBases = ['ViewSet', 'GenericViewSet', 'ModelViewSet', 'ReadOnlyModelViewSet'];
const standardActions = new Set(['list', 'create', 'retrieve', 'update', 'partial_update', 'destroy']);
const lookupSettings = new Set(['lookup_field', 'lookup_url_kwarg', 'lookup_value_regex', 'lookup_value_converter']);
const viewsetDispatch = new Set([...changesDispatch, 'initialize_request', 'initial', '__init__', '__new__', '__getattribute__', '__getattr__', '__setattr__']);
const replacedActions = new Set(['name', 'description', 'suffix', 'detail', 'basename', 'action_map']);
function originalActions(actions: ViewRef['actions']): boolean {
  if (!actions?.length) return false;
  const replaced = new Set<string>();
  // DRF assigns HTTP methods in dictionary order; a later lookup can see an earlier assignment.
  for (const { method, action } of actions) {
    if (replacedActions.has(action) || replaced.has(action)) return false;
    replaced.add(method.toLowerCase());
  }
  return true;
}
const argumentsOf = (node: Node) => node.childForFieldName('arguments')?.namedChildren.filter(child => child.type !== 'comment') ?? [];
const positional = (node: Node) => !['keyword_argument', 'list_splat', 'dictionary_splat'].includes(node.type);
function displayedRegex(node: Node | null | undefined): string | null {
  const plain = plainString(node);
  if (plain !== null) return bounded(plain);
  if (node?.type !== 'string' || node.hasError) return null;
  const start = node.firstNamedChild?.text, quote = start?.match(/^[rR]("""|'''|"|')$/)?.[1];
  return start && quote ? bounded(node.text.slice(start.length, -quote.length)) : null;
}
function registrationArgumentsValid(args: Node[], positionNames: string[], extraKeywords: boolean,
  nameOf: (node: Node | null | undefined) => string): boolean {
  const written = new Set<string>();
  let positions = 0, seenKeyword = false;
  for (const arg of args) {
    if (['list_splat', 'dictionary_splat'].includes(arg.type)) return false;
    if (arg.type !== 'keyword_argument') {
      if (seenKeyword || positions >= positionNames.length) return false;
      written.add(positionNames[positions++]); continue;
    }
    seenKeyword = true;
    const name = nameOf(arg.childForFieldName('name'));
    if (!name || written.has(name) || !extraKeywords && !positionNames.includes(name)) return false;
    written.add(name);
  }
  return true;
}

function receiverOf(expression: Node): Node | null {
  let read: Node | null = expression.type === 'call' ? expression.childForFieldName('function') : expression;
  for (let level = 0; level < 3 && read?.type === 'attribute'; level++) read = read.childForFieldName('object');
  return read?.type === 'identifier' ? read : null;
}

/** Collect local router identities and actual source registrations; no generated URL products yet. */
function drfRoutersOf(root: Node, nodes: ReturnType<typeof walkPython>['nodes'], symbols: Map<string, DrfSymbol>, django: Map<string, string>,
  room: DjangoRoom, nameOf: (node: Node | null | undefined) => string, bind: (node: Node) => void, basisOf: (node: Node) => Route['basis']) {
  const routers = new Map<string, DrfRouter>(), reads = new Set<number>(), factoryReads = new Set<number>();
  const classReads = new Map<number, { router: DrfRouter; name: string }>();
  const take = () => {
    if (room.entries <= 0) { room.entriesCut = true; return false; }
    room.entries--; return true;
  };
  for (const { node, type } of nodes) {
    if (type !== 'assignment' || node.parent?.type !== 'expression_statement' || node.parent.parent?.id !== root.id) continue;
    const left = node.childForFieldName('left'), right = node.childForFieldName('right');
    if (left?.type !== 'identifier' || right?.type !== 'call') continue;
    const symbol = symbols.get(nameOf(right.childForFieldName('function')));
    if (!symbol || !['SimpleRouter', 'DefaultRouter'].includes(symbol.name) || !take()) continue;
    bind(left);
    const args = argumentsOf(right), positions = args.filter(positional);
    const option = (name: string, index: number) => positions[index] ?? args.find(arg => nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
    const trailing = option('trailing_slash', 0), regex = option('use_regex_path', 1);
    const valid = registrationArgumentsValid(args, ['trailing_slash', 'use_regex_path'], false, nameOf)
      && [trailing, regex].every(value => !value || ['true', 'false'].includes(value.type));
    const name = nameOf(left);
    routers.set(name, { name, factory: symbol.root, end: node.endIndex, kind: symbol.name as DrfRouter['kind'],
      trailingSlash: trailing?.type !== 'false', regex: regex?.type !== 'false', safe: valid && symbol.end < node.startIndex,
      registrations: [], uses: [] });
    reads.add(left.id);
    const receiver = receiverOf(right);
    if (receiver) factoryReads.add(receiver.id);
  }
  for (const { node, type } of nodes) {
    if (type !== 'call' || node.parent?.type !== 'expression_statement' || node.parent.parent?.id !== root.id) continue;
    const fn = node.childForFieldName('function'), receiver = fn?.type === 'attribute' ? fn.childForFieldName('object') : null;
    if (receiver?.type !== 'identifier' || nameOf(fn?.childForFieldName('attribute')) !== 'register') continue;
    const router = routers.get(nameOf(receiver));
    if (!router || !take()) continue;
    reads.add(receiver.id);
    const args = argumentsOf(node), positions = args.filter(positional);
    const arg = (name: string, index: number) => positions[index] ?? args.find(arg => nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
    const prefix = displayedRegex(arg('prefix', 0)), basename = plainString(arg('basename', 2)), expression = arg('viewset', 1);
    const view = viewRefOf(expression, nameOf);
    const valid = registrationArgumentsValid(args, ['prefix', 'viewset', 'basename'], false, nameOf)
      && !!expression && !!view && !view.asView && node.startIndex > router.end;
    router.registrations.push({ prefix, basename: basename && basename.length <= ROUTE_LIMITS.name ? basename : null,
      view: view && !view.asView ? { ...view, at: node.startIndex } : null, basis: basisOf(node), end: node.endIndex, valid });
    const read = expression && receiverOf(expression);
    if (valid && read) classReads.set(read.id, { router, name: view!.local });
  }
  const use = (expression: Node, prefix: string | null, helpers: string[]) => {
    const receiver = expression.type === 'attribute' ? expression.childForFieldName('object') : null;
    if (receiver?.type !== 'identifier' || nameOf(expression.childForFieldName('attribute')) !== 'urls') return false;
    const router = routers.get(nameOf(receiver));
    if (!router) return false;
    if (!take()) return true;
    reads.add(receiver.id);
    router.uses.push({ at: expression.startIndex, prefix, helpers });
    return true;
  };
  for (const { node, type } of nodes) {
    if (!['assignment', 'augmented_assignment'].includes(type) || node.parent?.parent?.id !== root.id
      || nameOf(node.childForFieldName('left')) !== 'urlpatterns') continue;
    if (type === 'augmented_assignment' && node.childForFieldName('operator')?.text !== '+=') continue;
    const right = node.childForFieldName('right'), pending = right ? [right] : [];
    while (pending.length) {
      const value = pending.pop()!;
      if (use(value, '', [])) continue;
      if (value.type === 'binary_operator' && value.childForFieldName('operator')?.text === '+') {
        pending.push(value.childForFieldName('right')!, value.childForFieldName('left')!); continue;
      }
      if (value.type !== 'list') continue;
      for (const call of value.namedChildren) {
        if (call.type !== 'call') continue;
        const pathName = nameOf(call.childForFieldName('function'));
        if (django.get(pathName) !== 'path') continue;
        const args = argumentsOf(call), positions = args.filter(positional);
        if (!registrationArgumentsValid(args, ['route', 'view', 'kwargs', 'name'], false, nameOf)) continue;
        const arg = (name: string, index: number) => positions[index] ?? args.find(arg => nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
        const view = arg('view', 1), prefix = plainString(arg('route', 0));
        if (view?.type !== 'call') continue;
        const includeName = nameOf(view.childForFieldName('function')), included = argumentsOf(view);
        if (django.get(includeName) !== 'include' || included.length !== 1 || !positional(included[0])) continue;
        use(included[0], prefix === null ? null : bounded(prefix), [pathName, includeName]);
      }
    }
  }
  // Names may not escape through aliases, nested functions or attributes other than the exact reads above.
  const badFactories = new Set<string>(), factoryRoots = new Set([...symbols.values()].filter(symbol => ['SimpleRouter', 'DefaultRouter'].includes(symbol.name)).map(symbol => symbol.root));
  for (const { node, type } of nodes) {
    if (type !== 'identifier' || labelPosition(node) || parameterPosition(node) || typePosition(node)) continue;
    const name = nameOf(node), router = routers.get(name);
    if (router && !reads.has(node.id)) router.safe = false;
    if (factoryRoots.has(name) && !factoryReads.has(node.id) && node.parent?.type !== 'dotted_name' && node.parent?.type !== 'aliased_import') badFactories.add(name);
  }
  for (const router of routers.values()) {
    if (badFactories.has(router.factory)) router.safe = false;
    const basenames = new Set<string>();
    for (const registration of router.registrations) {
      if (registration.basename === null) continue;
      if (basenames.has(registration.basename)) router.safe = false;
      basenames.add(registration.basename);
    }
  }
  return { routers, classReads, factoryReads };
}

function drfActionOf(statement: Node, action: string, symbols: Map<string, DrfSymbol>, invalid: Set<string>,
  nameOf: (node: Node | null | undefined) => string): DrfAction | null {
  const decorators = statement.namedChildren.filter(child => child.type === 'decorator');
  if (decorators.length !== 1) return null;
  const call = decorators[0].firstNamedChild;
  if (call?.type !== 'call') return null;
  const symbol = symbols.get(nameOf(call.childForFieldName('function')));
  if (symbol?.name !== 'action' || invalid.has(symbol.root) || symbol.end > call.startIndex) return null;
  const args = argumentsOf(call), positions = args.filter(positional);
  if (!registrationArgumentsValid(args, ['methods', 'detail', 'url_path', 'url_name'], false, nameOf)) return null;
  const arg = (name: string, index: number) => positions[index] ?? args.find(arg => nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
  const detail = arg('detail', 1), selected = arg('methods', 0), path = arg('url_path', 2), urlName = arg('url_name', 3);
  if (!detail || !['true', 'false'].includes(detail.type)) return null;
  if (urlName && urlName.type !== 'none' && plainString(urlName) === null) return null;
  const methodValues = !selected || selected.type === 'none' ? ['get']
    : ['list', 'tuple'].includes(selected.type) ? selected.namedChildren.filter(child => child.type !== 'comment').map(plainString) : null;
  if (!methodValues || methodValues.length > 5 || methodValues.some(method => method === null || !/^[A-Za-z]+$/.test(method) || method.length > 6 || !methods.has(method.toUpperCase()))) return null;
  const written = !path || path.type === 'none' ? action : displayedRegex(path);
  return { action, detail: detail.type === 'true', methods: [...new Set(methodValues.map(method => method!.toUpperCase()))] as Route['method'][],
    urlPath: written === '' ? action : written };
}

function viewRefOf(input: Node | null | undefined, nameOf: (node: Node | null | undefined) => string): ViewRef | null {
  let expression = input, asView = false;
  let actions: ViewRef['actions'], drfOnly = false;
  if (expression?.type === 'call') {
    const fn = expression.childForFieldName('function'), args = argumentsOf(expression);
    const safe = args.every(arg => arg.type === 'keyword_argument' && !['dispatch', 'setup', 'http_method_names'].includes(nameOf(arg.childForFieldName('name'))));
    const actionArg = args.find(positional) ?? args.find(arg => nameOf(arg.childForFieldName('name')) === 'actions')?.childForFieldName('value');
    if (actionArg) {
      actions = null;
      if (registrationArgumentsValid(args, ['actions'], false, nameOf) && actionArg.type === 'dictionary') {
        const pairs = actionArg.namedChildren.filter(child => child.type !== 'comment');
        const selected: NonNullable<ViewRef['actions']> = [], used = new Set<string>();
        if (pairs.length > 0 && pairs.length <= 5) for (const pair of pairs) {
          const method = plainString(pair.childForFieldName('key')), action = plainString(pair.childForFieldName('value'));
          if (pair.type !== 'pair' || !method || !/^[a-z]+$/.test(method) || !methods.has(method.toUpperCase())
            || used.has(method) || !action || action.length > ROUTE_LIMITS.name) break;
          used.add(method); selected.push({ method: method.toUpperCase() as Route['method'], action });
        }
        if (selected.length && selected.length === pairs.length) actions = selected;
      }
    }
    drfOnly = !safe && !!actions;
    asView = (safe || drfOnly) && fn?.type === 'attribute' && nameOf(fn.childForFieldName('attribute')) === 'as_view';
    expression = asView ? fn!.childForFieldName('object')! : undefined;
  }
  const local = expression?.type === 'attribute' ? expression.childForFieldName('object') : expression;
  const attribute = expression?.type === 'attribute' ? nameOf(expression.childForFieldName('attribute')) : null;
  return local?.type === 'identifier' && nameOf(local) && (attribute === null || attribute)
    ? { local: nameOf(local), attribute, asView, ...(actions !== undefined ? { actions, at: input!.startIndex } : {}), ...(drfOnly ? { drfOnly: true as const } : {}) } : null;
}

function staticAddition(call: Node, basis: Route['basis'], nameOf: (node: Node | null | undefined) => string): DjangoStaticAddition | null {
  const args = argumentsOf(call), positions = args.filter(positional);
  if (!registrationArgumentsValid(args, ['prefix', 'view'], true, nameOf)) return null;
  const keyword = (name: string) => args.find(arg => arg.type === 'keyword_argument' && nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
  const prefix = positions[0] ?? keyword('prefix');
  if (!prefix) return null;
  const view = positions[1] ?? keyword('view');
  const written = plainString(prefix);
  return { prefix: written === null ? null : bounded(written), basis, view: viewRefOf(view, nameOf), defaultView: !view };
}

export function djangoFile(file: ProjectFile, walk: ReturnType<typeof walkPython>, hash: string, room: DjangoRoom): DjangoFile {
  const { root, nodes, complete } = walk;
  const text = root.text.normalize('NFKC');
  let mentions = 0;
  for (let at = text.indexOf('ROOT_URLCONF'); at !== -1; at = text.indexOf('ROOT_URLCONF', at + 'ROOT_URLCONF'.length)) mentions++;
  const result: DjangoFile = { entries: [], includes: [], staticAdditions: [], unfollowed: 0, imports: new Map(), views: new Map(), viewAliases: new Map(), viewsetInvalid: new Set(), routers: [], drfMutationImports: new Map(), drfMutationsCut: false, drfFrameworkUnsafe: false, plain: complete && !root.hasError,
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
  const djangoAt = new Map<string, number>();
  const imports = new Map<string, PythonImport>();
  const importedAt = new Map<string, number>();
  const definitions = new Map<string, Node>();
  const drfBases = new Map<string, DrfSymbol>(), drfSymbols = new Map<string, DrfSymbol>();
  const drfRoots = new Set<string>();
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
      importedAt.set(name, node.endIndex);
      imports.set(name, { ...item, module: !from && !imported.childForFieldName('alias') ? item.module.slice(0, 1) : item.module,
        names: from ? [nameOf(original)] : null });
      const moduleName = from ? nameOf(node.childForFieldName('module_name')) : null, importedName = nameOf(original);
      if (item.level === 0) {
        const module = item.module.map(normalize).join('.');
        for (const [namespaceName, exports] of [['viewsets', viewsetBases], ['routers', ['SimpleRouter', 'DefaultRouter']], ['decorators', ['action']]] as const) {
          const direct = from && module === 'rest_framework.' + namespaceName && (exports as readonly string[]).includes(importedName);
          const namespace = from && module === 'rest_framework' && importedName === namespaceName
            || !from && module === 'rest_framework.' + namespaceName;
          if (!direct && !namespace) continue;
          if (namespaceName === 'viewsets') drfRoots.add(name);
          const namespacePrefix = !from && !imported.childForFieldName('alias') ? 'rest_framework.' + namespaceName : name;
          for (const exported of direct ? [importedName] : exports) {
            const reference = direct ? name : namespacePrefix + '.' + exported;
            const symbol = { root: name, end: node.endIndex, name: exported };
            drfSymbols.set(reference, symbol);
            if (namespaceName === 'viewsets') drfBases.set(reference, symbol);
          }
        }
      }
      if (moduleName === 'django.urls' && ['path', 're_path', 'include'].includes(importedName)
        || moduleName === 'django.conf.urls' && ['url', 'include'].includes(importedName)
        || moduleName === 'django.conf.urls.static' && importedName === 'static') {
        django.set(name, importedName); djangoAt.set(name, node.endIndex);
      }
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
  const drfClasses = new Map<string, string>(), drfClassBases = new Map<string, string>(), baseReads = new Set<number>();
  for (const [name, node] of definitions) {
    if (node.type !== 'class_definition') continue;
    const bases = node.childForFieldName('superclasses')?.namedChildren.filter(child => child.type !== 'comment') ?? [];
    if (bases.length !== 1) continue;
    const base = drfBases.get(nameOf(bases[0]));
    if (!base || base.end > node.startIndex) continue;
    drfClasses.set(name, base.root);
    drfClassBases.set(name, base.name);
    let read = bases[0];
    while (read.type === 'attribute') read = read.childForFieldName('object')!;
    if (read.type === 'identifier') baseReads.add(read.id);
  }
  const aliases = new Map<string, { view: ViewRef; end: number; binding: number; read: number }>();
  for (const { node, type } of nodes) {
    if (type !== 'assignment' || node.parent?.type !== 'expression_statement' || node.parent.parent?.id !== root.id) continue;
    const left = node.childForFieldName('left'), ref = viewRefOf(node.childForFieldName('right'), nameOf);
    if (left?.type !== 'identifier' || !nameOf(left) || !ref?.asView || !ref.actions) continue;
    bind(left);
    if (room.views <= 0) { room.viewsCut = true; continue; }
    aliases.set(nameOf(left), { view: { ...ref, drfOnly: true }, end: node.endIndex, binding: left.id, read: receiverOf(node.childForFieldName('right')!)!.id });
    room.views--;
  }
  const basisOf = (call: Node): Route['basis'] => ({ text: firstLine(call), range: { fileId: file.id, fileHash: hash,
    startUtf16: call.startIndex, endUtf16: call.endIndex, ...lineRange(call), text: firstLine(call) } });
  const routerFacts = drfRoutersOf(root, nodes, drfSymbols, django, room, nameOf, bind, basisOf);

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
    // New registration helpers must retain their identity even when another function passes or changes them.
    if (['static', 'url'].includes(django.get(name) ?? '') && !label && !parameterPosition(node) && !bindings.get(name)?.has(node.id)) {
      const called = parent?.type === 'call' && parent.childForFieldName('function')?.id === node.id;
      if (!called && !typePosition(node)) invalid.add(name);
    }
    if ((drfRoots.has(name) || drfClasses.has(name)) && !label && !parameterPosition(node) && !bindings.get(name)?.has(node.id) && !typePosition(node)) {
      const asView = drfClasses.has(name) && parent?.type === 'attribute' && parent.childForFieldName('object')?.id === node.id
        && nameOf(parent.childForFieldName('attribute')) === 'as_view' && parent.parent?.type === 'call' && parent.parent.childForFieldName('function')?.id === parent.id;
      const registration = routerFacts.classReads.get(node.id);
      if (!baseReads.has(node.id) && !asView && !registration?.router.safe) invalid.add(name);
    }
    if (baseReads.has(node.id)) continue;
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
  for (const router of routerFacts.routers.values()) {
    if (invalid.has(router.name) || invalid.has(router.factory)
      || router.uses.some(use => use.helpers.some(name => invalid.has(name) || (djangoAt.get(name) ?? Infinity) > use.at))) router.safe = false;
  }
  for (const { router, name } of routerFacts.classReads.values()) if (!router.safe) invalid.add(name);
  result.routers = [...routerFacts.routers.values()];
  result.odd = result.plain && odd;
  result.rootUnclear = ['urlconf', 'SCRIPT_NAME', 'script_prefix'].some(word => text.includes(word))
    || mentions !== stated || conflicting || stated > 0 && (odd || lastStar > firstRoot);
  result.root = stated > 0 && !result.rootUnclear ? rootValue!.split('.') : null;
  result.listFinal = result.plain && !invalidList;
  result.init = result.plain && file.relativePath.split('/').at(-1) === '__init__.py' ? initFactsOf(root) : null;

  // 3. Read literal list entries and static-list additions assigned directly to module-level urlpatterns.
  const lists = new Set<number>(), staticCalls = new Set<number>(), aliasReads = new Set<number>(), viewsetReads = new Set<number>();
  for (const { node, type } of nodes) {
    if (type !== 'assignment' && type !== 'augmented_assignment' || node.parent?.parent?.id !== root.id) continue;
    if (nameOf(node.childForFieldName('left')) !== 'urlpatterns') continue;
    if (node.type === 'augmented_assignment' && node.childForFieldName('operator')?.text !== '+=') continue;
    const right = node.childForFieldName('right');
    const pending = right ? [right] : [];
    while (pending.length) {
      const value = pending.pop()!;
      if (value.type === 'list') { lists.add(value.id); continue; }
      if (value.type === 'call') { staticCalls.add(value.id); continue; }
      if (value.type !== 'binary_operator' || value.childForFieldName('operator')?.text !== '+') continue;
      pending.push(value.childForFieldName('right')!, value.childForFieldName('left')!);
    }
  }
  for (const { node: call, type } of lists.size || staticCalls.size ? nodes : []) {
    if (type !== 'call' || !lists.has(call.parent?.id ?? -1) && !staticCalls.has(call.id)) continue;
    if (room.entries <= 0) { room.entriesCut = true; break; }
    if (call.childForFieldName('function')?.type !== 'identifier') continue;
    const callee = nameOf(call.childForFieldName('function'));
    if (invalid.has(callee)) continue;
    if (['static', 'url'].includes(django.get(callee) ?? '') && call.startIndex < djangoAt.get(callee)!) continue;
    if (staticCalls.has(call.id)) {
      if (django.get(callee) !== 'static' || !result.plain || odd) continue;
      const addition = staticAddition(call, basisOf(call), nameOf);
      if (addition) { result.staticAdditions.push(addition); room.entries--; }
      continue;
    }
    if (!['path', 're_path', 'url'].includes(django.get(callee) ?? '')) continue;
    const args = argumentsOf(call), positions = args.filter(positional);
    if (django.get(callee) === 'url' && !registrationArgumentsValid(args, ['regex', 'view', 'kwargs', 'name'], false, nameOf)) continue;
    const keyword = (name: string) => args.find(arg => arg.type === 'keyword_argument' && nameOf(arg.childForFieldName('name')) === name)?.childForFieldName('value');
    const expression = positions[1] ?? keyword('view');
    const pathNode = positions[0] ?? keyword(django.get(callee) === 'url' ? 'regex' : 'route');
    const validRegistration = registrationArgumentsValid(args, [django.get(callee) === 'url' ? 'regex' : 'route', 'view', 'kwargs', 'name'], false, nameOf)
      && !!pathNode && !!expression;
    if (django.get(callee) === 'url' && (!pathNode || !expression)) continue;
    const written = pathNode ? plainString(pathNode) : null;
    const regex = django.get(callee) !== 'path';
    const spread = args.some(arg => arg.type === 'list_splat' || arg.type === 'dictionary_splat');
    const include = expression?.type === 'call' ? expression.childForFieldName('function') : null;
    if (include?.type === 'identifier' && django.get(nameOf(include)) === 'include' && !invalid.has(nameOf(include))) {
      room.entries--;
      const includeArgs = argumentsOf(expression!);
      const routerUrls = includeArgs[0];
      if (routerUrls?.type === 'attribute' && nameOf(routerUrls.childForFieldName('attribute')) === 'urls'
        && routerFacts.routers.has(nameOf(routerUrls.childForFieldName('object')))) continue;
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
    const view = viewRefOf(expression, nameOf);
    if (validRegistration && view && expression) {
      if (expression.type === 'identifier' && aliases.has(nameOf(expression))) aliasReads.add(expression.id);
      const receiver = receiverOf(expression);
      if (receiver) viewsetReads.add(receiver.id);
    }
    // `bounded` looks at the length first, so an overlong route is never split or matched.
    const path = written === null ? null : bounded(regex ? written : '/' + written);
    const shape = regex || spread ? { unmatched: true as const } : path === null ? {} : djangoShape(path);
    result.entries.push({ kind: regex ? 'regex' : 'path', path, ...(regex ? { displayPath: displayedRegex(pathNode) } : {}),
      written: regex || spread || written === null || written.length > ROUTE_LIMITS.pathLength ? null : written,
      shape, view, basis: basisOf(call), ...(!validRegistration ? { invalidRegistration: true as const } : {}) });
    room.entries--;
  }
  for (const { node, type } of nodes) {
    if (type !== 'identifier' || !aliases.has(nameOf(node)) || labelPosition(node) || parameterPosition(node) || typePosition(node)) continue;
    const alias = aliases.get(nameOf(node))!;
    if (node.id !== alias.binding && !aliasReads.has(node.id)) invalid.add(nameOf(node));
  }
  for (const [name, alias] of aliases) {
    if (invalid.has(name) || invalid.has(alias.view.local)) continue;
    result.viewAliases.set(name, { view: alias.view, end: alias.end });
    viewsetReads.add(alias.read);
  }
  for (const [read, { router }] of routerFacts.classReads) if (router.safe) viewsetReads.add(read);
  for (const read of routerFacts.factoryReads) viewsetReads.add(read);
  for (const { node, type } of nodes) {
    if (type !== 'decorator') continue;
    const expression = node.firstNamedChild;
    if (expression?.type !== 'call' || drfSymbols.get(nameOf(expression.childForFieldName('function')))?.name !== 'action') continue;
    const read = receiverOf(expression);
    if (read) viewsetReads.add(read.id);
  }
  // Imported classes and generated functions receive the same strict identity check as local ViewSets.
  // Keep this result separately: ordinary Django views retain their existing reading rules.
  for (const { node, type } of nodes) {
    if (type !== 'identifier') continue;
    const name = nameOf(node);
    if (!imports.has(name) && !definitions.has(name) && !aliases.has(name)) continue;
    if (bindings.get(name)?.has(node.id) || labelPosition(node) || parameterPosition(node) || typePosition(node) || baseReads.has(node.id)) continue;
    if (viewsetReads.has(node.id) && (importedAt.get(name) ?? -1) < node.startIndex) continue;
    result.viewsetInvalid.add(name);
  }
  for (const name of invalid) result.viewsetInvalid.add(name);
  result.drfFrameworkUnsafe = [...drfSymbols.values()].some(symbol => result.viewsetInvalid.has(symbol.root));
  const used = new Set([...result.entries, ...result.staticAdditions].map(entry => entry.view?.local));
  for (const alias of result.viewAliases.values()) used.add(alias.view.local);
  for (const router of result.routers) for (const registration of router.registrations) used.add(registration.view?.local);
  for (const [name, item] of imports) if (used.has(name) && !invalid.has(name)) result.imports.set(name, item);
  const mutationRoom = mutationRooms.get(room) ?? { left: 5_000 };
  mutationRooms.set(room, mutationRoom);
  for (const [name, item] of imports) {
    if (!result.viewsetInvalid.has(name)) continue;
    if (item.level === 0 && ['django', 'rest_framework'].includes(normalize(item.module[0] ?? ''))) continue;
    if (mutationRoom.left <= 0) { room.mutationsCut = true; result.drfMutationsCut = true; break; }
    result.drfMutationImports.set(name, item); mutationRoom.left--;
  }
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
      if (drfClasses.has(name)) {
        if (invalid.has(drfClasses.get(name)!) || node.parent?.type === 'decorated_definition') continue;
        const actions = new Map<string, CallTarget | null>();
        const extraActions: DrfAction[] = [];
        const statements = node.childForFieldName('body')?.namedChildren ?? [];
        let safe = true, routerSafe = true, lookupSafe = true, budget = 2_000;
        // Reserve each declared action against the same project budget as ordinary views.
        for (const statement of statements) {
          const definition = statement.type === 'decorated_definition' ? statement.childForFieldName('definition') : statement;
          if (definition?.type !== 'function_definition') continue;
          const action = nameOf(definition.childForFieldName('name'));
          if (!action || viewsetDispatch.has(action)) { safe = false; break; }
          if (!actions.has(action) && actions.size + 1 >= room.views) { room.viewsCut = true; safe = false; break; }
          if (action === 'get_extra_actions') routerSafe = false;
          if (lookupSettings.has(action)) lookupSafe = false;
          const extra = statement.type === 'decorated_definition' ? drfActionOf(statement, action, drfSymbols, result.viewsetInvalid, nameOf) : null;
          if (extra) extraActions.push(extra);
          if (statement.type === 'decorated_definition' && !extra || extra && standardActions.has(action)) routerSafe = false;
          actions.set(action, actions.has(action) || statement.type === 'decorated_definition' && !extra
            || action.startsWith('__') && !action.endsWith('__') ? null : target(definition));
        }
        // An assignment, deletion or control-flow block can replace a previously declared action.
        for (const statement of safe ? statements : []) {
          if (statement.type === 'function_definition' || statement.type === 'comment'
            || statement.type === 'decorated_definition' && statement.childForFieldName('definition')?.type === 'function_definition') continue;
          const pending = [statement];
          while (pending.length && safe) {
            if (--budget < 0) { safe = false; break; }
            const child = pending.pop()!;
            if (child.type === 'import_statement' || child.type === 'import_from_statement') {
              for (const imported of child.childrenForFieldName('name')) {
                const original = imported.type === 'aliased_import' ? imported.childForFieldName('name')! : imported;
                const bound = nameOf(imported.childForFieldName('alias') ?? original.firstNamedChild);
                if (viewsetDispatch.has(bound)) safe = false;
                if (lookupSettings.has(bound)) lookupSafe = false;
                if (bound === 'get_extra_actions') routerSafe = false;
                if (actions.has(bound)) actions.set(bound, null);
              }
            }
            if (child.type !== 'identifier') { pending.push(...child.namedChildren); continue; }
            if (labelPosition(child)) continue;
            const action = nameOf(child);
            if (viewsetDispatch.has(action)) { safe = false; break; }
            if (lookupSettings.has(action)) lookupSafe = false;
            if (action === 'get_extra_actions') routerSafe = false;
            if (actions.has(action)) actions.set(action, null);
          }
        }
        if (safe) {
          result.views.set(name, { kind: 'viewset', actions, definedAt: node.endIndex, base: drfClassBases.get(name)!, extraActions, routerSafe, lookupSafe });
          room.views -= actions.size + 1;
        }
        continue;
      }
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
  { routes: Route[]; unresolvedRoutes: UnresolvedRoute[]; skipped: number; cut: boolean; oddFiles: string[]; unfollowed: number; staticAdditions: number; staticUnresolved: number; drfDefaults: number } {
  const routes: Route[] = [];
  const unresolvedRoutes: UnresolvedRoute[] = [];
  const oddFiles = new Set<string>();
  let skipped = 0, cut = false, unfollowed = 0, staticAdditions = 0, staticUnresolved = 0;
  const facts = { init: (path: string) => files.get(path)?.init ?? null, plain: (path: string) => files.get(path)?.plain ?? false };
  const ordered = [...files].sort(([a], [b]) => a.localeCompare(b));
  const blockedDrfFiles = new Set<string>(), blockedDrfFolders = new Set<string>(), blockedDrfNames = new Map<string, Set<string>>();
  const mutationsCut = ordered.some(([, file]) => file.drfMutationsCut);
  for (const [path, file] of ordered) for (const item of file.drfMutationImports.values()) {
    if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
    for (const target of resolvePythonImport(path, item, known, facts)) {
      if (target.kind === 'external') continue;
      const targets = target.kind === 'file' ? [target.relativePath] : target.candidates;
      for (const affected of targets) {
        if (posix.basename(affected) === '__init__.py') { blockedDrfFolders.add(posix.dirname(affected)); continue; }
        if (target.kind !== 'file' || target.names === 'all') { blockedDrfFiles.add(affected); continue; }
        const names = blockedDrfNames.get(affected) ?? new Set<string>();
        target.names.forEach(name => names.add(normalize(name)));
        blockedDrfNames.set(affected, names);
      }
    }
  }
  const blockedDrf = (path: string, name: string) => {
    if (mutationsCut || blockedDrfFiles.has(path) || blockedDrfNames.get(path)?.has(name)) return true;
    let folder = posix.dirname(path);
    while (true) {
      if (blockedDrfFolders.has(folder)) return true;
      if (folder === '.') return false;
      folder = posix.dirname(folder);
    }
  };
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
    drf: boolean; handlers: { method: Route['method']; handler: CallTarget }[] }[] = [];
  const drfShadow = ordered.some(([, file]) => file.drfFrameworkUnsafe) || [...known].some(path => {
    const parts = path.normalize('NFKC').toLowerCase().split('/');
    const index = parts.at(-1) === 'rest_framework.py' ? parts.length - 1
      : parts.at(-1) === '__init__.py' && parts.at(-2) === 'rest_framework' ? parts.length - 2 : -1;
    return index >= 0 && !parts.slice(0, index).some(part => part === 'site-packages' || part === 'dist-packages');
  });
  const location = (path: string, ref: ViewRef): { path: string; name: string } | null => {
    if (ref.attribute === null && (files.get(path)?.views.has(ref.local) || files.get(path)?.viewAliases.has(ref.local))) return { path, name: ref.local };
    const imported = resolved.get(path)?.get(ref.local);
    if (!imported) return null;
    const name = ref.attribute === null ? imported.name : imported.name === null ? ref.attribute : null;
    return name === null ? null : { path: imported.path, name };
  };
  const unresolved = (filePath: string, file: DjangoFile, entry: DjangoEntry, reason: UnresolvedRoute['reason'], addition: DjangoStaticAddition | null) => {
    const collected = entry.kind === 'path' ? prefixes.get(filePath) ?? [bare(filePath, file)] : [bare(filePath, file)];
    for (const prefix of collected) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      if (unresolvedRoutes.length >= ROUTE_LIMITS.unresolvedRoutes) { cut = true; return; }
      const path = addition ? addition.prefix : entry.kind === 'regex' ? entry.displayPath ?? null
        : entry.written === null ? entry.path : bounded('/' + prefix.written + entry.written);
      unresolvedRoutes.push({ framework: 'django', kind: entry.kind, path,
        prefix: !entry.router && entry.kind === 'path' && prefix.known && entry.written !== null ? 'known' : 'unknown',
        reason: addition && !addition.defaultView ? 'unresolved-handler' : reason, basis: entry.basis,
        ...(addition ? { conditional: true as const } : {}) });
    }
  };
  const defaultRouters = new Set<DrfRouter>();
  let routerRoom = 5_000 - ordered.reduce((count, [, file]) => count + file.entries.length + file.includes.length + file.staticAdditions.length
    + file.routers.reduce((count, router) => count + 1 + router.registrations.length + router.uses.length, 0), 0);
  let routerWork = 200_000;
  const lastRegistrations = new Map<DrfRouter, number>();
  for (const [, file] of ordered) for (const router of file.routers) {
    const last = Math.max(router.end, ...router.registrations.map(registration => registration.end));
    lastRegistrations.set(router, last);
    if (file.plain && router.safe && router.kind === 'DefaultRouter' && router.uses.some(use => use.at > last)) defaultRouters.add(router);
  }
  function* routerEntries(path: string, file: DjangoFile, router: DrfRouter, registration: DrfRegistration): Generator<DjangoEntry> {
    for (const use of router.uses) {
      if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
      if (--routerWork < 0) { cut = true; return; }
      if (routerRoom <= 0) { cut = true; return; }
      if (use.at <= lastRegistrations.get(router)!) continue;
      const ref = registration.view, found = ref && location(path, ref), view = found && files.get(found.path)?.views.get(found.name);
      const safePath = registration.prefix !== null && (router.regex ? /^[\p{L}\p{N}_~/-]*$/u : /^[\p{L}\p{N}._~/-]*$/u).test(registration.prefix);
      const safe = file.plain && router.safe && !blockedDrf(path, router.name) && registration.valid && registration.basename !== null && use.prefix !== null && safePath && !drfShadow
        && ref && found && view?.kind === 'viewset' && view.routerSafe && view.lookupSafe
        && !file.viewsetInvalid.has(ref.local) && !files.get(found.path)!.viewsetInvalid.has(found.name) && !blockedDrf(found.path, found.name)
        && (found.path !== path || view.definedAt < registration.basis.range.startUtf16);
      if (!safe || !view || view.kind !== 'viewset' || !ref) {
        if (--routerRoom < 0) { cut = true; return; }
        yield { kind: 'path', path: null, written: null, shape: {}, view: null, basis: registration.basis, router: true, unresolved: true };
        continue;
      }
      const inherited = (action: string) => view.base === 'ModelViewSet' || view.base === 'ReadOnlyModelViewSet' && ['list', 'retrieve'].includes(action);
      const list = [{ method: 'GET' as const, action: 'list' }, { method: 'POST' as const, action: 'create' }];
      const detail = [{ method: 'GET' as const, action: 'retrieve' }, { method: 'PUT' as const, action: 'update' },
        { method: 'PATCH' as const, action: 'partial_update' }, { method: 'DELETE' as const, action: 'destroy' }];
      const groups = [
        { detail: false, urlPath: '', mapping: list.filter(item => view.actions.has(item.action) || inherited(item.action)) },
        ...view.extraActions.filter(action => !action.detail).map(action => ({ ...action, mapping: action.methods.map(method => ({ method, action: action.action })) })),
        { detail: true, urlPath: '', mapping: detail.filter(item => view.actions.has(item.action) || inherited(item.action)) },
        ...view.extraActions.filter(action => action.detail).map(action => ({ ...action, mapping: action.methods.map(method => ({ method, action: action.action })) })),
      ];
      for (const group of groups) {
        if (--routerWork < 0) { cut = true; return; }
        if (!group.mapping.length) continue;
        const safeActionPath = group.urlPath !== null && (router.regex ? /^[\p{L}\p{N}_~/-]*$/u : /^[\p{L}\p{N}._~/-]*$/u).test(group.urlPath);
        let written: string | null = null;
        if (safeActionPath) {
          let fragment = registration.prefix! + (group.detail ? '/<pk>' : '') + (group.urlPath ? '/' + group.urlPath : '') + (router.trailingSlash ? '/' : '');
          if (!registration.prefix && fragment.startsWith('/')) fragment = fragment.slice(1);
          written = bounded(use.prefix! + fragment);
        }
        const path = written === null ? null : bounded('/' + written);
        const shape = path === null ? { unmatched: true as const } : { ...djangoShape(path), ...(group.detail && router.regex ? { typed: true as const } : {}) };
        const mappingSafe = originalActions(group.mapping);
        for (const action of group.mapping) {
          if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
          if (--routerRoom < 0 || --routerWork < 0) { cut = true; return; }
          yield { kind: 'path', path, written, shape, basis: registration.basis, router: true,
            view: { ...ref, asView: true, drfOnly: true, actions: [action], at: registration.basis.range.startUtf16 },
            ...(!mappingSafe ? { unresolved: true as const } : {}) };
        }
      }
    }
  }
  function* entriesOf() {
    for (const [path, file] of ordered) {
      const entries: { path: string; file: DjangoFile; entry: DjangoEntry; static: DjangoStaticAddition | null }[] = file.entries.map(entry => ({ path, file, entry, static: null }));
      for (const addition of file.staticAdditions) {
        if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
        staticAdditions++; staticUnresolved++;
        const entry: DjangoEntry = { kind: 'static', path: null, written: null, shape: { unmatched: true }, view: addition.view, basis: addition.basis };
        entries.push({ path, file, static: addition, entry });
      }
      const sources = [...entries.map(entry => ({ at: entry.entry.basis.range.startUtf16, entry, registration: null as DrfRegistration | null, router: null as DrfRouter | null })),
        ...file.routers.flatMap(router => router.registrations.map(registration => ({ at: registration.basis.range.startUtf16, entry: null, registration, router })))];
      sources.sort((a, b) => a.at - b.at);
      for (const source of sources) {
        if (source.entry) { yield source.entry; continue; }
        for (const entry of routerEntries(path, file, source.router!, source.registration!)) yield { path, file, entry, static: null };
      }
    }
  }
  for (const { path, file, entry, static: staticEntry } of entriesOf()) {
    if (shouldStop()) throw new AppError('CANCELLED', '주소 찾기를 취소했어요.');
    if (staticEntry?.defaultView) { unresolved(path, file, entry, 'static-handler', staticEntry); continue; }
    if (entry.unresolved) { unresolved(path, file, entry, 'unsupported-view', null); continue; }
    let ref = entry.view;
    // A urlconf that is not plain has no views of its own and no resolved imports, so its entries fall out below.
    if (!ref) {
      skipped += Number(!staticEntry); unresolved(path, file, entry, 'unreadable-view', staticEntry); continue;
    }
    let found = location(path, ref), refPath = path, unsafeViewset = file.viewsetInvalid.has(ref.local);
    if (found) unsafeViewset ||= files.get(found.path)!.viewsetInvalid.has(found.name) || blockedDrf(found.path, found.name);
    const alias = found && files.get(found.path)?.viewAliases.get(found.name);
    if (alias && !ref.asView && (found!.path !== path || alias.end < entry.basis.range.startUtf16)) {
      refPath = found!.path;
      ref = alias.view;
      unsafeViewset ||= files.get(refPath)!.viewsetInvalid.has(ref.local);
      found = location(refPath, ref);
      if (found) unsafeViewset ||= files.get(found.path)!.viewsetInvalid.has(found.name) || blockedDrf(found.path, found.name);
    }
    const viewPath = found?.path ?? path, view = found && files.get(found.path)?.views.get(found.name);
    if (!view) {
      skipped += Number(!staticEntry); unresolved(path, file, entry, 'unresolved-handler', staticEntry); continue;
    }
    const drf = view.kind === 'viewset';
    const drfHandlers = drf && ref.asView && ref.actions && originalActions(ref.actions) && !drfShadow && !unsafeViewset && !entry.invalidRegistration
      && !!found && !blockedDrf(found.path, found.name)
      && (viewPath !== refPath || ref.at !== undefined && view.definedAt < ref.at)
      ? ref.actions.map(({ method, action }) => ({ method, handler: view.actions.get(action) })) : null;
    if (drf ? !drfHandlers?.length || drfHandlers.some(item => !item.handler)
      : ref.drfOnly || ref.asView !== (view.kind === 'class') || view.kind === 'class' && !view.methods.length) {
      skipped += Number(!staticEntry); unresolved(path, file, entry, 'unsupported-view', staticEntry); continue;
    }
    const handlers = view.kind === 'viewset' ? drfHandlers!.map(item => ({ method: item.method, handler: item.handler! }))
      : view.kind === 'function' ? view.methods.map(method => ({ method, handler: view.handler })) : view.methods;
    if (!handlers.length) continue;
    if (staticEntry) staticUnresolved--;
    prepared.push({ path, file, entry, viewPath, handlers, drf });
  }
  // Every prepared combination produces a route. Stop the entire product at the first extra route.
  build: for (const { path, file, entry, viewPath, handlers, drf } of prepared) {
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
      const shape = entry.written === null || !prefix.written ? entry.shape : joined === null ? {} : { ...djangoShape(joined), ...(entry.router && entry.shape.typed ? { typed: true as const } : {}) };
      // A bracket left open in the entry needs its other half in a prefix fragment, which is then incomplete too.
      routes.push({ framework: 'django', prefix: !drf && prefix.known && entry.written !== null ? 'known' : 'unknown', method, handler, path: joined, basis: entry.basis,
        ...(odd || prefix.incomplete ? { unmatched: true as const } : shape) });
    }
  }
  return { routes, unresolvedRoutes, skipped, cut, oddFiles: [...oddFiles], unfollowed, staticAdditions, staticUnresolved, drfDefaults: defaultRouters.size };
}
