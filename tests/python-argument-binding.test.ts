import { describe, expect, it } from 'vitest';
import { pythonArgumentAt } from '../src/renderer/python-arguments';
import type { CallSite, NameValue } from '../src/shared/contracts';
const evidence = { fileId: 'file', fileHash: 'hash', startUtf16: 0, endUtf16: 1, startLine: 1, endLine: 1, text: '10' };
function parameter(name: string, parameterKind: NameValue['parameterKind'] = 'positional-or-keyword', index: number | null = 0, fallback = false): NameValue {
  return { group: 'parameter', name, role: 'parameter', shape: parameterKind?.startsWith('var-') ? 'rest' : 'plain',
    declaredAt: { ...evidence, text: name }, type: null, fixed: null,
    initial: fallback ? { ...evidence, kind: 'default' } : null, assignments: [], index, parameterKind,
    outerFunction: null, unknown: null, external: null, notes: [] };
}
const arg = (text: string, keyword?: string) => ({ text, spread: false, ...(keyword === undefined ? {} : { keyword }) });
const site = (args: CallSite['args']): CallSite => ({ ...evidence, text: 'f(...)', args, inTest: false, inFunction: null });
function resolve(parameters: NameValue[], args: CallSite['args'], selected = 0, limited = false) {
  return pythonArgumentAt(site(args), parameters[selected], parameters, limited);
}
function allUnknown(parameters: NameValue[], args: CallSite['args'], limited = false) {
  for (let index = 0; index < parameters.length; index++) {
    const result = resolve(parameters, args, index, limited);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') expect(result.reason).toBeTruthy();
  }
}

describe('Python whole-call argument correspondence', () => {
  it('maps written positional expressions without evaluating them', () => {
    expect(resolve([parameter('x')], [arg('2 + 3')])).toEqual({ kind: 'given', text: '2 + 3' });
  });
  it('maps keyword expressions independently of their source order', () => {
    const parameters = [parameter('a'), parameter('b', 'positional-or-keyword', 1)];
    expect(resolve(parameters, [arg('right()', 'b'), arg('left()', 'a')])).toEqual({ kind: 'given', text: 'left()' });
    expect(resolve(parameters, [arg('right()', 'b'), arg('left()', 'a')], 1)).toEqual({ kind: 'given', text: 'right()' });
  });
  it('maps NFKC-equivalent keyword names while preserving the written argument', () => {
    expect(resolve([parameter('ｘ')], [arg('SOURCE', 'x')])).toEqual({ kind: 'given', text: 'SOURCE' });
  });
  it('uses a default only after every required argument is present', () => {
    const parameters = [parameter('a'), parameter('b', 'keyword-only', null, true)];
    expect(resolve(parameters, [arg('1')], 1)).toEqual({ kind: 'default' });
  });
  it('prefers an explicit keyword over a written default', () => {
    expect(resolve([parameter('a', 'keyword-only', null, true)], [arg('None', 'a')])).toEqual({ kind: 'given', text: 'None' });
  });
  it('allows positional-only spelling as a separate key accepted by kwargs', () => {
    const parameters = [parameter('a', 'positional-only'), parameter('kw', 'var-keyword', null)];
    expect(resolve(parameters, [arg('1'), arg('2', 'a')])).toEqual({ kind: 'given', text: '1' });
  });
  it('does not let kwargs satisfy a missing positional-only parameter', () => {
    allUnknown([parameter('a', 'positional-only'), parameter('kw', 'var-keyword', null)], [arg('2', 'a')]);
  });
  it('permits extra positionals when args is declared but does not claim its runtime tuple', () => {
    const parameters = [parameter('a'), parameter('args', 'var-positional', null)];
    expect(resolve(parameters, [arg('1'), arg('2')])).toEqual({ kind: 'given', text: '1' });
    expect(resolve(parameters, [arg('1'), arg('2')], 1).kind).toBe('unknown');
  });
  it('treats the rest parameter name as a kwargs key rather than an ordinary target', () => {
    const parameters = [parameter('args', 'var-positional', null), parameter('flag', 'keyword-only', null, true), parameter('kw', 'var-keyword', null)];
    expect(resolve(parameters, [arg('1', 'args')], 1)).toEqual({ kind: 'default' });
    expect(resolve(parameters, [arg('1', 'args')], 0).kind).toBe('unknown');
    expect(resolve(parameters, [arg('1', 'args')], 2).kind).toBe('unknown');
  });
  it.each([
    ['missing required keyword', [arg('1')]],
    ['duplicate positional and keyword', [arg('1'), arg('2', 'a'), arg('3', 'b')]],
    ['duplicate keyword', [arg('1', 'a'), arg('2', 'a'), arg('3', 'b')]],
    ['excess positional', [arg('1'), arg('2'), arg('3', 'b')]],
    ['unknown keyword', [arg('1'), arg('2', 'b'), arg('3', 'other')]],
    ['positional after keyword', [arg('2', 'b'), arg('1')]],
    ['spread argument', [{ text: 'items', spread: true }, arg('2', 'b')]],
    ['unknown argument list', null],
  ] as const)('withholds every parameter for %s', (_, args) => {
    allUnknown([parameter('a'), parameter('b', 'keyword-only', null), parameter('optional', 'keyword-only', null, true)], args === null ? null : [...args]);
  });
  it('rejects NFKC-equivalent duplicate keyword spellings', () => {
    allUnknown([parameter('x')], [arg('1', 'x'), arg('2', 'ｘ')]);
  });
  it('rejects a keyword supplied for positional-only without kwargs', () => {
    allUnknown([parameter('a', 'positional-only')], [arg('1'), arg('2', 'a')]);
  });
  it('withholds correspondence when results were limited', () => {
    allUnknown([parameter('a')], [arg('1')], true);
  });
  it('withholds every parameter if one lacks classification', () => {
    const missing = parameter('b', 'keyword-only', null, true);
    delete missing.parameterKind;
    allUnknown([parameter('a'), missing], [arg('1')]);
  });
  it('withholds every parameter if one declaration is unknown', () => {
    allUnknown([parameter('a'), { ...parameter('b', 'keyword-only', null, true), unknown: 'unclear declaration' }], [arg('1')]);
  });
  it('rejects inconsistent positional indexes rather than guessing by array order', () => {
    allUnknown([parameter('a', 'positional-or-keyword', 1)], [arg('1')]);
  });
  it('does not bind an enclosing-function parameter as an own parameter', () => {
    const outer = { ...parameter('a'), group: 'outside' as const };
    expect(pythonArgumentAt(site([arg('1')]), outer, [parameter('a')], false).kind).toBe('unknown');
  });
});
