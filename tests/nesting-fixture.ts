/** Sources nested far beyond the nesting weight limit: name, file extension, text. */
export const deepSources: [string, string, string][] = [
  ['TS array', 'ts', `${'['.repeat(5000)}0${']'.repeat(5000)}`],
  ['TS additions', 'ts', Array(5000).fill('a').join(' + ')],
  ['TS calls', 'ts', `${'f('.repeat(5000)}0${')'.repeat(5000)}`],
  ['TS blocks', 'ts', `${'if (a) {'.repeat(5000)}run();${'}'.repeat(5000)}`],
  ['TSX elements', 'tsx', `${'<div>'.repeat(5000)}text${'</div>'.repeat(5000)}`],
  ['TS arrows', 'ts', `${'() => '.repeat(5000)}0`],
  ['Python list', 'py', `${'['.repeat(5000)}0${']'.repeat(5000)}`],
  ['Python attributes', 'py', `a${'.b'.repeat(5000)}`],
  ['Python calls', 'py', `${'f('.repeat(5000)}0${')'.repeat(5000)}`],
  // The deep part comes last: the whole tree is weighed, not only its start.
  ['deep calls after 80000 statements', 'ts', `${'"";'.repeat(80_000)}${'f('.repeat(5000)}0${')'.repeat(5000)}`],
];
