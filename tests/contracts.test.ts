import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { learningMarkSchema, saveLearningMarkSchema, storedLearningMarkSchema, learningSpotSchema, saveLearningSpotSchema, sourceRequestSchema, evidenceRequestSchema, featureFlowsRequestSchema, featureFlowRequestSchema, projectRequestSchema } from '../src/shared/contracts';
describe.each([
  ['source', sourceRequestSchema, 'fileId'],
  ['evidence', evidenceRequestSchema, 'evidenceId'],
  ['feature flows', featureFlowsRequestSchema, 'routesId'],
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


it('rejects renderer-supplied batch limits, revisions, routes and file data', () => {
  const input = { projectId: randomUUID(), routesId: randomUUID() };
  for (const extra of [{ routes: [] }, { files: [] }, { revision: 0 }, { timeoutMs: 0 }, { limits: {} }, { routeIndex: 0 }]) {
    expect(featureFlowsRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  }
});


describe('saved learning location boundary', () => {
  const spot = { version: 1, topic: { name: '', original: 'start', origin: 'start',
    start: { relativePath: 'src/start.ts', fileHash: 'a'.repeat(64), functionName: 'start', startUtf16: 0 } },
    place: { view: 'function', relativePath: 'src/start.ts', fileHash: 'b'.repeat(64),
      symbol: { name: 'start', startUtf16: 0, step: 0 }, range: { startUtf16: 0, endUtf16: 10, startLine: 1, endLine: 2 } } };
  it('accepts long analyzer names and file paths without keeping opaque file IDs', () => {
    expect(learningSpotSchema.parse(spot)).toEqual(spot);
    const name = 'f'.repeat(200);
    for (const original of [name, `src/${name}.ts`]) {
      expect(learningSpotSchema.safeParse({ ...spot, topic: { ...spot.topic, name: original, original,
        start: { ...spot.topic.start, functionName: name, relativePath: `src/${name}.ts` } } }).success).toBe(true);
    }
    expect(saveLearningSpotSchema.safeParse({ projectId: randomUUID(), spot: null }).success).toBe(true);
    expect(saveLearningSpotSchema.safeParse({ projectId: randomUUID(), spot, path: '/tmp' }).success).toBe(false);
  });
  it('rejects unknown fields at every level and unsupported versions', () => {
    const invalid = [
      { ...spot, extra: true }, { ...spot, version: 2 }, { ...spot, topic: { ...spot.topic, anchor: 'old' } },
      { ...spot, topic: { ...spot.topic, start: { ...spot.topic.start, fileId: randomUUID() } } },
      { ...spot, place: { ...spot.place, fileId: randomUUID() } },
      { ...spot, place: { ...spot.place, symbol: { ...spot.place.symbol, extra: true } } },
      { ...spot, place: { ...spot.place, range: { ...spot.place.range, extra: true } } },
    ];
    for (const value of invalid) expect(learningSpotSchema.safeParse(value).success).toBe(false);
  });
  it('rejects malformed hashes, reversed ranges and out-of-contract offsets', () => {
    for (const fileHash of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(learningSpotSchema.safeParse({ ...spot, topic: { ...spot.topic, start: { ...spot.topic.start, fileHash } } }).success).toBe(false);
      expect(learningSpotSchema.safeParse({ ...spot, place: { ...spot.place, fileHash } }).success).toBe(false);
    }
    for (const range of [
      { ...spot.place.range, startUtf16: 11 }, { ...spot.place.range, startLine: 3 },
      { ...spot.place.range, startUtf16: -1 }, { ...spot.place.range, endUtf16: 100_000_001 },
      { ...spot.place.range, startLine: 0 }, { ...spot.place.range, endLine: 10_000_001 },
    ]) expect(learningSpotSchema.safeParse({ ...spot, place: { ...spot.place, range } }).success).toBe(false);
  });
});

describe('function learning marks boundary', () => {
  const mark = { relativePath: 'src/read.ts', name: 'read', occurrence: 0, state: 'understood', note: '', codeHash: 'a'.repeat(64) };
  it('accepts 500 characters, the maximum occurrence and a separate stored timestamp', () => {
    expect(learningMarkSchema.parse(mark)).toEqual(mark);
    expect(learningMarkSchema.safeParse({ ...mark, note: 'a'.repeat(500), occurrence: 100_000 }).success).toBe(true);
    expect(learningMarkSchema.safeParse({ ...mark, state: null }).success).toBe(true);
    const stored = { ...mark, savedAt: '2026-10-29' };
    expect(storedLearningMarkSchema.parse(stored)).toEqual(stored);
    expect(learningMarkSchema.safeParse(stored).success).toBe(false);
    expect(storedLearningMarkSchema.safeParse(mark).success).toBe(false);
  });
  it.each([
    { note: 'a'.repeat(501) }, { extra: true }, { codeHash: 'bad' }, { codeHash: 'A'.repeat(64) },
    { occurrence: -1 }, { occurrence: .5 }, { occurrence: 100_001 }, { occurrence: '0' },
    { state: 'done' }, { relativePath: '' }, { name: '' },
  ])('rejects invalid mark fields: %j', fields => {
    expect(learningMarkSchema.safeParse({ ...mark, ...fields }).success).toBe(false);
    expect(saveLearningMarkSchema.safeParse({ projectId: randomUUID(), mark: { ...mark, ...fields } }).success).toBe(false);
  });
  it('rejects unknown request fields and invalid project IDs', () => {
    expect(saveLearningMarkSchema.safeParse({ projectId: randomUUID(), mark }).success).toBe(true);
    expect(saveLearningMarkSchema.safeParse({ projectId: 'bad', mark }).success).toBe(false);
    expect(saveLearningMarkSchema.safeParse({ projectId: randomUUID(), mark, path: '/tmp' }).success).toBe(false);
  });
});
