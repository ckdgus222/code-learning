export function codeLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function changedLineCounts(before: string, after: string, maxEdits = 1000): { added: number; removed: number } | null {
  const oldLines = codeLines(before), newLines = codeLines(after);
  let start = 0, oldEnd = oldLines.length, newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const n = oldEnd - start, m = newEnd - start;
  if (Math.abs(n - m) > maxEdits) return null;
  const limit = Math.min(maxEdits, n + m);
  const offset = limit + 1;
  // Only the furthest point on each diagonal matters when no edit path is needed.
  const furthest = new Int32Array(2 * limit + 3);
  for (let distance = 0; distance <= limit; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let x = diagonal === -distance || (diagonal !== distance && furthest[index - 1] < furthest[index + 1])
        ? furthest[index + 1] : furthest[index - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && oldLines[start + x] === newLines[start + y]) { x++; y++; }
      if (x >= n && y >= m) return { added: (distance - n + m) / 2, removed: (distance + n - m) / 2 };
      furthest[index] = x;
    }
  }
  return null;
}
