import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../src/core/analysis/syntax';
import { groupStepMarkers } from '../src/renderer/step-markers';

const analyze = (text: string) => analyzeSource(text, 'sample.ts', {
  projectId: 'project', fileId: 'file', fileHash: 'hash',
}).symbols[0];

describe('code reader step markers', () => {
  it('uses evidence start lines and the outline numbering, including nested steps', () => {
    const symbol = analyze('function run(x) {\n  if (x) {\n    return 1;\n  }\n  return 0;\n}');
    const groups = groupStepMarkers(symbol);
    expect(groups.map(group => [group.line, group.number])).toEqual([[2, 1], [3, 2], [5, 3]]);
    expect(groups.map(group => group.steps)).toEqual(symbol.steps.map(step => [step]));
  });

  it('groups steps on the same line and preserves the first step and later numbering', () => {
    const symbol = analyze('function run(x) {\n  if (x) return 1;\n  return 0;\n}');
    const original = structuredClone(symbol);
    const groups = groupStepMarkers(symbol);
    expect(groups.map(group => [group.line, group.number, group.steps.length])).toEqual([[2, 1, 2], [3, 3, 1]]);
    expect(groups[0].steps).toEqual(symbol.steps.slice(0, 2));
    expect(groups[1].steps).toEqual([symbol.steps[2]]);
    expect(symbol).toEqual(original);
  });

  it('has no markers for a function without steps', () => {
    expect(groupStepMarkers(analyze('function empty() {}'))).toEqual([]);
  });

  it('has no markers without a selected function', () => {
    expect(groupStepMarkers(undefined)).toEqual([]);
    expect(groupStepMarkers(null)).toEqual([]);
  });
});
