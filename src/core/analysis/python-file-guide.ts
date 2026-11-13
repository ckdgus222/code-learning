import type Parser from 'tree-sitter';
import type { Analysis, FileGuide, GuideFunction, GuideImport, ProjectFile } from '../../shared/contracts';
import { AppError } from '../../shared/errors';
import { splitPythonFileChunks } from './file-chunks';
import { initFactsOf, mentionsMachinery, pythonImportsOf, resolvePythonImport, type InitFacts } from './python-imports';
import { pythonFunction, stringOnly } from './python-syntax';
import { NESTED_NOTE, parse } from './syntax';
import { MAX_VISITED_NODES } from './syntax-tools';

type Node = Parser.SyntaxNode;
type FunctionShape = { node: Node; calls: string[]; total: number };
type ImportFacts = { plain: boolean; init: InitFacts | null };
const keyOf = (start: number, end: number) => `${start}:${end}`;
const clip = (raw: string) => {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};
const quoted = (text: string) => `\`${clip(text)}\``;
const NO_IMPORT_FACTS: ImportFacts = { plain: false, init: null };
const DEPENDENCY_FILES = 30;
const DEPENDENCY_BYTES = 1024 * 1024;

/** A static Python guide. Dependencies are read only through the worker's registered-file reader. */
export async function describePythonFile(text: string, relativePath: string, fileId: string, fileHash: string,
  analysis: Analysis, projectFiles: ProjectFile[], context: {
    readFile(file: ProjectFile, maxBytes: number): Promise<{ text: string; hash: string }>;
    shouldStop(): boolean;
  }): Promise<FileGuide> {
  const check = () => { if (context.shouldStop()) throw new AppError('CANCELLED', '작업을 취소했습니다.'); };
  check();
  const root = parse(text, relativePath);
  if (!root) throw new AppError('LIMIT', NESTED_NOTE);
  const split = splitPythonFileChunks(text, relativePath, fileId, fileHash, root, context.shouldStop);
  const limitations = new Set(split.limitations);
  const functions = new Map<string, FunctionShape>();
  const bodies = new Map<number, FunctionShape>();
  const nodes = new Map<string, Node>();
  const importsByRange = new Map(analysis.imports.filter(item => item.evidence.fileId === fileId && item.evidence.fileHash === fileHash)
    .map(item => [keyOf(item.evidence.startUtf16, item.evidence.endUtf16), item]));
  const importNodes: Node[] = [];
  const pending: { node: Node; owner: FunctionShape | null }[] = [{ node: root, owner: null }];
  let visited = 0;
  let machinery = false;
  while (pending.length && visited < MAX_VISITED_NODES) {
    if (visited++ % 128 === 0) check();
    const entry = pending.pop()!;
    const { node } = entry;
    if (node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, owner: entry.owner });
    if (node.isError || node.isMissing) continue;
    const key = keyOf(node.startIndex, node.endIndex);
    if (node.type === 'expression_statement') nodes.set(key, node);
    if (node.type === 'identifier' && mentionsMachinery(node)) machinery = true;
    if (importsByRange.has(key) && ['import_statement', 'import_from_statement', 'future_import_statement'].includes(node.type)) importNodes.push(node);
    let owner = entry.owner;
    if (['decorated_definition', 'class_definition', 'function_definition', 'lambda'].includes(node.type)) owner = null;
    if (node.parent?.type === 'assignment' && node.parent.childForFieldName('type')?.id === node.id) owner = null;
    const fn = pythonFunction(node);
    if (fn && !fn.declaration.hasError) {
      const shape: FunctionShape = { node, calls: [], total: 0 };
      functions.set(keyOf(fn.declaration.startIndex, fn.declaration.endIndex), shape);
      bodies.set(fn.body.id, shape);
    }
    if (node.type === 'block' && bodies.has(node.id)) owner = bodies.get(node.id)!;
    if (node.type === 'call' && owner && !node.hasError) {
      owner.total++;
      if (owner.calls.length < 3) owner.calls.push(clip(node.childForFieldName('function')?.text ?? '?'));
    }
    if (node.firstNamedChild) pending.push({ node: node.firstNamedChild, owner });
  }
  const limited = pending.length > 0;
  if (limited) limitations.add('분석량 제한에 닿아 함수의 호출과 가져오기를 일부만 확인했어요');
  const plain = !root.hasError && !limited && !machinery;
  const metadata = new Map<string, ImportFacts>([[relativePath, { plain, init: plain ? initFactsOf(root) : null }]]);
  const known = new Map(projectFiles.map(file => [file.relativePath, file]));
  const paths = new Set(known.keys());
  const needed = new Set<string>();
  const cached = (path: string) => {
    if (!metadata.has(path)) needed.add(path);
    return metadata.get(path) ?? NO_IMPORT_FACTS;
  };
  const resolverFacts = { plain: (path: string) => cached(path).plain, init: (path: string) => cached(path).init };
  let reads = 0;
  let bytes = 0;
  const readMetadata = async (path: string) => {
    check();
    metadata.set(path, NO_IMPORT_FACTS);
    const file = known.get(path);
    if (!file) return;
    const remaining = DEPENDENCY_BYTES - bytes;
    if (reads >= DEPENDENCY_FILES || remaining <= 0 || file.size > remaining) {
      limitations.add('import 확인에 필요한 추가 파일 읽기 한도(30개·1MiB)에 닿았어요');
      return;
    }
    reads++;
    try {
      const source = await context.readFile(file, remaining);
      check();
      bytes += Buffer.byteLength(source.text, 'utf8');
      if (bytes > DEPENDENCY_BYTES) {
        limitations.add('import 확인에 필요한 추가 파일 읽기 한도(30개·1MiB)에 닿았어요');
        return;
      }
      const tree = parse(source.text, file.relativePath);
      if (!tree || tree.hasError) { limitations.add('일부 import의 확인에 필요한 파일을 끝까지 분석하지 못했어요'); return; }
      let count = 0;
      let unsafe = false;
      const pending = [tree];
      while (pending.length && count < MAX_VISITED_NODES) {
        if (count++ % 128 === 0) check();
        const node = pending.pop()!;
        if (node.type === 'identifier' && mentionsMachinery(node)) unsafe = true;
        if (node.nextNamedSibling) pending.push(node.nextNamedSibling);
        if (node.firstNamedChild) pending.push(node.firstNamedChild);
      }
      if (pending.length) { limitations.add('일부 import의 확인에 필요한 파일이 분석량 제한에 닿았어요'); return; }
      metadata.set(path, { plain: !unsafe, init: unsafe ? null : initFactsOf(tree) });
    } catch (error) {
      check();
      if (error instanceof AppError && error.code === 'CANCELLED') throw error;
      limitations.add('일부 import의 확인에 필요한 파일을 읽지 못했어요');
    }
  };
  const imports: GuideImport[] = [];
  const external = new Set<string>();
  const targets = new Set<string>();
  const notes = new Set<string>();
  for (const node of importNodes) {
    check();
    if (node.hasError) {
      imports.push({ specifier: clip(node.text), line: node.startPosition.row + 1, target: null, status: 'syntax' });
      continue;
    }
    for (const item of pythonImportsOf(node)) {
      let resolved = resolvePythonImport(relativePath, item, paths, resolverFacts);
      while (needed.size) {
        const dependencies = [...needed];
        needed.clear();
        for (const path of dependencies) await readMetadata(path);
        check();
        resolved = resolvePythonImport(relativePath, item, paths, resolverFacts);
      }
      for (const target of resolved) {
        if (target.kind === 'external') { external.add(target.specifier); continue; }
        const row = { specifier: target.specifier, line: node.startPosition.row + 1, target: null };
        if (target.kind === 'unresolved') {
          imports.push({ ...row, status: target.reason });
          if (target.reasonText) notes.add(target.reasonText);
          continue;
        }
        const file = known.get(target.relativePath);
        if (!file || targets.has(file.id)) continue;
        targets.add(file.id);
        imports.push({ ...row, status: 'project', target: { fileId: file.id, relativePath: file.relativePath } });
      }
    }
  }
  if (importNodes.length) notes.add('코드에 적힌 import 경로를 확인했어요. 조건문이나 함수 안의 import가 실제 실행되는지는 판단하지 않아요.');
  const symbols = new Map(analysis.symbols.filter(symbol => symbol.evidence.fileId === fileId && symbol.evidence.fileHash === fileHash)
    .map(symbol => [keyOf(symbol.evidence.startUtf16, symbol.evidence.endUtf16), symbol]));
  const functionFacts: GuideFunction[] = [];
  for (const [key, symbol] of symbols) {
    const shape = functions.get(key);
    if (!shape) continue;
    functionFacts.push({ symbolId: symbol.id, tags: [], calls: shape.calls, callsOmitted: Math.max(0, shape.total - 3),
      hooks: [], hooksOmitted: 0, routeNote: null, stops: [], stopsOmitted: 0, stores: [], storesOmitted: 0 });
  }
  const chunks = split.chunks.map(chunk => {
    const key = chunk.functionRange ? keyOf(chunk.functionRange.startUtf16, chunk.functionRange.endUtf16) : null;
    const symbol = key ? symbols.get(key) : null;
    const shape = key ? functions.get(key) : null;
    const node = nodes.get(keyOf(chunk.range.startUtf16, chunk.range.endUtf16));
    const parts: string[] = [];
    if (chunk.kind === 'imports') parts.push('다른 모듈의 이름을 가져오거나 Python의 문법 옵션을 정해요');
    else if (shape) {
      parts.push(`매개변수 ${clip(shape.node.childForFieldName('parameters')?.text ?? '()')}`);
      if (symbol) parts.push(`하는 일 단계 ${symbol.steps.length}개`);
      if (shape.total) parts.push(`부르는 것: ${shape.calls.map(quoted).join(', ')}${shape.total > 3 ? ` 외 ${shape.total - 3}개` : ''}`);
    } else if (chunk.kind === 'class') parts.push(chunk.name);
    else if (chunk.kind === 'variable' && node) {
      const assignment = node?.firstNamedChild;
      const value = assignment?.childForFieldName('right');
      const type = assignment?.childForFieldName('type');
      if (type) parts.push(`적힌 타입: ${quoted(type.text)}`);
      parts.push(value ? `값: ${quoted(value.text)}` : '초기값 없음');
    } else if (node && stringOnly(node)) parts.push('문서 문자열 또는 글자 표현식이에요');
    else parts.push(clip(text.slice(chunk.range.startUtf16, chunk.range.endUtf16).split(/\r?\n/)[0]));
    return { chunk, about: parts.join(' · '), symbolId: symbol?.id ?? null };
  });
  let label = 'Python 코드';
  let about = `확인한 함수 ${analysis.symbols.length}개·클래스 ${analysis.classes?.length ?? 0}개가 있어요.`;
  const base = relativePath.split('/').at(-1)!;
  if (base === '__init__.py') { label = 'Python 패키지 초기화'; about = '패키지를 가져올 때 읽는 파일이에요.'; }
  else if (base === '__main__.py') { label = 'Python 실행 시작 후보'; about = '패키지를 실행할 때 시작점으로 쓰는 이름의 파일이에요.'; }
  else if (base === 'conftest.py' || /^(?:test_.*|.*_test)\.py$/.test(base) || /(?:^|\/)(?:tests?|__tests__)\//.test(relativePath)) {
    label = 'Python 시험 코드 후보'; about = '경로나 이름이 시험 코드 또는 시험 준비 파일의 모양이에요.';
  }
  check();
  return { role: { label, about, basis: { text: clip(relativePath), range: null } }, notes: [...notes],
    exports: [], exportsOmitted: 0, imports: imports.slice(0, 30), importsOmitted: Math.max(0, imports.length - 30),
    external: [...external].slice(0, 8), externalOmitted: Math.max(0, external.size - 8), functions: functionFacts, chunks,
    limitations: [...limitations] };
}
