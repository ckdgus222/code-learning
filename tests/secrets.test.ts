import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { maskSecrets, PRIVATE_KEY_MASK, SECRET_MASK } from '../src/core/ai/secrets';

// Test values are made-up strings in the shape of real secrets; none of them is a real credential.
describe('masking secrets before code is sent to an AI provider', () => {
  it.each([
    ['AWS access key ID', 'const id = AKIAABCDEFGHIJKLMNOP;'],
    ['GitHub token', `fetch(url, { headers: { Authorization: ghp_${'a'.repeat(36)} } })`],
    ['GitHub fine-grained token', `use(github_pat_${'b'.repeat(30)})`],
    ['sk- key', `client(sk-proj-${'c'.repeat(24)})`],
    ['Google API key', `load(AIza${'d'.repeat(35)})`],
    ['Slack token', 'post(xoxb-1234567890-abcdef)'],
    ['Stripe key', `charge(sk_live_${'e'.repeat(20)})`],
    ['JWT', `send(eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.${'f'.repeat(20)})`],
  ])('masks a %s', (_name, source) => {
    const result = maskSecrets(source);
    expect(result.count).toBe(1);
    expect(result.text).toContain(SECRET_MASK);
  });

  it('masks a whole private key block, closed or not, and keeps the line count', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----';
    const source = `const key = \`\n${block}\n\`;\nuse(key);`;
    const closed = maskSecrets(source);
    expect(closed.text).toBe(`const key = \`\n${PRIVATE_KEY_MASK}\n\n\n\n\`;\nuse(key);`);
    expect(closed.text.split('\n')).toHaveLength(source.split('\n').length);
    const open = maskSecrets('a\n-----BEGIN PRIVATE KEY-----\nMIIE\nrest');
    expect(open.text).toBe(`a\n${PRIVATE_KEY_MASK}\n\n`);
    expect(open.count).toBe(1);
  });

  it('masks only the password inside a connection string', () => {
    expect(maskSecrets('const url = "postgres://app:s3cr3tPass@db.local:5432/shop";').text)
      .toBe(`const url = "postgres://app:${SECRET_MASK}@db.local:5432/shop";`);
  });

  it('masks string values assigned to secret-named keys and secret config lines', () => {
    const source = [
      'const password = "hunter22";',
      "config.apiKey = 'abcd1234';",
      '{ "client_secret": "zyxw9876" }',
      'ACCESS_TOKEN=abc123xyz',
      'db_password: hunter2',
      'const short = { token: "abc" };',
    ].join('\n');
    const result = maskSecrets(source);
    expect(result.text.split('\n')).toEqual([
      `const password = "${SECRET_MASK}";`,
      `config.apiKey = '${SECRET_MASK}';`,
      `{ "client_secret": "${SECRET_MASK}" }`,
      `ACCESS_TOKEN=${SECRET_MASK}`,
      `db_password: ${SECRET_MASK}`,
      'const short = { token: "abc" };',
    ]);
    expect(result.count).toBe(5);
  });

  it('leaves ordinary code that only mentions secrets alone', () => {
    const source = [
      'const token = getToken();',
      'if (password.length < 8) return false;',
      'token = req.headers["authorization"];',
      'const task = "sk-short";',
      'import { tokenizer } from "./lexer";',
      'const url = "https://example.com/path";',
      'const secretary = "Kim";',
    ].join('\n');
    expect(maskSecrets(source)).toEqual({ text: source, count: 0 });
  });

  it('keeps every line, blank lines and CRLF included, around masked config lines', () => {
    expect(maskSecrets('password: hunter2\r\nnext: 1\r\n').text).toBe(`password: ${SECRET_MASK}\r\nnext: 1\r\n`);
    const source = 'password: hunter2\n\n\nconst x = 1;';
    const masked = maskSecrets(source).text;
    expect(masked).toBe(`password: ${SECRET_MASK}\n\n\nconst x = 1;`);
    expect(masked.split('\n')).toHaveLength(4);
  });

  it('masks a whole string even with other quotes, escaped quotes or line breaks inside', () => {
    expect(maskSecrets(`const password = "it's-a-secret";`).text).toBe(`const password = "${SECRET_MASK}";`);
    expect(maskSecrets('const password = "abc\\"defghij";').text).toBe(`const password = "${SECRET_MASK}";`);
    expect(maskSecrets("const token = 'say \"hi\" now';").text).toBe(`const token = '${SECRET_MASK}';`);
    const template = 'const secret = `line one\nline two`;\nnext();';
    expect(maskSecrets(template).text).toBe(`const secret = \`${SECRET_MASK}\n\`;\nnext();`);
  });

  it.each(['"', "'"])('masks a %s string continued with a backslash on the next line (LF and CRLF)', quote => {
    for (const newline of ['\n', '\r\n']) {
      const source = `const password = ${quote}abc\\${newline}defgh${quote};${newline}next();`;
      const result = maskSecrets(source);
      expect(result.count).toBe(1);
      expect(result.text).not.toContain('defgh');
      expect(result.text.split('\n')).toHaveLength(source.split('\n').length);
    }
  });

  it('counts a value once when two rules match it', () => {
    const result = maskSecrets(`const token = "ghp_${'a'.repeat(36)}";\nconst dbPassword = "postgres://app:pw12@db/x";`);
    expect(result.text).toBe(`const token = "${SECRET_MASK}";\nconst dbPassword = "${SECRET_MASK}";`);
    expect(result.count).toBe(2);
    const tokenAsPassword = maskSecrets(`const url = "https://bot:ghp_${'b'.repeat(36)}@github.com/repo";`);
    expect(tokenAsPassword).toEqual({ text: `const url = "https://bot:${SECRET_MASK}@github.com/repo";`, count: 1 });
  });

  it('stays fast on crafted 32 KiB inputs, measured in a separate process with a time limit', () => {
    // A runaway pattern would block this process for good, so the timing runs in a child that is killed.
    const script = `
      const { maskSecrets } = await import(${JSON.stringify(pathToFileURL(path.resolve('src/core/ai/secrets.ts')).href)});
      const inputs = {
        identifier: 'a'.repeat(32 * 1024), words: 'token'.repeat(6500), dotted: 'a.'.repeat(16 * 1024),
        dashed: 'eyJ-'.repeat(8 * 1024), url: 'postgres://' + 'a:'.repeat(16 * 1024),
        unclosed: 'password = "' + 'a'.repeat(32 * 1024), escapes: 'token = "' + '\\\\"'.repeat(16 * 1024),
        continued: 'password = "' + '\\\\\\r\\n'.repeat(10 * 1024),
      };
      const times = {};
      for (const [name, input] of Object.entries(inputs)) {
        const started = performance.now(); maskSecrets(input); times[name] = performance.now() - started;
      }
      console.log(JSON.stringify(times));`;
    const output = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { timeout: 10_000, encoding: 'utf8' });
    for (const [name, ms] of Object.entries(JSON.parse(output) as Record<string, number>)) {
      expect(ms, name).toBeLessThan(250);
    }
  });

  it('accepts a known over-masking: any 4+ character string under a secret-like name', () => {
    // Masking a harmless value costs some explanation detail; missing a real secret costs more.
    expect(maskSecrets('const tokenType = "Bearer";').text).toBe(`const tokenType = "${SECRET_MASK}";`);
  });
});
