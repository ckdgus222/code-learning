export interface MarkdownFence { char: string; length: number }

// A tab counts as four columns; four or more columns of indent make code, not a fence.
const indentOf = (raw: string) => /^[ \t]*/.exec(raw)![0].replace(/\t/g, '    ').length;

export function openMarkdownFence(raw: string): MarkdownFence | null {
  const opening = indentOf(raw) < 4 ? /^(`{3,}|~{3,})/.exec(raw.trim()) : null;
  return opening ? { char: opening[1][0], length: opening[1].length } : null;
}

export function closesMarkdownFence(raw: string, fence: MarkdownFence): boolean {
  const closing = indentOf(raw) < 4 ? /^(`{3,}|~{3,})\s*$/.exec(raw.trim()) : null;
  return !!closing && closing[1][0] === fence.char && closing[1].length >= fence.length;
}
