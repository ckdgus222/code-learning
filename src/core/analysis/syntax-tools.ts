import { randomUUID } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { Evidence } from '../../shared/contracts';

// File-wide budgets bound IPC/UI output, including imports and nested functions.
export const MAX_EVIDENCE = 1_000;
export const MAX_SYMBOLS = 200;
export const MAX_VISITED_NODES = 20_000;
// Details travel over IPC once per step, so a long condition or returned value is cut short.
const MAX_DETAIL = 300;
export const clip = (value: string): string => value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL)}…` : value;

/** What a language's walk gets from analyzeSource: the file-wide limits and evidence making. */
export interface AnalysisBudget {
  /** Counts one visited node. False once the evidence or visit limit is reached; the result is then limited. */
  available(): boolean;
  /** A node's range as evidence. Counts toward the evidence limit. */
  evidence(node: Parser.SyntaxNode): Evidence;
  /** True once a limit cut the walk short. A walk also sets it when it stops at MAX_SYMBOLS. */
  limited: boolean;
}

export function createBudget(context: { projectId: string; fileId: string; fileHash: string }): AnalysisBudget {
  let evidenceCount = 0;
  let visitedNodes = 0;
  const budgetAvailable = (): boolean => {
    if (evidenceCount >= MAX_EVIDENCE || visitedNodes >= MAX_VISITED_NODES) {
      budget.limited = true;
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

  const budget: AnalysisBudget = { available: budgetAvailable, evidence, limited: false };
  return budget;
}

/** What differs between languages when measuring a function body. */
export interface MeasureRules {
  /** Statements that add one nesting level around what they hold. */
  nestingTypes: ReadonlySet<string>;
  /** Whether the node under the cursor is not this function's code (a comment, a nested function). */
  skipped(cursor: Parser.TreeCursor): boolean;
  /** Characters that alone do not make a line count as code (`{}` in TS/JS, none in Python). */
  ignoredCharacters: string;
}

/** Code lines and deepest nesting of a function body (plan v2.3 C-1). */
export function measureBody(body: Parser.SyntaxNode, text: string, rules: MeasureRules): { lines: number; depth: number } {
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
      if (rules.skipped(cursor)) {
        // An arrow's body can itself be a function (`() => () => x`); then all of it belongs to that function.
        skipped.push({ start: cursor.startIndex, end: cursor.endIndex, endRow: cursor.endPosition.row });
      } else {
        const elseIf = type === 'if_statement' && outside.at(-1)?.type === 'else_clause';
        const inner = rules.nestingTypes.has(type) && !elseIf ? level + 1 : level;
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
    else if (!rules.ignoredCharacters.includes(character) && !/\s/.test(character) && counted !== row) { lines++; counted = row; }
  }
  return { lines, depth };
}
