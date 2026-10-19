import React from 'react';
import { COMPLEXITY_LIMITS } from '../shared/contracts';

type Measure = { lines: number; depth: number };

/** Plan v2.3 C-1: said wherever the signals show, since a signal is a place to look and not a verdict. */
export const COMPLEXITY_NOTE = `표시는 살펴볼 곳이에요. 나쁜 코드라는 판정이 아니에요. 기준: 본문 ${COMPLEXITY_LIMITS.lines}줄 넘음, 중첩 ${COMPLEXITY_LIMITS.depth}단계 넘음.`;
export const overLimit = ({ lines, depth }: Measure) => lines > COMPLEXITY_LIMITS.lines || depth > COMPLEXITY_LIMITS.depth;

export function ComplexityTags({ lines, depth }: Measure) {
  return <>
    {lines > COMPLEXITY_LIMITS.lines && <span className="tag tag--look">긴 함수 · {lines}줄</span>}
    {depth > COMPLEXITY_LIMITS.depth && <span className="tag tag--look">깊은 중첩 · {depth}단계</span>}
  </>;
}
