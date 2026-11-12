import { randomUUID } from 'node:crypto';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import { collectPython } from './python-syntax';
import { clip, createBudget, MAX_EVIDENCE, MAX_SYMBOLS, MAX_VISITED_NODES, measureBody, type AnalysisBudget, type MeasureRules } from './syntax-tools';
import { STRUCTURE_NOTE, type Analysis, type CodeStep } from '../../shared/contracts';
import { languageOf } from '../../shared/languages';

/** TypeScript, JavaScript or Python by `languageOf`; any other path parses as TypeScript (TSX for .tsx). */
export function parse(text: string, relativePath: string): Parser.SyntaxNode {
  const language = languageOf(relativePath);
  const parser = new Parser();
  parser.setLanguage(language === 'python' ? Python : language === 'javascript' ? JavaScript
    : /\.tsx$/i.test(relativePath) ? TypeScript.tsx : TypeScript.typescript);
  // This binding's string callback needs room for the source plus its terminator.
  return parser.parse(text, undefined, { bufferSize: Math.max(32 * 1024, text.length + 1) }).rootNode;
}

export const functionTypes = new Set([
  'function_declaration', 'generator_function_declaration', 'function_expression',
  'generator_function', 'arrow_function', 'method_definition',
]);
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
export const classTypes = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
// Parents whose statements run one after another, so the next statement is where code continues.
const statementLists = new Set(['statement_block', 'switch_case', 'switch_default']);
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

/** A declared or assigned name, without a callback's context and line. */
export function namedFunction(node: Parser.SyntaxNode, shorten: (text: string) => string = text => text): string | null {
  const parent = node.parent;
  const assignedName = parent && ['variable_declarator', 'public_field_definition', 'field_definition'].includes(parent.type)
    ? parent.childForFieldName('name')
    : parent?.type === 'pair' ? parent.childForFieldName('key') : null;
  const ownName = node.childForFieldName('name');
  const name = ownName?.text ?? assignedName?.text;
  const member = node.type === 'method_definition' ? node
    : parent && ['public_field_definition', 'field_definition'].includes(parent.type) ? parent : null;
  const owner = member?.parent?.type === 'class_body' ? member.parent.parent : null;
  const className = owner && classTypes.has(owner.type) ? owner.childForFieldName('name')?.text : null;
  const memberName = member?.childForFieldName('name');
  if (className && memberName && memberName.type !== 'computed_property_name') return `${shorten(className)}.${shorten(memberName.text)}`;
  if (name !== undefined) return shorten(name);
  return null;
}

/** The name a function is listed under: `Class.member` in a named class, its own or assigned name, or its context and line. */
export function functionName(node: Parser.SyntaxNode, shorten: (text: string) => string = text => text): string {
  const name = namedFunction(node, shorten);
  if (name !== null) return name;
  const parent = node.parent;
  const line = `(${node.startPosition.row + 1}행)`;
  if (parent?.type === 'arguments') {
    const call = parent.parent;
    const target = call?.type === 'call_expression' ? call.childForFieldName('function')
      : call?.type === 'new_expression' ? call.childForFieldName('constructor') : null;
    const receiver = target?.type === 'identifier' ? target
      : target?.type === 'member_expression' ? target.childForFieldName('property') : null;
    if (receiver) return `${clip(receiver.text)}에 넘긴 함수 ${line}`;
  }
  if (parent?.type === 'jsx_expression' && parent.parent?.type === 'jsx_attribute') {
    const attribute = parent.parent.namedChildren[0];
    if (attribute) return `${clip(attribute.text)} 함수 ${line}`;
  }
  if (parent?.type === 'export_statement') return `기본 내보내기 함수 ${line}`;
  return `이름 없는 함수 ${line}`;
}

/**
 * Plan v2.3 C-1, for a listed function. `lines`: lines of its body holding a character that is not white
 * space, `{` or `}`, outside comments and nested functions. `depth`: the most ifs, loops, switches and trys
 * around any point of the body; an `else if` counts with the if before it. A nested function, header and
 * all, belongs to itself and is measured on its own from depth 0.
 */
export function measureFunction(node: Parser.SyntaxNode, text: string): { lines: number; depth: number } {
  return measureBody(node.childForFieldName('body')!, text, scriptRules);
}
const scriptRules: MeasureRules = {
  nestingTypes, skipped: cursor => cursor.nodeType === 'comment' || functionTypes.has(cursor.nodeType), ignoredCharacters: '{}',
};

/**
 * `export function f`, `export default …`, or a function assigned in `export const f = …`.
 * `export { f }` lists, re-exports and CommonJS `module.exports` are not followed; exported classes expose public methods.
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
  if (node.type === 'method_definition' && parent?.type === 'class_body') {
    const owner = parent.parent;
    const name = node.childForFieldName('name');
    return !!owner && classTypes.has(owner.type) && owner.parent?.type === 'export_statement'
      && name?.text !== 'constructor' && name?.type !== 'private_property_identifier'
      && !node.children.some(child => child.type === 'accessibility_modifier' && ['private', 'protected'].includes(child.text)
        || !child.isNamed && ['get', 'set'].includes(child.type));
  }
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
  const language = languageOf(relativePath);
  const result: Analysis = { language, symbols: [], imports: [], warnings: [] };
  if (language === 'text') {
    result.warnings.push('이 파일은 원문만 표시합니다. 현재 구문 분석은 TypeScript, JavaScript, Python만 지원합니다.');
    return result;
  }

  const root = parse(text, relativePath);
  result.warnings.push(STRUCTURE_NOTE);
  if (language === 'python') {
    result.warnings.push('Python은 함수·클래스·import 목록, 구문 단계, 프로젝트 지도의 import 연결과 FastAPI·Flask 주소의 기능 흐름(처리 함수까지)을 보여 줘요. 파일 안내, 부르는 곳·값 찾기, 처리 함수 안의 호출 따라가기는 아직 TypeScript·JavaScript만 지원해요.');
  }
  if (root.hasError) {
    result.warnings.push(language === 'python'
      ? '구문 오류가 있습니다. 오류가 포함된 함수와 클래스는 분석에서 제외합니다.'
      : '구문 오류가 있습니다. 오류가 포함된 함수는 분석에서 제외합니다.');
  }

  const budget = createBudget(context);
  if (language === 'python') collectPython(root, text, result, budget);
  else collectScript(root, text, result, budget);
  if (budget.limited) {
    result.warnings.push(`분석량 제한에 도달하여 일부 결과만 표시합니다. 파일 전체에서 함수 ${MAX_SYMBOLS}개, import·함수·클래스·단계의 근거 합계 ${MAX_EVIDENCE}개, 구문 방문 ${MAX_VISITED_NODES}회까지 처리합니다. 나머지 원문은 코드 보기에서 확인하세요.`);
  }
  if (result.symbols.length === 0 && !budget.limited) {
    result.warnings.push('분석할 수 있는 함수가 없습니다. 원문과 import 선언을 확인할 수 있습니다.');
  }
  return result;
}

function collectScript(root: Parser.SyntaxNode, text: string, result: Analysis, budget: AnalysisBudget): void {
  const stepsFor = (body: Parser.SyntaxNode): CodeStep[] => {
    const steps: CodeStep[] = [];
    const ifs: { step: CodeStep; node: Parser.SyntaxNode }[] = [];
    const pending = [{ node: body, depth: 0 }];
    while (pending.length && budget.available()) {
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
          id: randomUUID(), kind: expressionBody ? 'expression_body' : node.type, title, depth, evidence: budget.evidence(node),
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
  while (pending.length && !budget.limited && budget.available()) {
    const node = pending.pop()!;
    if (node.nextNamedSibling) pending.push(node.nextNamedSibling);
    if (node.isError || node.isMissing) continue;
    if (importOf(node)) {
      result.imports.push({ text: text.slice(node.startIndex, node.endIndex), evidence: budget.evidence(node) });
    }
    if (functionTypes.has(node.type)) {
      if (node.hasError) continue;
      const body = node.childForFieldName('body');
      if (body) {
        if (result.symbols.length >= MAX_SYMBOLS) {
          budget.limited = true;
          break;
        }
        const params = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
        result.symbols.push({
          id: randomUUID(), name: functionName(node), kind: node.type, params: params ? clip(params.text) : '', exported: isExported(node),
          evidence: budget.evidence(node), steps: stepsFor(body), complexity: measureFunction(node, text),
        });
      }
    }
    if (node.firstNamedChild) pending.push(node.firstNamedChild);
  }
}
