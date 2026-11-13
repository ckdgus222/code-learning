import { describe, expect, it } from 'vitest';
import { newScope, readFacts, reassigned, type AssignmentFact, type FileFacts, type Scope } from '../src/core/analysis/names';

const file = { id: 'file', relativePath: 'writes.ts', size: 4 };
const baseFacts = readFacts(file, 'f++;', 'hash', 200_000);
const node = baseFacts.assignments[0].node;
const makeFacts = (program: Scope, assignments: AssignmentFact[]): FileFacts => ({ ...baseFacts, program, assignments });

// The original implementation is an independent reference for the indexed lookup.
function originalReassigned(facts: FileFacts, name: string, scope: Scope): boolean {
  return facts.assignments.some(assignment => {
    if (assignment.name !== name) return false;
    for (let inner: Scope | null = assignment.scope; inner; inner = inner.parent) if (inner === scope) return true;
    return false;
  });
}

describe('reassigned scope index', () => {
  it('includes the scope and its descendants, but not siblings, ancestors or other roots', () => {
    const root = newScope(null), otherRoot = newScope(null);
    const left = newScope(root), right = newScope(root), empty = newScope(root);
    const grandchild = newScope(left), belowWrite = newScope(grandchild);
    const facts = makeFacts(root, [
      { name: 'x', scope: grandchild, node },
      { name: 'y', scope: right, node },
      { name: 'x', scope: left, node },
      { name: 'z', scope: otherRoot, node },
      { name: 'globalName', scope: root, node, viaGlobal: true },
    ]);
    for (const scope of [root, left, grandchild]) expect(reassigned(facts, 'x', scope)).toBe(true);
    for (const scope of [right, empty, belowWrite, otherRoot, newScope(null)]) expect(reassigned(facts, 'x', scope)).toBe(false);
    expect(reassigned(facts, 'y', root)).toBe(true);
    expect(reassigned(facts, 'y', right)).toBe(true);
    expect(reassigned(facts, 'y', left)).toBe(false);
    expect(reassigned(facts, 'z', otherRoot)).toBe(true);
    expect(reassigned(facts, 'z', root)).toBe(false);
    expect(reassigned(facts, 'missing', root)).toBe(false);
    expect(reassigned(facts, 'globalName', root)).toBe(true);
    expect(reassigned(facts, 'globalName', left)).toBe(false);
  });

  it('matches the original lookup on 200 seeded scope trees', () => {
    let seed = 114;
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 0x1_0000_0000 * limit);
    };
    for (let tree = 0; tree < 200; tree++) {
      const scopes = [newScope(null)];
      const scopeCount = 1 + random(60);
      for (let i = 1; i < scopeCount; i++) scopes.push(newScope(scopes[random(i)]));
      const names = Array.from({ length: 1 + random(6) }, (_, i) => `name${i}`);
      const assignments = Array.from({ length: random(81) }, () => ({
        name: names[random(names.length)], scope: scopes[random(scopes.length)], node,
      }));
      const facts = makeFacts(scopes[0], assignments);
      const queries = [...scopes, newScope(scopes[0]), newScope(null)];
      const pairs = queries.flatMap(scope => [...names, 'missing'].map(name => ({ scope, name })));
      expect(pairs.map(({ scope, name }) => reassigned(facts, name, scope))).toEqual(
        pairs.map(({ scope, name }) => originalReassigned(facts, name, scope)),
      );
    }
  });

  it('matches parsed block, function, class and parameter scopes, including global writes', () => {
    const text = `let outer = 0;
function run(parameter = (outer = 1)) {
  let local = 0;
  { let block = 0; block++; local = block; visit(block); }
  function nested() { parameter++; visit(parameter); }
  class Box {
    value = outer++;
    method(argument = (parameter = 2)) { argument++; local++; visit(argument); }
  }
  visit(local);
}
globalThis.globalName = 1;`;
    const facts = readFacts({ ...file, size: text.length }, text, 'hash', 200_000);
    expect(facts.complete).toBe(true);
    expect(facts.assignments.some(assignment => assignment.viaGlobal)).toBe(true);
    const scopes = new Set([facts.program, ...facts.variables.map(item => item.scope), ...facts.calls.map(item => item.scope),
      ...facts.assignments.map(item => item.scope)]);
    expect(scopes.size).toBeGreaterThan(5);
    const names = ['outer', 'parameter', 'local', 'block', 'argument', 'globalName', 'missing'];
    const pairs = [...scopes].flatMap(scope => names.map(name => ({ scope, name })));
    expect(pairs.map(({ scope, name }) => reassigned(facts, name, scope))).toEqual(
      pairs.map(({ scope, name }) => originalReassigned(facts, name, scope)),
    );
  });

  it('numbers a chain of 5000 scopes without recursion', () => {
    const root = newScope(null);
    const scopes = [root];
    for (let i = 0; i < 5000; i++) scopes.push(newScope(scopes[scopes.length - 1]));
    const facts = makeFacts(root, [{ name: 'x', scope: scopes[scopes.length - 1], node }]);
    expect(scopes.every(scope => reassigned(facts, 'x', scope))).toBe(true);
    expect(reassigned(facts, 'x', newScope(root))).toBe(false);
  });

  it('keeps repeated answers stable and indexes separate for different facts', () => {
    const root = newScope(null), left = newScope(root), right = newScope(root);
    const first = makeFacts(root, [{ name: 'x', scope: left, node }]);
    const second = makeFacts(root, [{ name: 'x', scope: right, node }]);
    for (let i = 0; i < 2; i++) {
      expect(reassigned(first, 'x', left)).toBe(true);
      expect(reassigned(first, 'x', right)).toBe(false);
      expect(reassigned(second, 'x', left)).toBe(false);
      expect(reassigned(second, 'x', right)).toBe(true);
    }
  });

  it.each(['empty', 'skipped'])('returns false for an %s assignment list', kind => {
    const text = kind === 'empty' ? 'let x; x();' : `${'['.repeat(5000)}0${']'.repeat(5000)}`;
    const facts = readFacts({ ...file, size: text.length }, text, 'hash', 200_000);
    expect(facts.complete).toBe(kind === 'empty');
    expect(facts.assignments).toEqual([]);
    expect(reassigned(facts, 'x', facts.program)).toBe(false);
    expect(reassigned(facts, 'x', newScope(facts.program))).toBe(false);
  });
});

describe('reassigned index work bounds', () => {
  it.each(['same write scope', 'sibling write scopes', 'different query scopes'])(
    'reads names and parents only while building the index: %s', kind => {
      let parentReads = 0, nameReads = 0, scopeCount = 0;
      const countedScope = (parent: Scope | null): Scope => {
        scopeCount++;
        return { get parent() { parentReads++; return parent; }, names: new Map() };
      };
      const root = countedScope(null);
      let deepest = root;
      for (let i = 0; i < 50; i++) deepest = countedScope(deepest);
      const count = 2000;
      const assignments = Array.from({ length: count }, () => ({
        get name() { nameReads++; return 'f'; },
        scope: kind === 'sibling write scopes' ? countedScope(deepest) : deepest,
        node,
      }));
      const queries = Array.from({ length: count }, () => kind === 'different query scopes' ? countedScope(root) : root);
      const facts = makeFacts(root, assignments);
      for (const scope of queries) expect(reassigned(facts, 'f', scope)).toBe(kind !== 'different query scopes');
      const bound = 10 * (scopeCount + count);
      expect(nameReads).toBeLessThanOrEqual(bound);
      expect(parentReads).toBeLessThanOrEqual(bound);
    }, 30_000,
  );
});
