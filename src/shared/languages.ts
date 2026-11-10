/** The languages the analyzer parses. Every other listed file is shown as plain text. */
export type CodeLanguage = 'typescript' | 'javascript';
export type SourceLanguage = CodeLanguage | 'text';

/**
 * A file's language by its last extension, ignoring case: .ts .tsx .mts .cts are TypeScript,
 * .js .jsx .mjs .cjs are JavaScript, anything else is text.
 */
export function languageOf(relativePath: string): SourceLanguage {
  const extension = relativePath.match(/\.[^./\\]*$/)?.[0].toLowerCase() ?? '';
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript';
  return 'text';
}
