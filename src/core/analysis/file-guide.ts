import type Parser from 'tree-sitter';
import type { Analysis, FileGuide, GuideFunction, GuideImport, GuideRange, ProjectFile } from '../../shared/contracts';
import { splitFileChunks } from './file-chunks';
import { candidatesFor, isRelative, MAP_LIMITS, parse } from './project-map';
import { readFacts } from './names';
import { serverFacts } from './feature-flow';
import { functionTypes, importOf } from './syntax';
import { formatNextPath, nextRouteOf } from './next-routes';

type Node = Parser.SyntaxNode;
const classTypes = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const fieldTypes = new Set(['public_field_definition', 'field_definition']);
// One line: parameters and decorators often span several.
const clip = (raw: string) => { const text = raw.replace(/\s+/g, ' ').trim(); return text.length > 60 ? `${text.slice(0, 60)}…` : text; };
const quoted = (text: string) => `\`${clip(text)}\``;
const declaration = (node: Node) => node.type === 'export_statement'
  ? node.childForFieldName('declaration') ?? node.childForFieldName('value') ?? node : node;

function descendants(node: Node, ownBody = false): Node[] {
  const result: Node[] = [];
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (ownBody && (functionTypes.has(current.type) || classTypes.has(current.type))) continue;
    result.push(current);
    pending.push(...current.namedChildren.toReversed());
  }
  return result;
}
function decorators(node: Node): Node[] {
  const found = node.namedChildren.filter(child => child.type === 'decorator');
  if (classTypes.has(node.type) && node.parent?.type === 'export_statement') {
    found.unshift(...node.parent.namedChildren.filter(child => child.type === 'decorator'));
  }
  if (node.parent?.type === 'class_body') {
    let previous = node.previousNamedSibling;
    while (previous && ['decorator', 'comment'].includes(previous.type)) {
      if (previous.type === 'decorator') found.unshift(previous);
      previous = previous.previousNamedSibling;
    }
  }
  return found;
}
const decoratorName = (node: Node) => {
  const value = node.namedChildren[0];
  return (value?.type === 'call_expression' ? value.childForFieldName('function') : value)?.text;
};
function decoratorPath(node: Node): string | null {
  const args = node.namedChildren[0]?.childForFieldName('arguments')?.namedChildren.filter(child => child.type !== 'comment') ?? [];
  if (!args.length) return '';
  return args[0].type === 'string' && !args[0].text.includes('\\') ? args[0].text.slice(1, -1) : null;
}
function returnsJsx(fn: Node): boolean {
  const body = fn.childForFieldName('body');
  if (!body) return false;
  const expressions = body.type === 'statement_block'
    ? descendants(body, true).filter(node => node.type === 'return_statement') : [body];
  return expressions.some(node => descendants(node, true).some(child => child.type.startsWith('jsx_')));
}
/** What a function's own code shows: Nest route paths (null when a path is not plain text), the calls in its body and JSX in a return. */
function shapeOf(fn: Node) {
  const member = fieldTypes.has(fn.parent?.type ?? '') ? fn.parent! : fn;
  const owner = member.parent?.type === 'class_body' ? member.parent.parent : null;
  const prefix = owner && decorators(owner).find(node => decoratorName(node) === 'Controller');
  const routes = decorators(member).filter(node => /^(Get|Post|Put|Patch|Delete|All)$/.test(decoratorName(node) ?? '')).map(decorator => {
    const before = prefix ? decoratorPath(prefix) : '';
    const after = decoratorPath(decorator);
    return before === null || after === null ? null
      : `${decoratorName(decorator)!.toUpperCase()} /${[before, after].map(path => path.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  });
  const body = fn.childForFieldName('body');
  const calls = body ? descendants(body, true).filter(node => node.type === 'call_expression').map(node => node.childForFieldName('function')?.text ?? '?') : [];
  return { routes, calls, hooks: [...new Set(calls.filter(name => /(?:^|\.)use[A-Z]/.test(name)))], jsx: returnsJsx(fn) };
}

export function describeFile(text: string, relativePath: string, fileId: string, fileHash: string,
  analysis: Analysis, projectFiles: ProjectFile[]): FileGuide {
  const root = parse(text, relativePath);
  const split = splitFileChunks(text, relativePath, fileId, fileHash, root);
  const top = root.namedChildren.filter(node => !['comment', 'hash_bang_line', 'empty_statement'].includes(node.type));
  // Only the node types the guide needs: walking every node of a large file from JavaScript is slow.
  // `class` is also the keyword token's type, so only named nodes count.
  const classes = root.descendantsOfType([...classTypes]).filter(node => node.isNamed);
  const functions = root.descendantsOfType([...functionTypes]);
  const rangeOf = (node: Node): GuideRange => ({ fileId, fileHash, startUtf16: node.startIndex, endUtf16: node.endIndex,
    startLine: node.startPosition.row + 1, endLine: node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1) });
  const role = (label: string, about: string, basis: Node | string): FileGuide['role'] => ({ label, about,
    basis: { text: typeof basis === 'string' ? clip(basis) : clip(basis.text), range: typeof basis === 'string' ? null : rangeOf(basis) } });
  const classDecorator = (name: string) => classes.flatMap(decorators).find(node => decoratorName(node) === name);
  const exportedNames: string[] = [];
  const exportedFunctions: { name: string; fn: Node; isDefault?: boolean }[] = [];
  const bindings = new Map<string, Node>();
  for (const outer of top) {
    const node = declaration(outer);
    if (functionTypes.has(node.type)) {
      const name = node.childForFieldName('name')?.text;
      if (name) bindings.set(name, node);
    }
    for (const binding of node.namedChildren.filter(child => child.type === 'variable_declarator')) {
      const name = binding.childForFieldName('name');
      const value = binding.childForFieldName('value');
      if (name?.type === 'identifier' && value && functionTypes.has(value.type)) bindings.set(name.text, value);
    }
  }
  for (const outer of top.filter(node => node.type === 'export_statement')) {
    const node = declaration(outer);
    const isDefault = outer.children.some(child => child.type === 'default');
    if (isDefault) {
      exportedNames.push('default');
      const fn = functionTypes.has(node.type) ? node : bindings.get(node.text);
      if (fn) exportedFunctions.push({ name: fn.childForFieldName('name')?.text ?? node.text, fn, isDefault: true });
      continue;
    }
    const name = node.childForFieldName('name');
    if (name) {
      exportedNames.push(name.text);
      if (functionTypes.has(node.type)) exportedFunctions.push({ name: name.text, fn: node });
    }
    for (const binding of node.namedChildren.filter(child => child.type === 'variable_declarator')) {
      const pattern = binding.childForFieldName('name');
      if (!pattern) continue;
      const patterns: (Node | null)[] = [pattern];
      while (patterns.length) {
        const part = patterns.pop();
        if (!part) continue;
        switch (part.type) {
          case 'identifier': case 'shorthand_property_identifier_pattern': {
            exportedNames.push(part.text);
            const fn = bindings.get(part.text);
            if (fn) exportedFunctions.push({ name: part.text, fn });
            break;
          }
          case 'pair_pattern': patterns.push(part.childForFieldName('value')); break;
          case 'assignment_pattern': case 'object_assignment_pattern': patterns.push(part.childForFieldName('left')); break;
          case 'rest_pattern': case 'object_pattern': case 'array_pattern': patterns.push(...part.namedChildren.toReversed()); break;
        }
      }
    }
    const clause = outer.namedChildren.find(child => child.type === 'export_clause');
    for (const specifier of clause?.namedChildren.filter(child => child.type === 'export_specifier') ?? []) {
      const original = specifier.childForFieldName('name');
      const name = specifier.childForFieldName('alias') ?? original;
      if (!name) continue;
      exportedNames.push(name.text);
      const fn = !outer.childForFieldName('source') && original ? bindings.get(original.text) : null;
      if (fn) exportedFunctions.push({ name: name.text, fn, isDefault: name.text === 'default' });
    }
    const namespace = outer.namedChildren.find(child => child.type === 'namespace_export');
    if (namespace) exportedNames.push(namespace.namedChildren.at(-1)?.text ?? '*');
    else if (outer.children.some(child => child.type === '*')) exportedNames.push('*');
  }
  const start = root.descendantsOfType('call_expression').find(node => node.childForFieldName('function')?.text === 'NestFactory.create');
  const controller = classDecorator('Controller');
  const module = classDecorator('Module');
  const gateway = classDecorator('WebSocketGateway');
  const guard = classes.find(node => decorators(node).some(d => decoratorName(d) === 'Injectable') &&
    node.childForFieldName('body')?.namedChildren.some(member => member.type === 'method_definition' && member.childForFieldName('name')?.text === 'canActivate'));
  const injectable = classDecorator('Injectable');
  const validator = root.descendantsOfType([...fieldTypes]).flatMap(decorators)
    .find(node => /^(?:Is.+|Min|Max|Length)$/.test(decoratorName(node) ?? ''));
  const next = nextRouteOf(relativePath, projectFiles.map(file => file.relativePath));
  let fileRole: FileGuide['role'];
  if (/(?:^|\/)(?:__tests__|e2e)\/|\.(?:test|spec)\./.test(relativePath)) fileRole = role('시험 파일', '다른 코드가 맞게 동작하는지 확인하는 시험이에요.', relativePath);
  else if (start) fileRole = role('NestJS 서버 시작 파일', '서버를 만들고 켜는 곳이에요.', start);
  else if (controller) fileRole = role('NestJS 컨트롤러', '정해진 주소로 오는 요청을 받아 처리할 곳에 넘겨요.', controller);
  else if (module) fileRole = role('NestJS 모듈', '컨트롤러·서비스 같은 부품을 한 묶음으로 등록해요.', module);
  else if (gateway) fileRole = role('NestJS 웹소켓 게이트웨이', '실시간 연결로 오가는 메시지를 받아요.', gateway);
  else if (guard) fileRole = role('NestJS 가드', '요청을 들여보낼지 막을지 정해요.', guard.childForFieldName('body')!.namedChildren.find(member => member.childForFieldName('name')?.text === 'canActivate')!);
  else if (injectable) fileRole = role('NestJS 서비스', '컨트롤러가 맡기는 실제 일(데이터 읽기·쓰기 등)을 해요.', injectable);
  else if (/(?:^|\/)dto\/|\.dto\./.test(relativePath) || validator) fileRole = role('데이터 모양 (DTO)', '요청이나 응답에 담기는 데이터의 모양과 검사 규칙이에요.', validator ?? relativePath);
  else if (next) fileRole = role(next.kind === 'page' ? 'Next 화면' : next.kind === 'layout' ? 'Next 공통 틀' : 'Next API 라우트',
    next.kind === 'page' ? `주소 ${quoted(formatNextPath(next.segments))} (next.config의 basePath는 보지 않았어요)로 들어오면 보이는 화면이에요.`
      : next.kind === 'layout' ? '아래 화면들을 감싸는 공통 틀이에요.' : '주소로 오는 요청을 받아 답해요.', relativePath);
  else if (exportedFunctions.length && exportedFunctions.every(item => /^use[A-Z]/.test(item.name))) fileRole = role('React 훅 모음', '화면에서 쓰는 데이터 읽기·상태 같은 기능을 모아 둔 곳이에요.', exportedFunctions[0].fn);
  else if (/\.[tj]sx$/.test(relativePath) && exportedFunctions.some(item => returnsJsx(item.fn))) fileRole = role('React 컴포넌트', '화면 조각을 그려요.', exportedFunctions.find(item => returnsJsx(item.fn))!.fn);
  else if (top.length && top.every(node => ['type_alias_declaration', 'interface_declaration'].includes(declaration(node).type))) fileRole = role('타입 정의', '데이터 모양의 이름만 정해 둔 곳이에요.', top[0]);
  else if (top.length && top.every(node => node.type === 'export_statement' && node.childForFieldName('source'))) fileRole = role('모아 내보내기', '다른 파일의 것을 한곳에서 내보내요.', top[0]);
  else if (/\.config\./.test(relativePath.split('/').at(-1)!)) fileRole = role('설정 파일', '도구의 설정이에요.', relativePath);
  else fileRole = role('일반 코드', `함수 ${functions.length}개·클래스 ${classes.length}개가 있어요.`, top[0] ?? relativePath);
  const notes: string[] = [];
  const directive = top[0]?.type === 'expression_statement' ? top[0].namedChildren[0] : null;
  if (directive?.type === 'string') {
    if (directive.text.slice(1, -1) === 'use client') notes.push('브라우저에서 도는 화면 코드예요.');
    if (directive.text.slice(1, -1) === 'use server') notes.push('서버에서 도는 코드예요.');
  }
  // Climbing from one leaf keeps each chunk's lookup to its own ancestors; filtering every node per chunk took seconds on large files.
  const climb = (index: number, accept: (node: Node) => boolean) => {
    for (let node: Node | null = root.descendantForIndex(index); node; node = node.parent) if (accept(node)) return node;
    return null;
  };
  // Function chunks and analyzer symbols mostly share ranges, so each function's shape is worked out once.
  const shapes = new Map<string, ReturnType<typeof shapeOf>>();
  const shapeAt = (fn: Node) => {
    const key = `${fn.startIndex}:${fn.endIndex}`;
    if (!shapes.has(key)) shapes.set(key, shapeOf(fn));
    return shapes.get(key)!;
  };
  const functionFacts: GuideFunction[] = [];
  // A stop needs `throw` and a store a `prisma` or `$transaction` receiver, so other files skip the name walk.
  const facts = /throw|prisma|\$transaction/.test(text)
    ? readFacts({ id: fileId, relativePath, size: text.length }, text, fileHash, MAP_LIMITS.nodesPerFile) : null;
  const factFunctions = new Map(facts?.functions.map(fn => [`${fn.startIndex}:${fn.endIndex}`, fn]));
  for (const symbol of analysis.symbols) {
    const { startUtf16, endUtf16 } = symbol.evidence;
    const fn = climb(startUtf16, node => node.startIndex === startUtf16 && node.endIndex === endUtf16 && functionTypes.has(node.type));
    if (!fn) continue;
    const { routes, calls, hooks, jsx } = shapeAt(fn);
    const tags = routes.map(route => `서버 받는 곳 모양 · ${route ?? '주소 확인 못 함'}`);
    const exported = exportedFunctions.filter(item => item.fn.startIndex === startUtf16 && item.fn.endIndex === endUtf16);
    if (next?.kind === 'pages-api' && exported.some(item => item.isDefault)) tags.push('서버 받는 곳 모양 · Next · 모든 방식');
    if (next?.kind === 'route') {
      const methods = exported.filter(item => !item.isDefault && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(item.name));
      for (const method of new Set(methods.map(item => item.name))) tags.push(`서버 받는 곳 모양 · Next · ${method}`);
    }
    if (jsx) tags.push('JSX(화면 조각)가 든 코드를 돌려줘요');
    const parent = fn.parent;
    const assignedName = parent && ['variable_declarator', 'public_field_definition', 'field_definition'].includes(parent.type)
      ? parent.childForFieldName('name') : parent?.type === 'pair' ? parent.childForFieldName('key') : null;
    if (/^use[A-Z]/.test(fn.childForFieldName('name')?.text ?? assignedName?.text ?? '')) tags.push('훅 이름');
    const factFunction = factFunctions.get(`${startUtf16}:${endUtf16}`);
    const bodyFacts = factFunction && facts ? serverFacts(factFunction, facts) : { stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0 };
    functionFacts.push({ symbolId: symbol.id, ...bodyFacts, tags, calls: calls.slice(0, 3), callsOmitted: Math.max(0, calls.length - 3),
      hooks: hooks.slice(0, 3), hooksOmitted: Math.max(0, hooks.length - 3), routeNote: routes.length ? '앱 공통 앞 경로는 빼고 봤어요' : null });
  }
  const known = new Map(projectFiles.map(file => [file.relativePath, file]));
  const imports: GuideImport[] = [];
  const external = new Set<string>();
  const targets = new Set<string>();
  // As in the map, nothing inside an error node is trusted.
  const insideError = (node: Node) => { for (let at: Node | null = node; at; at = at.parent) if (at.isError || at.isMissing) return true; return false; };
  for (const node of root.descendantsOfType(['import_statement', 'export_statement', 'call_expression'])) {
    const imported = importOf(node);
    if (!imported || (root.hasError && insideError(node))) continue;
    const { kind, specifier } = imported;
    const item: GuideImport = { specifier, line: node.startPosition.row + 1, target: null, status: 'not-found' };
    if (kind !== 'static') { imports.push({ ...item, status: kind }); continue; }
    if (specifier === null) { imports.push({ ...item, status: 'unreadable' }); continue; }
    if (specifier.startsWith('/')) { imports.push({ ...item, status: 'outside' }); continue; }
    if (!isRelative(specifier)) { external.add(specifier); continue; }
    const candidates = candidatesFor(relativePath, specifier, known);
    if (candidates === null) { imports.push({ ...item, status: 'outside' }); continue; }
    if (candidates.length !== 1) { imports.push({ ...item, status: candidates.length ? 'ambiguous' : 'not-found' }); continue; }
    const target = known.get(candidates[0])!;
    if (targets.has(target.id)) continue;
    targets.add(target.id);
    imports.push({ ...item, status: 'project', target: { fileId: target.id, relativePath: target.relativePath } });
  }
  const chunks = split.chunks.map(chunk => {
    const symbol = chunk.functionRange && analysis.symbols.find(item => item.evidence.startUtf16 === chunk.functionRange!.startUtf16 && item.evidence.endUtf16 === chunk.functionRange!.endUtf16);
    const parts: string[] = [];
    if (chunk.kind === 'imports') {
      const statements = top.filter(node => node.startIndex >= chunk.range.startUtf16 && node.endIndex <= chunk.range.endUtf16);
      for (const [type, label] of [['import_statement', '가져오기'], ['export_statement', '다시 내보내기']]) {
        const group = statements.filter(node => node.type === type);
        if (!group.length) continue;
        const sources = [...new Set(group.map(node => node.childForFieldName('source')?.text.slice(1, -1) ?? '?'))];
        parts.push(`${label} ${group.length}개: ${sources.slice(0, 3).map(quoted).join(', ')}${sources.length > 3 ? ` 외 ${sources.length - 3}곳` : ''}`);
      }
    } else if (chunk.functionRange) {
      const { startUtf16, endUtf16 } = chunk.functionRange;
      const fn = climb(startUtf16, node => node.startIndex === startUtf16 && node.endIndex === endUtf16 && functionTypes.has(node.type))!;
      const { routes, calls, hooks, jsx } = shapeAt(fn);
      for (const route of routes) {
        parts.push(route === null ? '요청을 받아요 · 주소를 글자로 적지 않아 확인 못 함'
          : `요청을 받아요 · 이 파일 기준 경로 ${quoted(route)} (앱 공통 앞 경로는 빼고 봤어요)`);
      }
      parts.push(`매개변수 ${clip(fn.childForFieldName('parameters')?.text ?? fn.childForFieldName('parameter')?.text ?? '()')}`);
      if (symbol) parts.push(`하는 일 단계 ${symbol.steps.length}개`);
      if (calls.length) parts.push(`부르는 것: ${calls.slice(0, 3).map(quoted).join(', ')}${calls.length > 3 ? ` 외 ${calls.length - 3}개` : ''}`);
      if (jsx) parts.push('화면 조각을 그려요');
      if (hooks.length) parts.push(`쓰는 훅: ${hooks.slice(0, 3).map(quoted).join(', ')}${hooks.length > 3 ? ` 외 ${hooks.length - 3}개` : ''}`);
    } else if (chunk.kind === 'class') {
      const node = classes.find(node => node.childForFieldName('body')?.startIndex === chunk.range.endUtf16)!;
      parts.push(`클래스 ${clip(node.childForFieldName('name')?.text ?? '?')}`);
      parts.push(...decorators(node).map(node => clip(node.text)));
      parts.push(...node.namedChildren.filter(node => ['class_heritage', 'extends_clause', 'implements_clause'].includes(node.type)).map(node => clip(node.text)));
      const controller = decorators(node).find(node => decoratorName(node) === 'Controller');
      if (controller) {
        const path = decoratorPath(controller);
        parts.push(path === null ? '주소를 글자로 적지 않아 확인 못 함' : `주소 앞부분 ${quoted('/' + path.replace(/^\/+|\/+$/g, ''))}`);
      }
    } else if (chunk.kind === 'field') {
      const node = climb(chunk.range.endUtf16 - 1, node => fieldTypes.has(node.type))!;
      parts.push(`필드 ${clip(node.childForFieldName('name')?.text ?? '?')}${clip(node.childForFieldName('type')?.text ?? '')}`);
      parts.push(...decorators(node).map(node => clip(node.text)));
    } else if (chunk.kind === 'variable') {
      // From the last token: an `export const` chunk starts at `export`, outside the declaration.
      const statement = climb(chunk.range.endUtf16 - 1, node => ['lexical_declaration', 'variable_declaration'].includes(node.type)
        && node.startIndex >= chunk.range.startUtf16);
      const value = statement?.namedChildren.find(node => node.type === 'variable_declarator')?.childForFieldName('value');
      parts.push('값: ' + (!value ? '초기값 없음' : value.type === 'object' ? '객체' : value.type === 'array' ? '배열'
        : ['string', 'number', 'template_string'].includes(value.type) ? '글자·숫자'
          : value.type === 'call_expression' ? `${quoted(`${value.childForFieldName('function')?.text}(…)`)} 호출 결과` : quoted(value.text)));
    } else parts.push(clip(text.slice(chunk.range.startUtf16, chunk.range.endUtf16).split(/\r?\n/)[0]));
    return { chunk, about: parts.join(' · '), symbolId: symbol ? symbol.id : null };
  });
  const names = [...new Set(exportedNames)];
  return { role: fileRole, notes, exports: names.slice(0, 20), exportsOmitted: Math.max(0, names.length - 20),
    imports: imports.slice(0, 30), importsOmitted: Math.max(0, imports.length - 30),
    external: [...external].slice(0, 8), externalOmitted: Math.max(0, external.size - 8),
    functions: functionFacts, chunks, limitations: split.limitations };
}
