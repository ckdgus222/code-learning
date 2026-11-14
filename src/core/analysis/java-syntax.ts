import { randomUUID } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { Analysis, CodeStep } from '../../shared/contracts';
import { clip, MAX_SYMBOLS, measureBody, type AnalysisBudget, type MeasureRules } from './syntax-tools';

const types = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration']);
const methods = new Set(['method_declaration', 'constructor_declaration', 'compact_constructor_declaration']);
const comments = new Set(['line_comment', 'block_comment']);
const skipped = (type: string) => comments.has(type) || types.has(type) || type === 'lambda_expression' || type === 'class_body';
const javaRules: MeasureRules = {
  nestingTypes: new Set(['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement',
    'switch_expression', 'try_statement', 'try_with_resources_statement', 'synchronized_statement']),
  skipped: cursor => skipped(cursor.nodeType), ignoredCharacters: '{}',
};
const statementLists = new Set(['block', 'constructor_body', 'switch_block_statement_group']);
const firstCode = (node: Parser.SyntaxNode) => node.namedChildren.find(child => !comments.has(child.type));
const withoutParens = (node: Parser.SyntaxNode | null | undefined): string | undefined =>
  node?.type === 'parenthesized_expression' ? firstCode(node)?.text : node?.text;

function stepOf(node: Parser.SyntaxNode, type: string, text: string): { kind: string; title: string; detail?: string } | null {
  switch (type) {
    case 'if_statement': return { kind: type, title: '조건 확인', detail: withoutParens(node.childForFieldName('condition')) };
    case 'for_statement': case 'while_statement': case 'do_statement':
      return { kind: type, title: '반복문', detail: withoutParens(node.childForFieldName('condition')) };
    case 'enhanced_for_statement': {
      const type = node.childForFieldName('type'), value = node.childForFieldName('value');
      return { kind: 'for_in_statement', title: '반복문', detail: type && value ? text.slice(type.startIndex, value.endIndex) : undefined };
    }
    case 'switch_expression': return { kind: 'switch_statement', title: '값에 따른 분기', detail: withoutParens(node.childForFieldName('condition')) };
    case 'switch_block_statement_group': case 'switch_rule': {
      const labels = node.namedChildren.filter(child => child.type === 'switch_label');
      const onlyDefault = labels.length === 1 && labels[0].text === 'default';
      const kind = type === 'switch_rule' ? 'switch_rule' : onlyDefault ? 'switch_default' : 'switch_case';
      return { kind, title: kind === 'switch_default' ? '기본 분기' : '분기 항목', detail: labels.map(label => label.text).join(', ') };
    }
    case 'try_statement': return { kind: type, title: '오류 처리 구문' };
    case 'try_with_resources_statement': return { kind: type, title: '자원을 쓰는 오류 처리 구문',
      detail: node.childForFieldName('resources')?.text.slice(1, -1) };
    case 'catch_clause': return { kind: type, title: '오류 받기', detail: node.namedChildren.find(child => child.type === 'catch_formal_parameter')?.text };
    case 'finally_clause': return { kind: type, title: '마무리 구문' };
    case 'return_statement': return { kind: type, title: '반환문', detail: withoutParens(firstCode(node)) };
    case 'throw_statement': return { kind: type, title: '오류 던지기', detail: withoutParens(firstCode(node)) };
    case 'break_statement': return { kind: type, title: '반복·분기 종료문' };
    case 'continue_statement': return { kind: type, title: '다음 반복으로 이동하는 문장' };
    case 'yield_statement': return { kind: 'switch_yield', title: 'switch 값 돌려주기', detail: withoutParens(firstCode(node)) };
    case 'local_variable_declaration': return { kind: 'lexical_declaration', title: '변수 선언' };
    case 'expression_statement':
      return firstCode(node)?.type === 'assignment_expression'
        ? { kind: 'assignment', title: '값 넣기' } : { kind: type, title: '표현식' };
    case 'method_invocation': case 'object_creation_expression': case 'explicit_constructor_invocation':
      return { kind: 'call_expression', title: '호출 표현식' };
    case 'assert_statement': return { kind: type, title: '확인문', detail: withoutParens(firstCode(node)) };
    case 'synchronized_statement': return { kind: type, title: '잠금 구문', detail: withoutParens(firstCode(node)) };
    default: return null;
  }
}

function stepsFor(body: Parser.SyntaxNode, text: string, budget: AnalysisBudget): CodeStep[] {
  const steps: CodeStep[] = [];
  const ifs: { step: CodeStep; node: Parser.SyntaxNode; chain: Parser.SyntaxNode }[] = [];
  const pending: { node: Parser.SyntaxNode; depth: number; chain?: Parser.SyntaxNode; chainDepth?: number; alternative?: boolean }[] = [{ node: body, depth: 0 }];
  while (pending.length && budget.available()) {
    const { node, depth, chain = node, chainDepth = depth, alternative } = pending.pop()!;
    // The type is read once: each read is a native call. A method with a syntax error is never listed,
    // so no error node reaches this walk.
    const type = node.type;
    if (skipped(type)) continue;
    // Java has no else node. Keep its range on the alternative statement, then visit that statement.
    if (alternative && type !== 'if_statement') {
      steps.push({ id: randomUUID(), kind: 'else_clause', title: '다른 조건의 분기', depth, evidence: budget.evidence(node) });
      pending.push({ node, depth: depth + 1 });
      continue;
    }
    const description = stepOf(node, type, text);
    if (description) {
      const step: CodeStep = { id: randomUUID(), kind: description.kind,
        title: alternative ? '다른 조건 확인' : description.title, depth, evidence: budget.evidence(node) };
      if (description.detail) step.detail = clip(description.detail);
      steps.push(step);
      if (type === 'if_statement') ifs.push({ step, node, chain });
    }
    const children = node.namedChildren;
    const otherwiseId = type === 'if_statement' ? node.childForFieldName('alternative')?.id : undefined;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      pending.push(otherwiseId !== undefined && child.id === otherwiseId
        ? { node: child, depth: chainDepth + 1, chain, chainDepth, alternative: true }
        : { node: child, depth: description ? depth + 1 : depth });
    }
  }

  const firstStepWithin = (from: number, to: number): string | null =>
    steps.find(step => step.evidence.startUtf16 >= from && step.evidence.endUtf16 <= to)?.id ?? null;
  const firstStepIn = (node: Parser.SyntaxNode | null): string | null =>
    node ? firstStepWithin(node.startIndex, node.endIndex) : null;
  for (const { step, node, chain } of ifs) {
    const list = chain.parent;
    const after = list && statementLists.has(list.type) ? firstStepWithin(chain.endIndex, list.endIndex) : null;
    const alternative = node.childForFieldName('alternative');
    step.branch = {
      whenTrue: firstStepIn(node.childForFieldName('consequence')) ?? after,
      whenFalse: alternative ? firstStepIn(alternative) : after,
    };
  }
  return steps;
}

/** The nearest named type declaration around a method, or null inside an anonymous class (including an enum constant's body). */
function ownerOf(method: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let owner = method.parent; owner; owner = owner.parent) {
    if (types.has(owner.type)) return owner;
    if (owner.type === 'object_creation_expression' || owner.type === 'enum_constant') return null;
  }
  return null;
}

/** Java methods and constructors only; declarations inside their bodies are collected separately. */
export function collectJava(root: Parser.SyntaxNode, text: string, result: Analysis, budget: AnalysisBudget): void {
  const pending = [root];
  while (pending.length && !budget.limited && budget.available()) {
    const node = pending.pop()!;
    if (node.nextNamedSibling) pending.push(node.nextNamedSibling);
    if (node.isError || node.isMissing) continue;
    const type = node.type;
    const body = methods.has(type) && !node.hasError ? node.childForFieldName('body') : null;
    if (body) {
      if (result.symbols.length >= MAX_SYMBOLS) { budget.limited = true; break; }
      const owner = ownerOf(node);
      const ownerName = owner?.childForFieldName('name')?.text;
      const name = clip(node.childForFieldName('name')!.text);
      const parameters = type === 'compact_constructor_declaration' && owner?.type === 'record_declaration'
        ? owner.childForFieldName('parameters') : node.childForFieldName('parameters');
      result.symbols.push({
        id: randomUUID(), name: ownerName ? `${clip(ownerName)}.${name}` : name, kind: type,
        params: clip(parameters?.text ?? ''), exported: false, evidence: budget.evidence(node),
        steps: stepsFor(body, text, budget), complexity: measureBody(body, text, javaRules),
      });
    }
    // A method with a syntax error is skipped whole, as before: declarations inside it are not listed.
    if (methods.has(type) && node.hasError) continue;
    if (node.firstNamedChild) pending.push(node.firstNamedChild);
  }
}
