import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '../src/core/ai/secrets';
import { maskPropertiesSecrets } from '../src/core/ai/properties-secrets';
import { AppError } from '../src/shared/errors';

const separators = (text: string) => text.match(/\r\n|\r|\n/g) ?? [];
function masked(source: string, secrets: string[], count = 1) {
  const result = maskPropertiesSecrets(source);
  expect(result.text).toContain(SECRET_MASK);
  for (const secret of secrets) expect(result.text).not.toContain(secret);
  expect(result.count).toBe(count);
  expect(separators(result.text)).toEqual(separators(source));
  return result;
}
function blocked(source: string) {
  try {
    maskPropertiesSecrets(source);
    expect.fail('Invalid properties input must be blocked before sending');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'NOT_ALLOWED' });
  }
}

describe('Java properties logical-entry secret masking', () => {
  it.each([' ', '\t', '\f', '=', ':'])('recognizes the properties separator %j', delimiter => {
    const source = `password${delimiter}firstSecret secondSecret\nnormal = keep exactly\n`;
    expect(masked(source, ['firstSecret', 'secondSecret']).text).toContain('normal = keep exactly\n');
  });
  it('handles whitespace before an optional separator without losing the rest of the value', () => {
    masked(' \tapi_key \f: \tfirstSecret = secondSecret : thirdSecret\r\n', ['firstSecret', 'secondSecret', 'thirdSecret']);
  });
  it.each(['\n', '\r\n', '\r'])('masks odd-backslash continued values across %j', newline => {
    const source = 'password=firstSecret\\' + newline + '\t  secondSecret\\' + newline + '\fthirdSecret' + newline + 'normal=keep' + newline;
    expect(masked(source, ['firstSecret', 'secondSecret', 'thirdSecret']).text).toContain('normal=keep' + newline);
  });
  it('recognizes continuation after three backslashes and preserves mixed line endings', () => {
    const source = 'password=firstSecret' + '\\'.repeat(3) + '\r\n  secondSecret\\\rthirdSecret\nnormal=keep\r\n';
    expect(masked(source, ['firstSecret', 'secondSecret', 'thirdSecret']).text).toContain('normal=keep\r\n');
  });
  it('keeps an even-backslash line independent from the next property', () => {
    const ordinary = 'folder=C:' + '\\'.repeat(2);
    const result = masked(ordinary + '\npassword=hiddenSecret\nnormal=keep\n', ['hiddenSecret']);
    expect(result.text).toContain(ordinary + '\n');
    expect(result.text).toContain('normal=keep\n');
  });
  it.each(['pass\\u0077ord', 'pass\\word', 'database\\:password', 'database\\=password', 'pass\\\n \tword'])(
    'decodes an escaped or continued secret key: %s', key => {
      expect(masked(key + '=hiddenSecret\nnormal=keep\n', ['hiddenSecret']).text).toContain('normal=keep\n');
    });
  it('does not reinterpret decoded separators inside a key as physical delimiters', () => {
    masked('db\\u003apassword=hiddenSecret\n', ['hiddenSecret']);
  });
  it('recognizes dotted secret keys and a leading UTF-8 BOM', () => {
    masked('\uFEFFapi.key=firstSecret secondSecret\n', ['firstSecret', 'secondSecret']);
  });
  it.each(['\\u0073k-' + 'a'.repeat(24), 'postgre\\u0073://app:connectionSecret@db/x'])(
    'checks decoded credential-shaped values under ordinary keys: %s', value => {
      masked('setting=' + value + '\nnormal=keep\n', [value]);
    });
  it('leaves comments ending in a backslash independent of the following secret property', () => {
    const comment = '# comment\\\r\n! another comment\\\n';
    const result = masked(comment + 'password=hiddenSecret\rnormal=keep\n', ['hiddenSecret']);
    expect(result.text.startsWith(comment)).toBe(true);
    expect(result.text).toContain('normal=keep\n');
  });
  it('does not treat a continuation line starting with # as a fresh comment', () => {
    masked('password=firstSecret\\\n#secondSecret\nnormal=keep\n', ['firstSecret', 'secondSecret']);
  });
  it('preserves ordinary properties, escaped delimiters and literal comment-looking values', () => {
    const source = '# comment\r\n! comment\nname = Alice Example\rpath=C:\\temp\\folder\nkey\\:part=value\\=part\ncolor=#123456\n';
    expect(maskPropertiesSecrets(source)).toEqual({ text: source, count: 0 });
  });
  it.each(['pass\\u12word=value', 'name=ordinary\\u00G0value', 'name=ordinary\\u123', 'name=value\\'])(
    'blocks malformed Unicode escapes or dangling EOF escapes: %s', source => { blocked(source); });
  it('does not validate escape-looking text inside comments as a property entry', () => {
    const source = '# \\uBAD malformed comment\n! dangling comment\\';
    expect(maskPropertiesSecrets(source)).toEqual({ text: source, count: 0 });
  });
  it.each([
    '# -----BEGIN PRIVATE KEY-----\r\n# encodedSecret\r# -----END PRIVATE KEY-----\nnormal=keep\r\n',
    '# password = "firstSecret\\\r\n# secondSecret"\r\nnormal=keep\n',
  ])('preserves mixed endings when generic masking also covers comments', source => {
    const result = maskPropertiesSecrets(source);
    expect(result.count).toBeGreaterThan(0);
    expect(result.text).not.toMatch(/encodedSecret|firstSecret|secondSecret/);
    expect(separators(result.text)).toEqual(separators(source));
    expect(result.text).toContain('normal=keep');
  });
  it.each(['blob', 'password'])('protects raw PEM bodies under %s before masking individual entries', key => {
    for (const newline of ['\n', '\r\n', '\r']) {
      for (const closed of [false, true]) {
        const source = key + '=-----BEGIN PRIVATE KEY-----' + newline + 'PRIVATE_BODY_MUST_NOT_LEAVE' + newline
          + (closed ? '-----END PRIVATE KEY-----' + newline + 'normal=keep' + newline : 'UNFINISHED_BODY_MUST_NOT_LEAVE');
        const result = maskPropertiesSecrets(source);
        expect(result.text).not.toContain('BODY_MUST_NOT_LEAVE');
        expect(result.count).toBe(1);
        expect(separators(result.text)).toEqual(separators(source));
        if (closed) expect(result.text).toContain('normal=keep');
      }
    }
  });
  it.each(['blob=', 'password=', ''])('blocks encoded PEM markers whose physical range cannot be established: %s', prefix => {
    blocked(prefix + '-----BEGIN\\u0020PRIVATE\\u0020KEY-----\nENCODED_BODY_MUST_NOT_LEAVE\n-----END PRIVATE KEY-----\n');
  });
  it.each(['-----BEGIN\\u0020PRIVATE KEY-----', '-----BEGIN PRIVATE\\u0020KEY-----', '-----BEGIN\\ PRIVATE KEY-----'])(
    'blocks a PEM marker split across the property key and value: %s', marker => {
      blocked(marker + '\nSPLIT_BODY_MUST_NOT_LEAVE\n-----END PRIVATE KEY-----\n');
    });
  it('observes cancellation before processing properties', () => {
    expect(() => maskPropertiesSecrets('password=hiddenSecret\n', () => true)).toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
  });
  it('observes cancellation while processing a continued property', () => {
    let checks = 0;
    expect(() => maskPropertiesSecrets('password=one\\\n two\\\n three\n', () => ++checks >= 4))
      .toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
    expect(checks).toBe(4);
  });
  it('masks many independent secret entries within 32 KiB without merging or losing lines', () => {
    const count = 1000;
    const source = Array.from({ length: count }, (_, i) => `password${i} hiddenSecret${i}\n`).join('');
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(32 * 1024);
    const result = maskPropertiesSecrets(source);
    expect(result.count).toBe(count);
    expect(result.text).not.toContain('hiddenSecret');
    expect(separators(result.text)).toEqual(separators(source));
  });
});
