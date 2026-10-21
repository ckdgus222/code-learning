import { randomUUID } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { FileChunk } from '../../shared/ai';
import { AppError } from '../../shared/errors';
import { codeFile, parse } from './project-map';
import { functionName, functionTypes } from './syntax';

/** Only top-level statements and direct class members; nested callbacks stay inside their chunk. */
export function splitFileChunks(text: string, relativePath: string, fileId: string, fileHash: string, parsedRoot?: Parser.SyntaxNode) {
  if (!codeFile.test(relativePath)) throw new AppError('UNSUPPORTED', 'TS/JS 파일만 설명할 수 있어요.');
  const root = parsedRoot ?? parse(text, relativePath);
  const chunks: FileChunk[] = [];
  let total = 0;
  const add = (start: number, end: number, kind: FileChunk['kind'], name: string | null, fn: Parser.SyntaxNode | null = null) => {
    total++;
    if (chunks.length === 80) return;
    const startLine = text.slice(0, start).split('\n').length;
    const endLine = Math.max(startLine, text.slice(0, end).split('\n').length - (text[end - 1] === '\n' ? 1 : 0));
    chunks.push({ id: randomUUID(), kind, name: name ?? `${startLine}–${endLine}행 문장`,
      range: { fileId, fileHash, startUtf16: start, endUtf16: end, startLine, endLine },
      functionRange: fn ? { startUtf16: fn.startIndex, endUtf16: fn.endIndex } : null });
  };
  const directFunction = (node: Parser.SyntaxNode): Parser.SyntaxNode | null => {
    if (functionTypes.has(node.type) && node.childForFieldName('body')) return node;
    if (['lexical_declaration', 'variable_declaration'].includes(node.type)) {
      const declarations = node.namedChildren.filter(child => child.type === 'variable_declarator');
      if (declarations.length !== 1) return null;
      const value = declarations[0].childForFieldName('value');
      return value && functionTypes.has(value.type) ? value : null;
    }
    const value = node.childForFieldName('value');
    return ['public_field_definition', 'field_definition'].includes(node.type) && value && functionTypes.has(value.type) ? value : null;
  };
  const pending: { imports: { start: number; end: number } | null } = { imports: null };
  const flushImports = () => {
    if (!pending.imports) return;
    const lines = text.slice(pending.imports.start, pending.imports.end).split('\n').length;
    add(pending.imports.start, pending.imports.end, 'imports', `가져오기 (${lines}줄)`);
    pending.imports = null;
  };
  for (const outer of root.namedChildren) {
    if (outer.type === 'comment' || outer.type === 'hash_bang_line') { flushImports(); continue; }
    const node = outer.type === 'export_statement' ? outer.childForFieldName('declaration') ?? outer.childForFieldName('value') ?? outer : outer;
    if (['class_declaration', 'abstract_class_declaration', 'class'].includes(node.type)) {
      flushImports();
      const body = node.childForFieldName('body');
      if (!body || node.isError || node.isMissing) continue;
      const className = node.childForFieldName('name')?.text;
      if (!(outer.id !== node.id && outer.children.some(child => child.id !== node.id && child.hasError)) &&
          !node.children.some(child => child.id !== body.id && child.hasError)) {
        add(outer.startIndex, body.startIndex, 'class', className ? `클래스 ${className}` : null);
      }
      // TS decorators on methods can be siblings in class_body; fields may contain their own decorators.
      let decorator: Parser.SyntaxNode | null = null;
      for (const member of body.namedChildren) {
        if (member.type === 'comment') continue;
        if (member.type === 'decorator') { decorator ??= member; continue; }
        if (!member.hasError && !member.isMissing && !decorator?.hasError && !member.nextSibling?.isError) {
          const fn = directFunction(member);
          const field = ['public_field_definition', 'field_definition'].includes(member.type);
          const name = field ? `${className ? `${className}.` : ''}${member.childForFieldName('name')?.text ?? '?'} 필드`
            : fn ? functionName(fn) : null;
          add(decorator?.startIndex ?? member.startIndex, member.endIndex, field ? 'field' : fn ? 'function' : 'statement', name, fn);
        }
        decorator = null;
      }
      continue;
    }
    if (outer.hasError || outer.isMissing) { flushImports(); continue; }
    if (outer.type === 'import_statement' || (outer.type === 'export_statement' && outer.childForFieldName('source'))) {
      if (pending.imports && /\r?\n\s*\r?\n/.test(text.slice(pending.imports.end, outer.startIndex))) flushImports();
      pending.imports = { start: pending.imports?.start ?? outer.startIndex, end: outer.endIndex };
      continue;
    }
    flushImports();
    const fn = directFunction(node);
    const variable = ['lexical_declaration', 'variable_declaration'].includes(node.type);
    let name = fn ? functionName(fn) : null;
    if (variable) {
      const declarations = node.namedChildren.filter(child => child.type === 'variable_declarator');
      const bindings: string[] = [];
      const patterns = declarations.map(child => child.childForFieldName('name')).reverse();
      while (patterns.length) {
        const pattern = patterns.pop();
        if (!pattern) continue;
        switch (pattern.type) {
          case 'identifier': case 'shorthand_property_identifier_pattern': bindings.push(pattern.text); break;
          case 'pair_pattern': patterns.push(pattern.childForFieldName('value')); break;
          case 'assignment_pattern': case 'object_assignment_pattern': patterns.push(pattern.childForFieldName('left')); break;
          case 'rest_pattern': case 'object_pattern': case 'array_pattern': patterns.push(...pattern.namedChildren.toReversed()); break;
        }
      }
      name = `${node.children[0].text} ${bindings[0] ?? '?'}${bindings.length > 1 ? ` 외 ${bindings.length - 1}개` : ''}`;
    }
    add(outer.startIndex, outer.endIndex, variable ? 'variable' : fn ? 'function' : 'statement', name, fn);
  }
  flushImports();
  const limitations: string[] = [];
  if (root.hasError) limitations.push('구문 오류가 있어 일부 코드는 나누지 않았어요');
  if (total > 80) limitations.push(`덩어리 ${total - 80}개는 설명하지 않았어요`);
  return { chunks, limitations };
}
