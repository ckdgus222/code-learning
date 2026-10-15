import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sourceRequestSchema, evidenceRequestSchema } from '../src/shared/contracts';
describe.each([
  ['source', sourceRequestSchema, 'fileId'],
  ['evidence', evidenceRequestSchema, 'evidenceId'],
] as const)('%s request boundary', (_name, schema, target) => {
  it('accepts only opaque project and target identifiers', () => {
    const request = { projectId: randomUUID(), [target]: randomUUID() };
    expect(schema.parse(request)).toEqual(request);
    for (const extra of [{ path: '/etc/passwd' }, { root: '/tmp' }, { command: 'echo hi' }]) {
      expect(schema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });
  it('rejects missing, malformed and non-string IDs without coercion', () => {
    for (const invalid of [undefined, null, 1, {}, [], '', '../secret.ts', 'not-a-uuid']) {
      expect(schema.safeParse({ projectId: randomUUID(), [target]: invalid }).success).toBe(false);
      expect(schema.safeParse({ projectId: invalid, [target]: randomUUID() }).success).toBe(false);
    }
    for (const request of [null, [], {}, { projectId: randomUUID() }]) expect(schema.safeParse(request).success).toBe(false);
  });
});
