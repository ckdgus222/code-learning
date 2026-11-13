import { describe, expect, it } from 'vitest';
import { maskPythonSecrets } from '../src/core/ai/python-secrets';
import { SECRET_MASK } from '../src/core/ai/secrets';

describe('Python file explanation secret literals', () => {
  it('masks normalized attribute names and chained assignments once', () => {
    const source = 'config.ｐａｓｓｗｏｒｄ = alternate = r"synthetic-hidden-value"\n';
    const result = maskPythonSecrets(source);
    expect(result.count).toBe(1);
    expect(result.text).not.toContain('synthetic-hidden-value');
    expect(result.text).toContain(SECRET_MASK);
  });
  it('masks a secret f-string without evaluating the interpolation', () => {
    const source = 'password = f"synthetic-prefix-{lookup()}"\n';
    const result = maskPythonSecrets(source);
    expect(result.text).not.toContain('synthetic-prefix');
    expect(result.text).not.toContain('lookup');
    expect(result.count).toBe(1);
  });
  it('preserves ordinary literals and calls that contain no known secret shape', () => {
    const source = 'title = r"ordinary heading"\nvalue = """help\ntext"""\npassword = read_value()\n';
    expect(maskPythonSecrets(source)).toEqual({ text: source, count: 0 });
  });
  it.each([true, false])('stops before parsing or during the bounded walk: immediate=%s', immediate => {
    let checks = 0;
    expect(() => maskPythonSecrets('value = 0\n'.repeat(500), () => immediate || ++checks > 2))
      .toThrow(expect.objectContaining({ code: 'CANCELLED' }));
  });
  it('refuses to send a file when its secret scan cannot finish within the node budget', () => {
    const source = 'x=0\n'.repeat(5_001);
    expect(Buffer.byteLength(source)).toBeLessThan(32 * 1024);
    expect(() => maskPythonSecrets(source)).toThrow(expect.objectContaining({ code: 'LIMIT' }));
  });
});
