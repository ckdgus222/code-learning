import { AppError } from '../../shared/errors';
import { maskPrivateKeys, maskSecrets, PRIVATE_KEY_MASK, SECRET_MASK, secretWord } from './secrets';

const unsupported = () => new AppError('NOT_ALLOWED', 'Properties의 이어쓰기나 이스케이프를 확인하지 못해 AI로 보내지 않았어요.');
const space = (char: string) => char === ' ' || char === '\t' || char === '\f';

/** Decode only the Properties escape rules; never resolve environment values or execute configuration. */
function decoded(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\\') { result += text[index]; continue; }
    const escaped = text[++index];
    if (escaped === undefined) throw unsupported();
    if (escaped !== 'u') {
      result += ({ t: '\t', r: '\r', n: '\n', f: '\f' } as Record<string, string>)[escaped] ?? escaped;
      continue;
    }
    const hex = text.slice(index + 1, index + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw unsupported();
    result += String.fromCharCode(Number.parseInt(hex, 16));
    index += 4;
  }
  return result;
}

function propertyOf(line: string): { key: string; value: string } {
  let end = 0;
  while (end < line.length) {
    if (line[end] === '\\') { end += 2; continue; }
    if (space(line[end]) || line[end] === '=' || line[end] === ':') break;
    end++;
  }
  let value = end;
  while (space(line[value])) value++;
  if (line[value] === '=' || line[value] === ':') value++;
  while (space(line[value])) value++;
  return { key: decoded(line.slice(0, end)), value: decoded(line.slice(value)) };
}

function continued(line: string): boolean {
  let at = line.length;
  while (at > 0 && line[at - 1] === '\\') at--;
  return (line.length - at) % 2 === 1;
}

/** Whole-file AI copies only. Mask a secret entry as a unit while retaining every original line ending. */
export function maskPropertiesSecrets(text: string, shouldStop: () => boolean = () => false): { text: string; count: number } {
  const check = () => { if (shouldStop()) throw new AppError('CANCELLED', 'AI 자료 준비를 취소했어요.'); };
  check();
  const endings = text.match(/\r\n|\r|\n/g) ?? [];
  // Protect complete PEM ranges before an individual entry can remove their opening marker.
  const privateKeys = maskPrivateKeys(text.replace(/\r\n|\r/g, '\n'));
  const lines = privateKeys.text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const output: string[] = [];
  let count = privateKeys.count, index = 0;
  while (index < lines.length) {
    check();
    const start = index;
    const first = lines[index].replace(index === 0 ? /^\uFEFF?[ \t\f]*/ : /^[ \t\f]*/, '');
    if (/^[#!\r\n]|^$/.test(first)) { output.push(lines[index++]); continue; }
    const parts: string[] = [];
    while (index < lines.length) {
      check();
      const raw = index === start ? first : lines[index].replace(/^[ \t\f]*/, '');
      const line = raw.replace(/(?:\r\n|\r|\n)$/, '');
      index++;
      if (!continued(line)) { parts.push(line); break; }
      if (index >= lines.length) throw unsupported();
      parts.push(line.slice(0, -1));
    }
    const logical = parts.join('');
    // An escaped PEM marker was invisible to the physical-range pass; do not risk leaving its following lines.
    if (maskPrivateKeys(decoded(logical)).count) throw unsupported();
    const { key, value } = propertyOf(logical);
    const raw = lines.slice(start, index).join('');
    const hidden = value.length > 0 && (secretWord.test(key.normalize('NFKC').replace(/[\s._-]/g, '')) || maskSecrets(value).count > 0);
    output.push(hidden ? raw.replace(/[^\r\n]+/g, SECRET_MASK) : raw);
    count += Number(hidden && !value.includes(PRIVATE_KEY_MASK));
  }
  check();
  // The generic masker preserves LF counts; restore the original physical separators after it runs.
  const generic = maskSecrets(output.join(''));
  const restored = generic.text.split('\n').map((line, index) => {
    // A removed line between CR and LF needs a marker, or the two distinct endings would merge into CRLF.
    if (!line && endings[index - 1] === '\r' && endings[index] === '\n') line = SECRET_MASK;
    return line + (endings[index] ?? '');
  }).join('');
  return { text: restored, count: count + generic.count };
}
