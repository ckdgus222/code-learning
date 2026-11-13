import type Parser from 'tree-sitter';
import type { NameValue } from '../../shared/contracts';
import { normalize } from './python-imports';

export interface PythonParameter {
  parameterKind: NonNullable<NameValue['parameterKind']>;
  parameterIndex: number | null;
}
const content = (node: Parser.SyntaxNode) => node.namedChildren.filter(child => !['comment', 'line_continuation'].includes(child.type));

/** Classify the whole header before exposing any argument correspondence. */
export function pythonParametersOf(parameters: Parser.SyntaxNode | null, inClass = false): Map<number, PythonParameter> | null {
  if (!parameters || parameters.hasError) return null;
  const rows: { node: Parser.SyntaxNode; kind: PythonParameter['parameterKind'] }[] = [];
  const names = new Set<string>();
  let slash = false, keywords = false, bareStar = false, keywordOnly = false, restKeywords = false, positionalDefault = false;
  for (const parameter of content(parameters)) {
    if (restKeywords) return null;
    if (parameter.type === 'positional_separator') {
      if (slash || keywords || !rows.length) return null;
      slash = true;
      for (const row of rows) row.kind = 'positional-only';
      continue;
    }
    if (parameter.type === 'keyword_separator') {
      if (keywords) return null;
      keywords = true;
      bareStar = true;
      continue;
    }
    let pattern = parameter.childForFieldName('name') ?? parameter;
    if (parameter.type === 'typed_parameter') {
      const candidates = content(parameter).filter(child => child.id !== parameter.childForFieldName('type')?.id);
      if (candidates.length !== 1) return null;
      pattern = candidates[0];
    }
    const positionalRest = pattern.type === 'list_splat_pattern';
    const keywordRest = pattern.type === 'dictionary_splat_pattern';
    const name = positionalRest || keywordRest ? content(pattern)[0] : pattern;
    if (name?.type !== 'identifier' || !name.text || names.has(normalize(name.text))) return null;
    const normalized = normalize(name.text);
    if (normalized === '__debug__') return null;
    if (inClass && (normalized === '__class__' || normalized.startsWith('__') && !normalized.endsWith('__') || /^_[^_].*__/.test(normalized))) return null;
    names.add(normalize(name.text));
    const hasDefault = !!parameter.childForFieldName('value');
    let kind: PythonParameter['parameterKind'] = keywords ? 'keyword-only' : 'positional-or-keyword';
    if (positionalRest || keywordRest) {
      if (hasDefault || content(pattern).length !== 1 || positionalRest && keywords) return null;
      kind = positionalRest ? 'var-positional' : 'var-keyword';
      keywords = true;
      restKeywords = keywordRest;
    } else if (keywords) keywordOnly = true;
    else {
      if (positionalDefault && !hasDefault) return null;
      positionalDefault ||= hasDefault;
    }
    rows.push({ node: parameter, kind });
  }
  if (bareStar && !keywordOnly) return null;
  let index = 0;
  return new Map(rows.map(row => [row.node.id, { parameterKind: row.kind,
    parameterIndex: row.kind === 'positional-only' || row.kind === 'positional-or-keyword' ? index++ : null }]));
}
