import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import type { Analysis, CodeStep, Evidence } from '../../shared/contracts';

const functionTypes = new Set([
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
    result.warnings.push('구문 오류가 있습니다. 오류가 포함된 함수와 import는 분석에서 제외합니다.');
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
    if (node.type === 'import_statement' && !node.hasError) {
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
        const parent = node.parent;
        const assignedName = parent && ['variable_declarator', 'public_field_definition', 'field_definition'].includes(parent.type)
          ? parent.childForFieldName('name')
          : parent?.type === 'pair' ? parent.childForFieldName('key') : null;
        const name = node.childForFieldName('name')?.text ?? assignedName?.text
          ?? `이름 없는 함수 (${node.startPosition.row + 1}행)`;
        const params = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
        result.symbols.push({
          id: randomUUID(), name, kind: node.type, params: params ? clip(params.text) : '',
          evidence: evidence(node), steps: stepsFor(body),
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
