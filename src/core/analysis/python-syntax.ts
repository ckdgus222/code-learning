import { randomUUID } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { Analysis, CodeStep } from '../../shared/contracts';
import { clip, MAX_SYMBOLS, measureBody, type AnalysisBudget, type MeasureRules } from './syntax-tools';

const definitions = new Set(['function_definition', 'class_definition', 'decorated_definition', 'lambda']);
const imports = new Set(['import_statement', 'import_from_statement', 'future_import_statement']);

/** Bare strings do not run code, but an interpolated f-string does. */
export function stringOnly(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'expression_statement' || node.namedChildCount !== 1) return false;
  let value = node.firstNamedChild!;
  while (value.type === 'parenthesized_expression') {
    const inner = value.namedChildren.find(child => child.type !== 'comment');
    if (!inner) return false;
    value = inner;
  }
  if (value.type !== 'string' && value.type !== 'concatenated_string') return false;
  const strings = value.type === 'string' ? [value] : value.namedChildren;
  return !strings.some(string => string.namedChildren.some(child => child.type === 'interpolation'));
}

const pythonRules: MeasureRules = {
  nestingTypes: new Set(['if_statement', 'for_statement', 'while_statement', 'try_statement', 'match_statement']),
  // The node is built only for an expression statement: building one for every node visited is slow.
  skipped: cursor => cursor.nodeType === 'comment' || cursor.nodeType === 'function_definition'
    || (cursor.nodeType === 'expression_statement' && stringOnly(cursor.currentNode)),
  ignoredCharacters: '',
};

const firstCodeOf = (node: Parser.SyntaxNode) => node.namedChildren.find(child => child.type !== 'comment');

function stepOf(node: Parser.SyntaxNode, text: string): { kind: string; title: string; detail?: string } | null {
  switch (node.type) {
    case 'if_statement': case 'elif_clause':
      return { kind: 'if_statement', title: node.type === 'if_statement' ? '조건 확인' : '다른 조건 확인', detail: node.childForFieldName('condition')?.text };
    case 'else_clause': {
      const owner = node.parent?.type;
      if (owner === 'for_statement' || owner === 'while_statement') return { kind: 'loop_else_clause', title: '반복을 다 돈 뒤의 구문' };
      if (owner === 'try_statement') return { kind: 'try_else_clause', title: '오류가 없을 때의 구문' };
      return { kind: 'else_clause', title: '다른 조건의 분기' };
    }
    case 'for_statement': {
      const left = node.childForFieldName('left'), right = node.childForFieldName('right');
      return { kind: 'for_in_statement', title: '반복문', detail: left && right ? text.slice(left.startIndex, right.endIndex) : undefined };
    }
    case 'while_statement': return { kind: 'while_statement', title: '반복문', detail: node.childForFieldName('condition')?.text };
    case 'try_statement': return { kind: 'try_statement', title: '오류 처리 구문' };
    case 'except_clause': case 'except_group_clause': {
      const header = node.namedChildren.filter(child => child.type !== 'block' && child.type !== 'comment');
      return { kind: 'catch_clause', title: '오류 받기', detail: header.length ? text.slice(header[0].startIndex, header.at(-1)!.endIndex) : undefined };
    }
    case 'finally_clause': return { kind: 'finally_clause', title: '마무리 구문' };
    case 'with_statement': return { kind: 'with_statement', title: 'with 구문', detail: node.namedChildren.find(child => child.type === 'with_clause')?.text };
    case 'match_statement': {
      const subjects = node.childrenForFieldName('subject');
      return { kind: 'match_statement', title: '값의 모양에 따른 분기', detail: subjects.length ? text.slice(subjects[0].startIndex, subjects.at(-1)!.endIndex) : undefined };
    }
    case 'case_clause': {
      const patterns = node.namedChildren.filter(child => child.type === 'case_pattern' || child.id === node.childForFieldName('guard')?.id);
      return { kind: 'case_clause', title: '분기 항목', detail: patterns.length ? text.slice(patterns[0].startIndex, patterns.at(-1)!.endIndex) : undefined };
    }
    case 'return_statement': return { kind: 'return_statement', title: '반환문', detail: firstCodeOf(node)?.text };
    case 'raise_statement': return { kind: 'throw_statement', title: '오류 던지기', detail: firstCodeOf(node)?.text };
    case 'assert_statement': return { kind: 'assert_statement', title: '확인문', detail: firstCodeOf(node)?.text };
    case 'expression_statement': {
      const value = firstCodeOf(node);
      // `x: int` names a type and stores nothing.
      if (value?.type === 'assignment' && !value.childForFieldName('right')) return { kind: 'annotation', title: '타입 표시' };
      if (value?.type === 'assignment' || value?.type === 'augmented_assignment') return { kind: 'assignment', title: '값 넣기' };
      return { kind: 'expression_statement', title: '표현식' };
    }
    case 'call': return { kind: 'call_expression', title: '호출 표현식' };
    case 'await': return { kind: 'await_expression', title: '기다리는 표현식' };
    case 'yield': return { kind: 'yield_expression', title: '값을 내보내는 표현식' };
    case 'break_statement': return { kind: 'break_statement', title: '반복 종료문' };
    case 'continue_statement': return { kind: 'continue_statement', title: '다음 반복으로 이동하는 문장' };
    default: return null;
  }
}

function stepsFor(body: Parser.SyntaxNode, text: string, budget: AnalysisBudget): CodeStep[] {
  const steps: CodeStep[] = [];
  const ifs: { step: CodeStep; node: Parser.SyntaxNode }[] = [];
  const pending = [{ node: body, depth: 0 }];
  while (pending.length && budget.available()) {
    const { node, depth } = pending.pop()!;
    if (node !== body && node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, depth });
    // A nested function or class does not run its body by being declared here. A function with a syntax
    // error is never listed, so no error node reaches this walk.
    if (definitions.has(node.type) || stringOnly(node)) continue;
    const description = stepOf(node, text);
    if (description) {
      const step: CodeStep = { id: randomUUID(), kind: description.kind, title: description.title, depth, evidence: budget.evidence(node) };
      if (description.detail) step.detail = clip(description.detail);
      steps.push(step);
      if (node.type === 'if_statement' || node.type === 'elif_clause') ifs.push({ step, node });
    }
    if (node.firstNamedChild) pending.push({ node: node.firstNamedChild, depth: description ? depth + 1 : depth });
  }

  const firstStepWithin = (from: number, to: number): string | null =>
    steps.find(step => step.evidence.startUtf16 >= from && step.evidence.endUtf16 <= to)?.id ?? null;
  const firstStepIn = (node: Parser.SyntaxNode | null): string | null =>
    node ? firstStepWithin(node.startIndex, node.endIndex) : null;
  for (const { step, node } of ifs) {
    const chain = node.type === 'if_statement' ? node : node.parent!;
    const clauses = chain.childrenForFieldName('alternative');
    const next = node === chain ? clauses[0] : clauses[clauses.findIndex(clause => clause.id === node.id) + 1];
    const after = chain.parent?.type === 'block' ? firstStepWithin(chain.endIndex, chain.parent.endIndex) : null;
    step.branch = {
      whenTrue: firstStepIn(node.childForFieldName('consequence')) ?? after,
      whenFalse: next ? firstStepIn(next) : after,
    };
  }
  return steps;
}

/** `Class.name` for a function or class declared directly in a class body (through its decorators), otherwise its own name. */
export function declarationName(node: Parser.SyntaxNode, declaration: Parser.SyntaxNode): string {
  const owner = declaration.parent?.type === 'block' ? declaration.parent.parent : null;
  const className = owner?.type === 'class_definition' ? owner.childForFieldName('name')?.text : null;
  // Names are shown, not matched: each part is cut short, since a class name repeats in every method's name.
  const name = clip(node.childForFieldName('name')!.text);
  return className ? `${clip(className)}.${name}` : name;
}

/** The analyzer's function, with decorators included in its evidence range. */
export function pythonFunction(node: Parser.SyntaxNode): { declaration: Parser.SyntaxNode; name: string; body: Parser.SyntaxNode } | null {
  if (node.type !== 'function_definition' || node.hasError) return null;
  const body = node.childForFieldName('body');
  if (!body) return null;
  const declaration = node.parent?.type === 'decorated_definition' ? node.parent : node;
  return { declaration, name: declarationName(node, declaration), body };
}

export function measurePythonFunction(body: Parser.SyntaxNode, text: string): { lines: number; depth: number } {
  return measureBody(body, text, pythonRules);
}

/** Python functions, their steps, classes and imports (static syntax only; nothing is run or resolved). */
export function collectPython(root: Parser.SyntaxNode, text: string, result: Analysis, budget: AnalysisBudget): void {
  result.classes = [];
  const pending = [root];
  while (pending.length && !budget.limited && budget.available()) {
    const node = pending.pop()!;
    if (node.nextNamedSibling) pending.push(node.nextNamedSibling);
    if (node.isError || node.isMissing) continue;
    if (imports.has(node.type)) result.imports.push({ text: node.text, evidence: budget.evidence(node) });
    if (node.type === 'function_definition' && node.hasError) continue;
    if (node.type === 'class_definition' && !node.hasError) {
      const declaration = node.parent?.type === 'decorated_definition' ? node.parent : node;
      result.classes.push({
        name: declarationName(node, declaration),
        bases: clip(node.childForFieldName('superclasses')?.text ?? ''), evidence: budget.evidence(declaration),
      });
    }
    const fn = pythonFunction(node);
    if (fn) {
      if (result.symbols.length >= MAX_SYMBOLS) { budget.limited = true; break; }
      const { declaration, name, body } = fn;
      result.symbols.push({
        id: randomUUID(), name, kind: 'function_definition',
        params: clip(node.childForFieldName('parameters')?.text ?? ''), exported: false,
        evidence: budget.evidence(declaration), steps: stepsFor(body, text, budget), complexity: measurePythonFunction(body, text),
      });
    }
    if (node.firstNamedChild) pending.push(node.firstNamedChild);
  }
}
