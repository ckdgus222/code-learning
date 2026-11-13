import type Parser from 'tree-sitter';
import { parse } from '../analysis/syntax';
import { MAX_VISITED_NODES } from '../analysis/syntax-tools';
import { AppError } from '../../shared/errors';
import { maskSecrets, SECRET_MASK, secretWord } from './secrets';

const namedValues = new Set(['default_parameter', 'typed_default_parameter', 'keyword_argument', 'named_expression']);
function secretLiteral(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const assignment = node.type === 'assignment' || node.type === 'augmented_assignment';
  const named = namedValues.has(node.type);
  if (!assignment && !named && node.type !== 'pair') return null;
  let name = node.childForFieldName(assignment ? 'left' : named ? 'name' : 'key');
  if (name?.type === 'attribute') name = name.childForFieldName('attribute');
  if (name?.type === 'subscript') name = name.childForFieldName('subscript');
  if (!name || !['identifier', 'string', 'concatenated_string'].includes(name.type) || !secretWord.test(name.text.normalize('NFKC'))) return null;
  let value = node.childForFieldName(assignment ? 'right' : 'value');
  // Chained assignments still store their final right-hand value under the secret name.
  while (value?.type === 'assignment' || value?.type === 'parenthesized_expression') {
    value = value.type === 'assignment' ? value.childForFieldName('right') : value.namedChildren.find(child => child.type !== 'comment') ?? null;
  }
  return value?.type === 'string' || value?.type === 'concatenated_string' ? value : null;
}

/** Python literals have prefixes, triple quotes and implicit concatenation that a JS-style quote rule cannot read. */
export function maskPythonSecrets(text: string, shouldStop: () => boolean = () => false): { text: string; count: number } {
  const check = () => { if (shouldStop()) throw new AppError('CANCELLED', '작업을 취소했습니다.'); };
  check();
  const root = parse(text, 'source.py');
  if (!root) throw new AppError('LIMIT', 'Python 비밀값 확인의 분석 한도에 닿아 전송하지 않았어요.');
  const ranges: { start: number; end: number }[] = [];
  const pending = [{ node: root, broken: false }];
  let visited = 0;
  while (pending.length && visited < MAX_VISITED_NODES) {
    if (visited++ % 128 === 0) check();
    const frame = pending.pop()!;
    const { node } = frame;
    const broken = frame.broken || node.isError || node.isMissing;
    if (node.nextNamedSibling) pending.push({ node: node.nextNamedSibling, broken: frame.broken });
    if (node.firstNamedChild) pending.push({ node: node.firstNamedChild, broken });
    if ((broken && ['string', 'string_start', 'string_content'].includes(node.type)) || (node.type === 'string' && node.hasError)) {
      throw new AppError('LIMIT', 'Python 문자열의 범위를 안전하게 확인하지 못해 전송하지 않았어요.');
    }
    const value = secretLiteral(node);
    if (!value) continue;
    ranges.push({ start: value.startIndex, end: value.endIndex });
  }
  check();
  if (pending.length) throw new AppError('LIMIT', 'Python 비밀값 확인의 분석 한도에 닿아 전송하지 않았어요.');
  // Ranges refer only to the original source. Joining once also avoids repeated copies for many literals.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const pieces: string[] = [];
  let end = 0;
  let count = 0;
  for (const range of ranges) {
    if (range.start < end) continue;
    const raw = text.slice(range.start, range.end);
    pieces.push(text.slice(end, range.start), `"${SECRET_MASK}"`, ...raw.match(/\r?\n/g) ?? []);
    end = range.end;
    count++;
  }
  pieces.push(text.slice(end));
  const generic = maskSecrets(pieces.join(''));
  return { text: generic.text, count: count + generic.count };
}
