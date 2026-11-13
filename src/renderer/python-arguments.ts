import type { CallSite, NameValue } from '../shared/contracts';

export type PythonArgument = { kind: 'given'; text: string } | { kind: 'default' } | { kind: 'unknown'; reason: string };

/** Match written expressions only after the complete Python call and signature are consistent. */
export function pythonArgumentAt(site: CallSite, selected: NameValue, parameters: readonly NameValue[], limited: boolean): PythonArgument {
  const unknown = (reason: string): PythonArgument => ({ kind: 'unknown', reason });
  if (limited) return unknown('분석 한도에 걸려 전체 매개변수를 확인하지 못했어요.');
  if (!parameters.includes(selected) || selected.group !== 'parameter') return unknown('고른 함수의 매개변수가 아니에요.');
  const names = new Set<string>();
  const positional: NameValue[] = [];
  const keywords = new Map<string, NameValue>();
  let positionalRest = false, keywordRest = false, phase = 0, positionalDefault = false;
  const order = { 'positional-only': 0, 'positional-or-keyword': 1, 'var-positional': 2, 'keyword-only': 3, 'var-keyword': 4 };
  for (const parameter of parameters) {
    const kind = parameter.parameterKind;
    const name = parameter.name.normalize('NFKC');
    if (!kind || parameter.group !== 'parameter' || parameter.role !== 'parameter' || parameter.unknown || parameter.outerFunction
      || !name || name === '__debug__' || names.has(name) || order[kind] < phase || keywordRest) return unknown('매개변수 규칙을 하나로 정하지 못했어요.');
    names.add(name);
    phase = order[kind];
    const isPositional = kind === 'positional-only' || kind === 'positional-or-keyword';
    const isRest = kind === 'var-positional' || kind === 'var-keyword';
    if (parameter.shape !== (isRest ? 'rest' : 'plain') || (isRest && parameter.initial)) return unknown('매개변수 모양을 확정하지 못했어요.');
    if (isPositional) {
      if (parameter.index !== positional.length || positionalDefault && parameter.initial?.kind !== 'default') return unknown('매개변수의 순서나 기본값 규칙을 확정하지 못했어요.');
      positional.push(parameter);
      positionalDefault ||= parameter.initial?.kind === 'default';
    } else if (parameter.index !== null) return unknown('매개변수의 자리를 확정하지 못했어요.');
    if (kind === 'positional-or-keyword' || kind === 'keyword-only') keywords.set(name, parameter);
    if (kind === 'var-positional') {
      if (positionalRest) return unknown('나머지 매개변수가 중복되어 있어요.');
      positionalRest = true;
    }
    keywordRest ||= kind === 'var-keyword';
  }
  if (!site.args || site.args.some(argument => argument.spread)) return unknown('펼침 또는 복잡한 인자의 대응을 정하지 못했어요.');
  const provided = new Map<NameValue, string>();
  const seenKeywords = new Set<string>();
  let position = 0, keywordStarted = false;
  for (const argument of site.args) {
    if (argument.keyword === undefined) {
      if (keywordStarted || position >= positional.length && !positionalRest) return unknown('위치 인자의 순서나 개수가 매개변수와 맞지 않아요.');
      const parameter = positional[position++];
      if (parameter) provided.set(parameter, argument.text);
      continue;
    }
    keywordStarted = true;
    const name = argument.keyword.normalize('NFKC');
    if (name === '__debug__') return unknown('Python에서 인자로 쓸 수 없는 이름이에요.');
    if (!name || seenKeywords.has(name)) return unknown('같은 키워드 인자가 여러 번 적혀 있어요.');
    seenKeywords.add(name);
    const parameter = keywords.get(name);
    if (!parameter && !keywordRest) return unknown('이 키워드를 받을 매개변수가 없어요.');
    if (!parameter) continue;
    if (provided.has(parameter)) return unknown('한 매개변수에 인자가 여러 번 적혀 있어요.');
    provided.set(parameter, argument.text);
  }
  if (parameters.some(parameter => !parameter.parameterKind!.startsWith('var-') && !provided.has(parameter) && parameter.initial?.kind !== 'default')) {
    return unknown('필수 인자가 빠져 있어 호출 전체의 대응을 표시하지 않아요.');
  }
  if (selected.parameterKind!.startsWith('var-')) return unknown('나머지 인자를 모은 실행 값은 계산하지 않아요.');
  return provided.has(selected) ? { kind: 'given', text: provided.get(selected)! } : { kind: 'default' };
}
