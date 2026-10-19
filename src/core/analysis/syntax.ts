import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import type { Analysis, CodeStep, Evidence } from '../../shared/contracts';

export const functionTypes = new Set([
  'function_declaration', 'generator_function_declaration', 'function_expression',
  'generator_function', 'arrow_function', 'method_definition',
]);
// File-wide budgets bound IPC/UI output, including imports and nested functions.
const MAX_EVIDENCE = 1_000;
const MAX_SYMBOLS = 200;
const MAX_VISITED_NODES = 20_000;
const stepTitles: Record<string, string> = {
  lexical_declaration: '변수 선언', variable_declaration: '변수 선언',
  expression_statement: '표현식', return_statement: '반환문', throw_statement: '오류 던지기',
  if_statement: '조건 확인', else_clause: '다른 조건의 분기',
  for_statement: '반복문', for_in_statement: '반복문', while_statement: '반복문',
  do_statement: '반복문', switch_statement: '값에 따른 분기', switch_case: '분기 항목',
  switch_default: '기본 분기', try_statement: '오류 처리 구문', catch_clause: '오류 받기',
  finally_clause: '마무리 구문', break_statement: '반복·분기 종료문',
  continue_statement: '다음 반복으로 이동하는 문장', call_expression: '호출 표현식',
  await_expression: '기다리는 표현식', yield_expression: '값을 내보내는 표현식',
};
// A class body runs later (instance fields on `new`, methods when called), so the function's steps
// skip it like a nested function. Static initializers that do run here are left out rather than guessed.
const classTypes = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
// Parents whose statements run one after another, so the next statement is where code continues.
const statementLists = new Set(['statement_block', 'switch_case', 'switch_default']);
// Details travel over IPC once per step, so a long condition or returned value is cut short.
const MAX_DETAIL = 300;
const clip = (value: string): string => value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL)}…` : value;
const firstCode = (node: Parser.SyntaxNode | null): Parser.SyntaxNode | undefined =>
  node?.namedChildren.find(child => child.type !== 'comment');
const withoutParens = (node: Parser.SyntaxNode | null): Parser.SyntaxNode | undefined =>
  node?.type === 'parenthesized_expression' ? firstCode(node) : node ?? undefined;

/** The code a step decides on or hands back. Other step kinds are shown by their own range. */
function detailOf(node: Parser.SyntaxNode, text: string): string | undefined {
  switch (node.type) {
    case 'if_statement': case 'while_statement': case 'do_statement': case 'for_statement': {
      const condition = withoutParens(node.childForFieldName('condition'));
      // `for (;;)` has an empty statement where the condition would be.
      return condition && condition.type !== 'empty_statement' ? condition.text : undefined;
    }
    case 'for_in_statement': {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      return left && right ? text.slice(left.startIndex, right.endIndex) : undefined;
    }
    case 'switch_statement': return withoutParens(node.childForFieldName('value'))?.text;
    case 'switch_case': return node.childForFieldName('value')?.text;
    case 'return_statement': case 'throw_statement': return firstCode(node)?.text;
    default: return undefined;
  }
}

// Plan v2.3 C-1: each of these around a point of the body adds one level of nesting.
const nestingTypes = new Set([
  'if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement', 'try_statement',
]);

/** The name a function is listed under: its own, the variable, field or key it is assigned to, or its line. */
export function functionName(node: Parser.SyntaxNode): string {
  const parent = node.parent;
  const assignedName = parent && ['variable_declarator', 'public_field_definition', 'field_definition'].includes(parent.type)
    ? parent.childForFieldName('name')
    : parent?.type === 'pair' ? parent.childForFieldName('key') : null;
  return node.childForFieldName('name')?.text ?? assignedName?.text ?? `이름 없는 함수 (${node.startPosition.row + 1}행)`;
}

/**
 * Plan v2.3 C-1, for a listed function. `lines`: lines of its body holding a character that is not white
 * space, `{` or `}`, outside comments and nested functions. `depth`: the most ifs, loops, switches and trys
 * around any point of the body; an `else if` counts with the if before it. A nested function, header and
 * all, belongs to itself and is measured on its own from depth 0.
 */
export function measureFunction(node: Parser.SyntaxNode, text: string): { lines: number; depth: number } {
  const body = node.childForFieldName('body')!;
  // Comments and nested functions, in source order: their text is not this function's code.
  const skipped: { start: number; end: number; endRow: number }[] = [];
  let depth = 0;
  // A cursor rather than `nextNamedSibling`/`parent`, which search from the root and get slow in deeply
  // nested code. `level` counts the nesting statements around the cursor's node; `outside` keeps the level
  // and type of each node the cursor went into, so returning to it restores the level.
  const cursor = body.walk();
  let level = 0;
  const outside: { level: number; type: string }[] = [];
  let entering = true;
  for (;;) {
    const type = cursor.nodeType;
    if (entering && cursor.nodeIsNamed) {
      if (type === 'comment' || functionTypes.has(type)) {
        // An arrow's body can itself be a function (`() => () => x`); then all of it belongs to that function.
        skipped.push({ start: cursor.startIndex, end: cursor.endIndex, endRow: cursor.endPosition.row });
      } else {
        const elseIf = type === 'if_statement' && outside.at(-1)?.type === 'else_clause';
        const inner = nestingTypes.has(type) && !elseIf ? level + 1 : level;
        depth = Math.max(depth, inner);
        if (cursor.gotoFirstChild()) { outside.push({ level, type }); level = inner; continue; }
      }
    }
    // The cursor starts at the body, so it never moves to the body's siblings or parent.
    if (cursor.gotoNextSibling()) { entering = true; continue; }
    if (!outside.length) break;
    cursor.gotoParent();
    level = outside.pop()!.level;
    entering = false;
  }

  let lines = 0;
  let counted = -1;
  let row = body.startPosition.row;
  let next = 0;
  for (let index = body.startIndex; index < body.endIndex; index++) {
    if (next < skipped.length && index >= skipped[next].start) {
      index = skipped[next].end - 1;
      row = skipped[next].endRow;
      next++;
      continue;
    }
    const character = text[index];
    if (character === '\n') row++;
    else if (character !== '{' && character !== '}' && !/\s/.test(character) && counted !== row) { lines++; counted = row; }
  }
  return { lines, depth };
}

/**
 * `export function f`, `export default …`, or a function assigned in `export const f = …`.
 * `export { f }` lists, re-exports, class methods and CommonJS `module.exports` are not followed.
 */
/**
 * Whether a node is an import, and of which kind. The analyzer's import evidence and the project map
 * both use this, so a map entry and the evidence found on opening that file cover the same range.
 * `static` is `import … from` or `export … from`; `not-static` is `import()`, `require()` or TS
 * `import x = require()`; `syntax` is an import statement Tree-sitter recognized with an error in it.
 */
export function importOf(node: Parser.SyntaxNode): { kind: 'static' | 'not-static' | 'syntax'; specifier: string | null } | null {
  // Only a string made of one plain fragment gives a specifier. An empty string has none, and one with an
  // escape (`'./a\u002fb'`) is split into pieces, so taking a piece would name another path.
  const literal = (string: Parser.SyntaxNode | null | undefined): string | null =>
    string?.type === 'string' && string.namedChildren.length === 1 && string.namedChildren[0].type === 'string_fragment'
      ? string.namedChildren[0].text : null;
  if (node.type === 'import_statement') {
    const required = node.namedChildren.find(child => child.type === 'import_require_clause');
    if (required) return { kind: 'not-static', specifier: literal(required.namedChildren.find(child => child.type === 'string')) };
    return { kind: node.hasError ? 'syntax' : 'static', specifier: literal(node.childForFieldName('source')) };
  }
  if (node.type === 'export_statement') {
    const source = node.childForFieldName('source');
    return source ? { kind: node.hasError ? 'syntax' : 'static', specifier: literal(source) } : null;
  }
  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('function');
    if (callee?.type !== 'import' && !(callee?.type === 'identifier' && callee.text === 'require')) return null;
    return { kind: 'not-static', specifier: literal(node.childForFieldName('arguments')?.firstNamedChild) };
  }
  return null;
}

function isExported(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type === 'export_statement') return true;
  const declaration = parent?.type === 'variable_declarator' ? parent.parent : null;
  return !!declaration && ['lexical_declaration', 'variable_declaration'].includes(declaration.type)
    && declaration.parent?.type === 'export_statement';
}

/** Static syntax only: neither source execution nor call-target resolution is performed. */
export function analyzeSource(
  text: string,
  relativePath: string,
  context: { projectId: string; fileId: string; fileHash: string },
): Analysis {
  const extension = extname(relativePath).toLowerCase();
  const language = ['.ts', '.tsx', '.mts', '.cts'].includes(extension) ? 'typescript'
    : ['.js', '.jsx', '.mjs', '.cjs'].includes(extension) ? 'javascript' : 'text';
  const result: Analysis = { language, symbols: [], imports: [], warnings: [] };
  if (language === 'text') {
    result.warnings.push('이 파일은 원문만 표시합니다. 현재 구문 분석은 TypeScript와 JavaScript만 지원합니다.');
    return result;
  }

  const parser = new Parser();
  parser.setLanguage(language === 'javascript' ? JavaScript
    : extension === '.tsx' ? TypeScript.tsx : TypeScript.typescript);
  // This binding's string callback needs room for the source plus its terminator.
  const root = parser.parse(text, undefined, { bufferSize: Math.max(32 * 1024, text.length + 1) }).rootNode;
  result.warnings.push('코드에 적힌 구문 구조입니다. 실제 실행 순서와 호출 대상은 확인하지 않았습니다.');
  if (root.hasError) {
    result.warnings.push('구문 오류가 있습니다. 오류가 포함된 함수는 분석에서 제외합니다.');
  }

  let evidenceCount = 0;
  let visitedNodes = 0;
  let limited = false;
  const budgetAvailable = (): boolean => {
    if (evidenceCount >= MAX_EVIDENCE || visitedNodes >= MAX_VISITED_NODES) {
      limited = true;
      return false;
    }
    visitedNodes++;
    return true;
  };

  // tree-sitter's Node binding 0.21.1 reports JavaScript UTF-16 indices (not byte offsets).
  const evidence = (node: Parser.SyntaxNode): Evidence => {
    evidenceCount++;
    return {
      id: randomUUID(), ...context,
      startUtf16: node.startIndex, endUtf16: node.endIndex,
      startLine: node.startPosition.row + 1,
      endLine: Math.max(node.startPosition.row + 1,
        node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1)),
    };
  };

  const stepsFor = (body: Parser.SyntaxNode): CodeStep[] => {
    const steps: CodeStep[] = [];
    const ifs: { step: CodeStep; node: Parser.SyntaxNode }[] = [];
    const pending = [{ node: body, depth: 0 }];
    while (pending.length && budgetAvailable()) {
      const { node, depth } = pending.pop()!;
      if (node !== body && node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, depth });
      // An arrow function's expression body is its returned value, whatever expression it is.
      const expressionBody = node === body && node.type !== 'statement_block';
      // A nested function or class does not run its body by being declared or returned here.
      const nestedDefinition = functionTypes.has(node.type) || classTypes.has(node.type);
      if (nestedDefinition && !expressionBody) continue;
      const title = expressionBody ? '표현식 결과 반환' : stepTitles[node.type];
      if (title) {
        const step: CodeStep = {
          id: randomUUID(), kind: expressionBody ? 'expression_body' : node.type, title, depth, evidence: evidence(node),
        };
        const detail = expressionBody ? undefined : detailOf(node, text);
        if (detail) step.detail = clip(detail);
        steps.push(step);
        if (node.type === 'if_statement') ifs.push({ step, node });
      }
      const childDepth = title ? depth + 1 : depth;
      if (node.firstNamedChild && !nestedDefinition) pending.push({ node: node.firstNamedChild, depth: childDepth });
    }

    // Steps are in source order and nested nodes have nested ranges, so the first step inside a
    // range is where that part of the code starts. Steps cut by the budget are missing from the
    // tail, which yields null rather than a wrong step.
    const firstStepWithin = (from: number, to: number): string | null =>
      steps.find(step => step.evidence.startUtf16 >= from && step.evidence.endUtf16 <= to)?.id ?? null;
    const firstStepIn = (node: Parser.SyntaxNode | null): string | null =>
      node ? firstStepWithin(node.startIndex, node.endIndex) : null;
    // Where code continues once an if/else-if chain is done: the next step in the statement list
    // around the whole chain. Any other parent, such as an outer if without braces, has ranges that
    // belong to a different branch. Loop repeats, function ends and jumps out are not claimed either.
    const after = (node: Parser.SyntaxNode): string | null => {
      let chain = node;
      while (chain.parent?.type === 'else_clause' && chain.parent.parent) chain = chain.parent.parent;
      const list = chain.parent;
      return list && statementLists.has(list.type) ? firstStepWithin(chain.endIndex, list.endIndex) : null;
    };
    for (const { step, node } of ifs) {
      const alternative = node.childForFieldName('alternative');
      step.branch = {
        // An empty `if (ok) {}` still continues after the if when the condition is true.
        whenTrue: firstStepIn(node.childForFieldName('consequence')) ?? after(node),
        whenFalse: alternative ? firstStepIn(alternative) : after(node),
      };
    }
    return steps;
  };

  const pending = [root];
  while (pending.length && !limited && budgetAvailable()) {
    const node = pending.pop()!;
    if (node.nextNamedSibling) pending.push(node.nextNamedSibling);
    if (node.isError || node.isMissing) continue;
    if (importOf(node)) {
      result.imports.push({ text: text.slice(node.startIndex, node.endIndex), evidence: evidence(node) });
    }
    if (functionTypes.has(node.type)) {
      if (node.hasError) continue;
      const body = node.childForFieldName('body');
      if (body) {
        if (result.symbols.length >= MAX_SYMBOLS) {
          limited = true;
          break;
        }
        const params = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
        result.symbols.push({
          id: randomUUID(), name: functionName(node), kind: node.type, params: params ? clip(params.text) : '', exported: isExported(node),
          evidence: evidence(node), steps: stepsFor(body), complexity: measureFunction(node, text),
        });
      }
    }
    if (node.firstNamedChild) pending.push(node.firstNamedChild);
  }
  if (limited) {
    result.warnings.push(`분석량 제한에 도달하여 일부 결과만 표시합니다. 파일 전체에서 함수 ${MAX_SYMBOLS}개, import·함수·단계의 근거 합계 ${MAX_EVIDENCE}개, 구문 방문 ${MAX_VISITED_NODES}회까지 처리합니다. 나머지 원문은 코드 보기에서 확인하세요.`);
  }
  if (result.symbols.length === 0 && !limited) {
    result.warnings.push('분석할 수 있는 함수가 없습니다. 원문과 import 선언을 확인할 수 있습니다.');
  }
  return result;
}
