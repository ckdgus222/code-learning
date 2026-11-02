import type { PlanSection } from '../../shared/plan-compare';
import { maskSecrets } from '../ai/secrets';
import { closesMarkdownFence, openMarkdownFence, type MarkdownFence } from './markdown-fence';

export function planSections(text: string): { lines: number; lineBytes: number[]; sections: PlanSection[] } {
  const lines = text.split('\n');
  const lineBytes = lines.map((line, index) => Buffer.byteLength(line, 'utf8') + (index < lines.length - 1 ? 1 : 0));
  const offsets = [0];
  for (const bytes of lineBytes) offsets.push(offsets.at(-1)! + bytes);
  const sections: PlanSection[] = [];
  const parents: PlanSection[] = [];
  let fence: MarkdownFence | null = null;
  for (const [index, raw] of lines.entries()) {
    if (fence) {
      if (closesMarkdownFence(raw, fence)) fence = null;
      continue;
    }
    fence = openMarkdownFence(raw);
    if (fence) continue;
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(raw.replace(/\r$/, ''));
    if (!heading) continue;
    const level = heading[1].length;
    if (sections.length === 0 && index > 0) {
      sections.push({ id: 's1', title: '(제목 앞 내용)', level: 0, startLine: 1, endLine: index,
        bytes: offsets[index], parentId: null });
    }
    while (parents.length && parents.at(-1)!.level >= level) {
      const previous = parents.pop()!;
      previous.endLine = index;
      previous.bytes = offsets[index] - offsets[previous.startLine - 1];
    }
    const section: PlanSection = { id: `s${index + 1}`, title: maskSecrets(heading[2].trim()).text, level,
      startLine: index + 1, endLine: lines.length, bytes: offsets.at(-1)! - offsets[index], parentId: parents.at(-1)?.id ?? null };
    sections.push(section);
    parents.push(section);
  }
  if (sections.length === 0 && text.length > 0) {
    sections.push({ id: 's1', title: '(제목 앞 내용)', level: 0, startLine: 1, endLine: lines.length,
      bytes: offsets.at(-1)!, parentId: null });
  }
  return { lines: lines.length, lineBytes, sections };
}
