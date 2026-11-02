// Real plan comparisons through the app runtime, using only the non-secret fixture.
// Excluded from `npm test`; run explicitly with `npm run test:plan-live` after approval.
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { planSections } from '../../src/core/analysis/plan-sections';
import { ProjectAiContext } from '../../src/core/ai/context';
import { capturePlanCompare, revalidatePlanCompare, type PickedPlan } from '../../src/core/ai/plan-compare';
import { LocalAiRuntime } from '../../src/core/ai/runtime';
import { LocalWorkerWorkflow } from '../../src/core/ai/workflow';
import { readStable, scanProject } from '../../src/core/project/files';
import type { LearningEvent } from '../../src/shared/ai';
import type { ProjectMap } from '../../src/shared/contracts';
import { AppError } from '../../src/shared/errors';
import { recordedFailure, rethrown } from './records';
import { recordPlanCompareStage, type PlanCompareStageRecord } from './plan-compare-records';

const appCodexHome = path.join(os.homedir(), 'Library/Application Support/Code Learning/codex-home');
const appAgyHome = path.join(os.homedir(), 'Library/Application Support/Code Learning/agy-home');
const fixture = path.resolve('tests/fixtures/plan-compare');
const records: Record<string, { stages: PlanCompareStageRecord[]; workflowOutcome?: LearningEvent['kind']; elapsedMs?: number;
  failure?: ReturnType<typeof recordedFailure> }> = {};

afterAll(async () => {
  if (!Object.keys(records).length) return;
  await mkdir('test-results', { recursive: true });
  const filename = `test-results/plan-compare-live-${randomUUID()}.json`;
  // Separate files preserve earlier runs. These are workflow diagnostics, not assertion results.
  await writeFile(filename, JSON.stringify({ recordedAt: new Date().toISOString(), fixtureOnly: true, records }, null, 2),
    { flag: 'wx', mode: 0o600 });
  console.log(`Plan comparison diagnostics: ${filename}`);
});

describe('Plan comparison through the app runtime (real account, non-secret fixture)', { concurrent: false, shuffle: false }, () => {
  it.each(['local-worker', 'codex', 'antigravity'] as const)('%s: checks plan B expectations', async mode => {
    const started = performance.now();
    const record = records[mode] = { stages: [] } as typeof records[string];
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'plan-compare-live-')));
    let workflow: LocalWorkerWorkflow | undefined;
    try {
      const root = path.join(base, 'project');
      await cp(fixture, root, { recursive: true });
      // Keep this exclusion in the temporary project, never in the repository fixture.
      await writeFile(path.join(root, '.gitignore'), 'settings.ts\n');
      await cp(path.join(fixture, 'plan.txt'), path.join(base, 'plan.txt'));
      const plan = await readStable(base, 'plan.txt');
      const document: PickedPlan = { documentId: randomUUID(), name: 'plan.txt', path: path.join(base, 'plan.txt'),
        hash: plan.hash, bytes: Buffer.byteLength(plan.text), ...planSections(plan.text) };
      const selection = { documentId: document.documentId, startLine: 1, endLine: 6 };
      const project = await scanProject(root, randomUUID());
      expect(project.files.map(file => file.relativePath), 'settings.ts must not be available to the AI').not.toContain('settings.ts');
      const fileId = (relativePath: string) => {
        const file = project.files.find(file => file.relativePath === relativePath);
        if (!file) throw new AppError('NOT_ALLOWED', `Missing fixture file: ${relativePath}`);
        return file.id;
      };
      const screen = await readStable(root, 'screen.ts');
      const order = await readStable(root, 'order.ts');
      const screenImport = screen.text.split('\n')[0];
      const orderImport = order.text.split('\n')[0];
      // Map construction is outside this test's scope; only these two fixture imports matter.
      const map: ProjectMap = {
        projectId: project.id,
        files: project.files.map(file => ({ id: file.id, relativePath: file.relativePath, folder: '', start: false, entry: false,
          checked: file.relativePath.endsWith('.ts') ? 'full' : 'not-code', reason: null })),
        edges: [{ fromFileId: fileId('screen.ts'), toFileId: fileId('store.ts'), fileHash: screen.hash,
          startUtf16: 0, endUtf16: screenImport.length, startLine: 1, endLine: 1, text: screenImport, specifier: './store', names: ['orders'] }],
        unresolved: [{ fromFileId: fileId('order.ts'), fileHash: order.hash,
          startUtf16: 0, endUtf16: orderImport.length, startLine: 1, endLine: 1, text: orderImport,
          specifier: './settings', reason: 'not-found', candidates: [] }],
        external: [], complexFunctions: [], exports: [], limited: false, notes: [],
        unused: { exports: { candidates: [], unsure: [], notes: [] }, candidates: [], unsure: [], excluded: [], notes: [] },
      };
      const context = new ProjectAiContext(root, project);
      const source = { projectId: project.id, root, context, map: async () => map, restoreMap: async () => map, cancelMap() {} };
      const runtime = new LocalAiRuntime(appCodexHome, appAgyHome);
      const connections = await runtime.checkConnections();
      console.log(`[${mode}] readiness:`, connections.modes.find(item => item.mode === mode));
      const events: LearningEvent[] = [];
      workflow = new LocalWorkerWorkflow({
        assertReady: selectedMode => runtime.assertReady(selectedMode),
        run: async request => {
          try { return await recordPlanCompareStage(request, stage => runtime.run(stage), record.stages); }
          finally { console.log(`[${mode}] stage: ${JSON.stringify(record.stages.at(-1))}`); }
        },
        emit: event => events.push(event),
        capturePlanCompare: (request, signal) => capturePlanCompare(source, document, request.selection, 1, signal),
        revalidatePlanCompare: (snapshot, signal, final) => revalidatePlanCompare(source, snapshot, signal, final),
        expand: (snapshot, ids, signal) => context.expand(snapshot, ids, signal),
        revalidate: (snapshot, signal) => context.revalidate(snapshot, signal),
        capture: async () => { throw new Error('not a question test'); },
        captureOverview: async () => { throw new Error('not an overview test'); },
        captureFile: async () => { throw new Error('not a file test'); },
        captureFeatureGuide: async () => { throw new Error('not a guide test'); },
        revalidateFeatureGuide: async () => { throw new Error('not a guide test'); },
      });
      const { jobId } = workflow.startPlanCompare({ projectId: project.id, selection, mode, consent: true });
      await vi.waitFor(() => expect(events.some(event => event.jobId === jobId && event.kind !== 'progress'),
        `[${mode}] no terminal event within 10 minutes; phases: ${events.filter(event => event.kind === 'progress').map(event => event.phase).join(', ')}`)
        .toBe(true), { timeout: 600_000, interval: 100 });
      const end = events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
      record.workflowOutcome = end.kind;
      if (end.kind === 'failed') throw new AppError(end.error.code, `[${mode}] ${end.error.message}`);
      if (end.kind !== 'plan-compare-completed') throw new AppError('AI_RESPONSE', `[${mode}] unexpected event: ${end.kind}`);

      const result = end.result;
      const paths = new Map(result.files.map(file => [file.id, file.relativePath]));
      const items = result.compare.items.map(item => ({ ...item, files: item.files.map(id => paths.get(id) ?? id) }));
      const unrequested = result.compare.unrequested.map(item => ({ ...item, files: item.files.map(id => paths.get(id) ?? id) }));
      const designMismatches = result.compare.designMismatches.map(item => ({ ...item,
        edge: result.edges.find(edge => edge.index === item.edge) ?? item.edge }));
      // Print before assertions so a differing AI answer remains available for human review.
      console.log(`[${mode}] plan comparison:\n${JSON.stringify({
        structureOnly: result.structureOnly, sent: result.sent, excluded: result.excluded,
        files: result.files.map(file => file.relativePath), read: result.read.map(file => file.relativePath),
        matches: items.filter(item => item.status === 'matches'), differs: items.filter(item => item.status === 'differs'),
        unverified: items.filter(item => item.status === 'unverified'), missing: items.filter(item => item.status === 'missing'),
        unrequested, designMismatches, unknowns: result.compare.unknowns, limitations: result.limitations, models: result.models,
      }, null, 2)}`);

      expect.soft(result.sent, `[${mode}] expected plan lines 1–6`).toEqual([{ startLine: 1, endLine: 6 }]);
      expect.soft(result.files.map(file => file.relativePath), `[${mode}] settings.ts must remain excluded`).not.toContain('settings.ts');
      expect.soft(result.read.map(file => file.relativePath), `[${mode}] settings.ts must not be read`).not.toContain('settings.ts');
      const lineItems = (line: number) => items.filter(item => item.plan.startLine <= line && item.plan.endLine >= line);
      expect.soft(lineItems(6).length, `[${mode}] plan line 6 must be covered by an item`).toBeGreaterThan(0);
      expect.soft(designMismatches.filter(item => item.plan.startLine <= 6 && item.plan.endLine >= 6),
        `[${mode}] plan line 6 must flag the screen.ts → store.ts connection`).toEqual(expect.arrayContaining([
        expect.objectContaining({ edge: expect.objectContaining({ from: 'screen.ts', to: 'store.ts', line: 1 }) }),
      ]));
      if (mode !== 'local-worker') expect.soft(result.review, `[${mode}] expected no independent review`).toBe('AI 대조 없음');
      expect.soft(result.structureOnly, `[${mode}] expected code comparison`).toBe(false);
      expect.soft(unrequested, `[${mode}] expected extra.ts in unrequested`).toEqual(expect.arrayContaining([
        expect.objectContaining({ files: expect.arrayContaining(['extra.ts']) }),
      ]));
      expect.soft(lineItems(2), `[${mode}] plan line 2 must match order.ts`).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'matches', files: expect.arrayContaining(['order.ts']) }),
      ]));
      expect.soft(lineItems(3), `[${mode}] plan line 3 must differ in order.ts with a nonempty difference`).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'differs', files: expect.arrayContaining(['order.ts']), difference: expect.stringMatching(/\S/) }),
      ]));
      expect.soft(lineItems(4), `[${mode}] plan line 4 must be unverified with missingEvidence`).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'unverified', missingEvidence: expect.stringMatching(/\S/) }),
      ]));
      expect.soft(lineItems(5), `[${mode}] plan line 5 must be missing`).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'missing' }),
      ]));
    } catch (error) {
      record.failure = recordedFailure(error);
      console.error(`[${mode}] failed:`, record.failure);
      throw rethrown(error);
    } finally {
      try { await workflow?.close(); }
      finally {
        record.elapsedMs = Math.round(performance.now() - started);
        await rm(base, { recursive: true, force: true });
      }
    }
  }, 660_000);
});
