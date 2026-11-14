import type Parser from 'tree-sitter';
import type { ProjectFile, Route } from '../../shared/contracts';
import { comments, types } from './java-syntax';
import { firstLine, lineRange } from './names';
import { bounded, shortName } from './routes';
import { parse } from './syntax';

type Node = Parser.SyntaxNode;
type Mapping = { paths: string[] | null; methods: Route['method'][] | null; restricted: boolean };
const web = 'org.springframework.web.bind.annotation';
const packages: Record<string, string> = {
  RestController: web, Controller: 'org.springframework.stereotype', RequestMapping: web, RequestMethod: web,
  GetMapping: web, PostMapping: web, PutMapping: web, PatchMapping: web, DeleteMapping: web,
};
const methodMappings: Record<string, Route['method']> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
};
const codeChildren = (node: Node | null | undefined) => node?.namedChildren.filter(child => !comments.has(child.type)) ?? [];
/** An annotation element's values: `{ a, b }` gives each item, a single value gives itself. */
const valuesOf = (node: Node | null | undefined) =>
  node?.type === 'element_value_array_initializer' ? codeChildren(node) : node ? [node] : [];
const annotations = (node: Node) => codeChildren(node.namedChildren.find(child => child.type === 'modifiers'))
  .filter(child => child.type === 'annotation' || child.type === 'marker_annotation');

function pathShape(path: string): Pick<Route, 'segments' | 'typed' | 'unmatched'> {
  const segments: NonNullable<Route['segments']> = [];
  let typed = false;
  for (const part of path.split('/').filter(Boolean)) {
    // Regex braces belong to the parameter constraint; never run the supplied regex.
    const parameter = part.match(/^\{([^{}:*]+)(?::(.+))?\}$/);
    if (parameter) {
      segments.push({ param: parameter[1] });
      typed ||= parameter[2] !== undefined;
      continue;
    }
    if (/[{}*]/.test(part)) return { unmatched: true };
    segments.push({ text: part });
  }
  return { segments, ...(typed ? { typed: true } : {}) };
}

/** Direct Spring MVC mappings only. Import and type names are checked before any route is emitted. */
export function springRoutes(file: ProjectFile, text: string, hash: string, maxNodes: number, maxRoutes: number,
  shadowedNames: ReadonlySet<string>): { routes: Route[]; complete: boolean; cut: boolean; skipped: number; shadowed: boolean } {
  const routes: Route[] = [];
  // Most Java files (entities, services) hold no controller: both annotations contain this word, so skip the parse.
  if (!text.includes('Controller')) return { routes, complete: true, cut: false, skipped: 0, shadowed: false };
  const root = parse(text, file.relativePath);
  if (!root) return { routes, complete: false, cut: false, skipped: 0, shadowed: false };
  const singles = new Map<string, Set<string>>();
  const stars = new Set<string>();
  const declared = new Set<string>();
  const classes: Node[] = [];
  const methods: Node[] = [];
  const imports: Node[] = [];
  const cursor = root.walk();
  let visited = 0;
  // Visit the whole file first: a later nested declaration can shadow an earlier annotation.
  // The node object is built only for the kinds kept; the type comes from the cursor.
  walk: while (true) {
    if (++visited > maxNodes) return { routes, complete: false, cut: false, skipped: 0, shadowed: false };
    const type = cursor.nodeType;
    if (types.has(type)) declared.add(cursor.currentNode.childForFieldName('name')?.text ?? '');
    if (type === 'class_declaration') classes.push(cursor.currentNode);
    if (type === 'method_declaration') methods.push(cursor.currentNode);
    if (type === 'import_declaration') imports.push(cursor.currentNode);
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) break walk;
    }
  }
  for (const node of imports) {
    if (node.hasError || node.children.some(child => child.type === 'static')) continue;
    const imported = codeChildren(node)[0]?.text.replace(/\s/g, '');
    if (!imported) continue;
    if (node.namedChildren.some(child => child.type === 'asterisk')) { stars.add(imported); continue; }
    const name = imported.split('.').at(-1)!;
    const sources = singles.get(name) ?? new Set<string>();
    sources.add(imported); singles.set(name, sources);
  }
  let shadowed = false;
  const springName = (written: string): string | null => {
    const name = written.split('.').at(-1)!;
    const pkg = packages[name];
    if (!pkg) return null;
    if (written.includes('.')) return written === `${pkg}.${name}` ? name : null;
    if (shadowedNames.has(name) || declared.has(name)) { shadowed = true; return null; }
    const imports = singles.get(name);
    if (imports) return imports.size === 1 && imports.has(`${pkg}.${name}`) ? name : null;
    return stars.has(pkg) ? name : null;
  };
  const springAnnotations = (node: Node) => annotations(node)
    .map(annotation => ({ annotation, name: springName(annotation.childForFieldName('name')?.text.replace(/\s/g, '') ?? '') }));
  const mappingOf = (annotation: Node | undefined, name = 'RequestMapping'): Mapping => {
    const args = codeChildren(annotation?.childForFieldName('arguments'));
    const pathArgs = args.filter(arg => arg.type !== 'element_value_pair' || ['value', 'path'].includes(arg.childForFieldName('key')?.text ?? ''));
    const pathValue = pathArgs[0]?.type === 'element_value_pair' ? pathArgs[0].childForFieldName('value') : pathArgs[0];
    let paths: string[] | null = [];
    for (const value of valuesOf(pathValue)) {
      const raw = value.text.slice(1, -1);
      // Only `\\` is read, as regex constraints like {id:\\d+} use it; other escapes and text blocks are rare in paths
      // and are left unread rather than decoded by Java string rules here.
      if (value.type !== 'string_literal' || value.text.startsWith('"""') || raw.replace(/\\\\/g, '').includes('\\')) { paths = null; break; }
      paths.push(raw.replace(/\\\\/g, '\\'));
    }
    if (pathArgs.length > 1) paths = null;
    if (paths?.length === 0) paths.push('');
    if (name !== 'RequestMapping') return { paths, methods: [methodMappings[name]], restricted: true };
    const methodArg = args.find(arg => arg.type === 'element_value_pair' && arg.childForFieldName('key')?.text === 'method');
    const values = valuesOf(methodArg?.childForFieldName('value'));
    const selected: Route['method'][] = [];
    for (const value of values) {
      const owner = value.childForFieldName('object')?.text.replace(/\s/g, '');
      const method = value.childForFieldName('field')?.text;
      if (value.type !== 'field_access' || !owner || springName(owner) !== 'RequestMethod'
        || !method || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'].includes(method)) {
        return { paths, methods: null, restricted: true };
      }
      if (!['HEAD', 'OPTIONS', 'TRACE'].includes(method)) selected.push(method as Route['method']);
    }
    return { paths, methods: selected, restricted: values.length > 0 };
  };
  const controllers = new Map<number, { name: string; mapping: Mapping }>();
  for (const node of classes) {
    const modifiers = node.namedChildren.find(child => child.type === 'modifiers');
    if (modifiers?.hasError || modifiers?.children.some(child => child.type === 'abstract')) continue;
    const named = springAnnotations(node);
    if (!named.some(item => item.name === 'RestController' || item.name === 'Controller')) continue;
    controllers.set(node.id, { name: node.childForFieldName('name')!.text,
      mapping: mappingOf(named.find(item => item.name === 'RequestMapping')?.annotation) });
  }
  if (!controllers.size) return { routes, complete: !root.hasError, cut: false, skipped: 0, shadowed };

  let cut = false;
  let skipped = 0;
  for (const node of methods) {
    if (cut) break;
    if (node.hasError || !node.childForFieldName('body') || node.parent?.type !== 'class_body') continue;
    const owner = controllers.get(node.parent.parent!.id);
    if (!owner) continue;
    const mappings = springAnnotations(node)
      .filter(item => item.name === 'RequestMapping' || item.name !== null && Object.hasOwn(methodMappings, item.name));
    if (!mappings.length) continue;
    if (routes.length >= maxRoutes) { cut = true; break; }
    const { annotation, name } = mappings[0];
    const own = mappingOf(annotation, name!);
    const base = owner.mapping;
    // Spring uses only one of several mappings on a method; which one is not reproduced, so such a method is unread.
    const unknownMethod = mappings.length > 1 || own.methods === null || base.methods === null;
    const selected = unknownMethod ? ['ALL' as const] : [...new Set([...base.methods!, ...own.methods!])];
    if (!unknownMethod && !base.restricted && !own.restricted) selected.push('ALL');
    if (!selected.length) continue;
    const basisText = firstLine(annotation);
    const route = {
      prefix: 'unknown' as const, framework: 'spring' as const,
      handler: { fileId: file.id, fileHash: hash, startUtf16: node.startIndex, endUtf16: node.endIndex,
        startLine: node.startPosition.row + 1, name: shortName(`${owner.name}.${node.childForFieldName('name')!.text}`) },
      basis: { text: basisText, range: { fileId: file.id, fileHash: hash, startUtf16: annotation.startIndex,
        endUtf16: annotation.endIndex, ...lineRange(annotation), text: basisText } },
    };
    const add = (method: Route['method'], path: string | null) => {
      if (routes.length >= maxRoutes) { cut = true; return; }
      routes.push({ ...route, method, path, ...(path === null ? { unmatched: true } : pathShape(path)) });
    };

    if (unknownMethod || own.paths === null || base.paths === null) {
      skipped++;
      for (const method of selected) add(method, null);
      continue;
    }
    let unreadable = false;
    for (const prefix of base.paths) {
      for (const suffix of own.paths) {
        const path = bounded('/' + [prefix, suffix].flatMap(part => part.split('/').filter(Boolean)).join('/'));
        unreadable ||= path === null;
        for (const method of selected) add(method, path);
      }
    }
    if (unreadable) skipped++;
  }
  return { routes, complete: !root.hasError, cut, skipped, shadowed };
}
