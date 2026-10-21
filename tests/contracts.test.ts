import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sourceRequestSchema, evidenceRequestSchema, featureFlowRequestSchema, projectRequestSchema } from '../src/shared/contracts';
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

describe('feature flow request boundary', () => {
  it('accepts only the project, saved routes ID and nonnegative integer index', () => {
    const input = { projectId: randomUUID(), routesId: randomUUID(), routeIndex: 0 };
    expect(featureFlowRequestSchema.parse(input)).toEqual(input);
    for (const routeIndex of [-1, .5, Infinity, NaN, '0', null]) expect(featureFlowRequestSchema.safeParse({ ...input, routeIndex }).success).toBe(false);
    for (const routesId of ['', 'wrong', '../file', null]) expect(featureFlowRequestSchema.safeParse({ ...input, routesId }).success).toBe(false);
    for (const extra of [{ path: '/etc/passwd' }, { startUtf16: 0 }, { handler: {} }]) {
      expect(featureFlowRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
      expect(projectRequestSchema.safeParse({ projectId: input.projectId, ...extra }).success).toBe(false);
    }
  });
});
