/**
 * Plan v2.3 C-1 test material. Every function is listed with the code lines and nesting depth counted by
 * hand: cases just under, at and over each limit (60 lines, depth 4), an else-if chain, nested functions.
 */
const steps = (count: number, indent: string) => Array.from({ length: count }, (_, index) => `${indent}step(${index});`).join('\n');

// `run(function later() {` and `});` are two lines of the outer function, so the steps make up the rest.
// The other lines do not count: a comment-only line, a blank line, a block comment, lines of braces only.
const longFunction = (name: string, lines: number) => `function ${name}() {
  // only a comment

  /* a block
     comment */
  {
  }
${steps(lines - 2, '  ')}
  run(function later() {
    step(-1);
  });
}`;

export const complexitySource = [
  longFunction('lines59', 59),
  longFunction('lines60', 60),
  longFunction('lines61', 61),
  `function depth3(items: number[]) {
  if (items.length) {
    for (let i = 0; i < 2; i++) {
      do { i++; } while (i < 1);
    }
  }
  return items;
}`,
  `function depth4(items: number[]) {
  for (const item of items) {
    while (item > 0) {
      try {
        if (item) break;
      } catch {
        return 0;
      }
    }
  }
  return 1;
}`,
  `function depth5(kind: string, items: number[]) {
  switch (kind) {
    case 'a':
      if (items.length) {
        for (const item of items) {
          while (item) {
            try { return item; } finally { items.pop(); }
          }
        }
      }
  }
  return 0;
}`,
  `function grade(score: number) {
  if (score > 90) return 'A';
  else if (score > 80) return 'B';
  else if (score > 70) return 'C';
  else if (score > 60) return 'D';
  else if (score > 50) return 'E';
  else return 'F';
}`,
  `function nestedElse(a: boolean, b: boolean) {
  if (a) {
    return 1;
  } else {
    if (b) return 2;
  }
  return 3;
}`,
  `function outerDepth(list: number[]) {
  if (list.length) {
    for (const x of list) {
      while (x) {
        const inner = (y: number) => {
          if (y) { for (;;) { while (y) { y--; } } }
        };
        inner(x);
        break;
      }
    }
  }
}`,
  `function host() {
  function helper() {
    return 1;
  }
  const big = function bigInner() {
${steps(61, '    ')}
  };
  return big;
}`,
  'function one() { return 1; }',
  `const sum = (a: number, b: number, c: number) =>
  a +
  b +
  c;`,
  `function message() {
  return \`first

last\`;
}`,
].join('\n\n') + '\n';

/** [name, lines, depth] of every function in source order, as the analyzer lists them. */
export const complexityExpected: [string, number, number][] = [
  ['lines59', 59, 0], ['later', 1, 0],
  ['lines60', 60, 0], ['later', 1, 0],
  ['lines61', 61, 0], ['later', 1, 0],
  ['depth3', 4, 3],
  ['depth4', 7, 4],
  ['depth5', 7, 5],
  ['grade', 6, 1],
  ['nestedElse', 5, 2],
  // Measured on their own, each is 3 deep; counted together they would be 6.
  ['outerDepth', 7, 3], ['inner', 1, 3],
  // `function helper() {` and its `}` belong to helper; `const big = …` and `};` are host's.
  ['host', 3, 0], ['helper', 1, 0], ['bigInner', 61, 0],
  ['one', 1, 0],
  ['sum', 3, 0],
  // The blank line inside the template string is white space only.
  ['message', 2, 0],
];

/** The same rules in JavaScript's grammar: for, if, while, switch and try make 5. */
export const legacySource = `function legacy(rows) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]) {
      while (rows[i].next) {
        switch (rows[i].kind) {
          case 1:
            try { rows[i] = rows[i].next; } catch (error) { return error; }
        }
      }
    }
  }
}
`;
export const legacyExpected: [string, number, number][] = [['legacy', 6, 5]];
