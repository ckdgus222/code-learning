import type { CodeStep, CodeSymbol } from '../shared/contracts';

export interface StepMarkerGroup {
  line: number;
  number: number;
  steps: CodeStep[];
}

// Keep the outline's numbering and first step when several steps start on one line.
export function groupStepMarkers(symbol: CodeSymbol | null | undefined): StepMarkerGroup[] {
  const groups = new Map<number, StepMarkerGroup>();
  symbol?.steps.forEach((step, index) => {
    const line = step.evidence.startLine;
    const group = groups.get(line);
    if (group) group.steps.push(step);
    else groups.set(line, { line, number: index + 1, steps: [step] });
  });
  return [...groups.values()].sort((a, b) => a.line - b.line);
}
