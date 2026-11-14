/** The languages the analyzer parses. Every other listed file is shown as plain text. */
export type CodeLanguage = 'typescript' | 'javascript' | 'python' | 'java';
export type SourceLanguage = CodeLanguage | 'text';

/**
 * A file's language by its last extension, ignoring case: .ts .tsx .mts .cts are TypeScript,
 * .js .jsx .mjs .cjs are JavaScript, .py is Python, .java is Java, anything else is text.
 */
export function languageOf(relativePath: string): SourceLanguage {
  const extension = relativePath.match(/\.[^./\\]*$/)?.[0].toLowerCase() ?? '';
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript';
  if (extension === '.py') return 'python';
  if (extension === '.java') return 'java';
  return 'text';
}

/** Whether calls and values can be searched in this language (calls.ts rejects the others). */
export function findsCalls(language: SourceLanguage): boolean {
  return language === 'typescript' || language === 'javascript' || language === 'python';
}
