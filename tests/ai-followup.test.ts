import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectAiContext } from '../src/core/ai/context';
import { LocalWorkerWorkflow, type StageRequest, type StageResponse } from '../src/core/ai/workflow';
import { readAllowed, scanProject } from '../src/core/project/files';
import { GEMINI_MODEL, type ExplainRequest, type Explanation, type LearningEvent } from '../src/shared/ai';
import type { Evidence, SourceView } from '../src/shared/contracts';

// A01: follow-up questions with the real ProjectAiContext, so the selected whole file gets a new evidence ID on
// every read, as in the app. The fake model sees only its prompt and uses only IDs it finds there;
// nothing here maps an old ID to a new one. No CLI, account or network is used.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

type Habit = 'reread' | 'reuse-old' | 'unknown-id' | 'cite-selection';
async function setup(habit: Habit) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-followup-')));
  roots.push(root);
  await writeFile(path.join(root, 'a.ts'), 'import { helper } from "./b";\nexport const answer = helper();\n');
  await writeFile(path.join(root, 'b.ts'), 'export const helper = () => 42;\n');
  const project = await scanProject(root, randomUUID());
  const file = project.files.find(item => item.relativePath === 'a.ts')!;
  const { text, hash } = await readAllowed(root, file.relativePath);
  const source: SourceView = { projectId: project.id, fileId: file.id, relativePath: file.relativePath, text, hash,
    guide: null, analysis: { language: 'typescript', symbols: [], imports: [], warnings: [] } };
  const evidence: Evidence = { id: randomUUID(), projectId: project.id, fileId: file.id, fileHash: hash,
    startUtf16: 0, endUtf16: text.indexOf('\n'), startLine: 1, endLine: 1 };
  const context = new ProjectAiContext(root, project);
  const events: LearningEvent[] = [];
  const prompts: StageRequest[] = [];
  let draft: Explanation | null = null;
  // The fake model reads the JSON material in its prompt like a real one would.
  const run = async (request: StageRequest): Promise<StageResponse> => {
    prompts.push(request);
    const material = JSON.parse(request.prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
    const followUp = material.history.length > 0;
    const wholeFile = material.files.find((item: { relativePath: string }) => item.relativePath === 'a.ts');
    if (request.stage === 'explaining') {
      const oldId = material.history.at(-1)?.explanation.claims.find((claim: { kind: string }) => claim.kind === 'code')?.evidenceIds[0];
      const cited = habit === 'cite-selection' ? material.evidence.id
        : !followUp || habit === 'reread' ? wholeFile.evidence.id : habit === 'reuse-old' ? oldId : randomUUID();
      draft = { summary: 'helper 값을 씁니다.', steps: [], claims: [{ kind: 'code', text: 'a.ts에서 helper를 호출합니다.', evidenceIds: [cited] }], terms: [], examples: [], unknowns: [] };
      return { reportedModel: GEMINI_MODEL, value: draft };
    }
    return { reportedModel: null, value: { accepted: true, issues: [], explanation: draft } };
  };
  const workflow = new LocalWorkerWorkflow({ capturePlanCompare: async () => { throw new Error('not a plan compare test'); }, revalidatePlanCompare: async () => { throw new Error('not a plan compare test'); }, captureFeatureGuide: async () => { throw new Error('not a feature guide test'); }, revalidateFeatureGuide: async () => { throw new Error('not a feature guide test'); },
    assertReady: () => {}, run, emit: event => events.push(event),
    capture: (_request, signal) => context.capture(source, evidence, 1, signal),
    captureOverview: (request, signal) => context.captureOverview(request.startFileId, 1, signal),
    captureFile: (request, signal) => context.captureFile(request, 1, signal),
    expand: (snapshot, ids, signal) => context.expand(snapshot, ids, signal),
    revalidate: (snapshot, signal) => context.revalidate(snapshot, signal),
  });
  const ask = async (conversationId?: string) => {
    const request: ExplainRequest = { projectId: project.id, evidenceId: evidence.id, expectedFileHash: hash,
      question: conversationId ? 'b.ts는 무엇을 돌려주나요?' : 'answer는 어떻게 정해지나요?', mode: 'codex', consent: true, conversationId };
    const { jobId } = workflow.start(request);
    await new Promise<void>(resolve => { const timer = setInterval(() => {
      if (events.some(event => event.jobId === jobId && event.kind !== 'progress')) { clearInterval(timer); resolve(); }
    }, 5); });
    await new Promise(resolve => setTimeout(resolve, 0));
    return events.find(event => event.jobId === jobId && event.kind !== 'progress')!;
  };
  return { root, context, evidence, prompts, ask };
}
const citedSource = (event: LearningEvent) => {
  if (event.kind !== 'completed') throw new Error(`expected completion, got ${event.kind}`);
  const id = event.result.explanation.claims.find(claim => claim.kind === 'code')!.evidenceIds[0];
  return { id, source: event.result.sources.find(source => source.evidence.id === id) };
};

describe('A01: follow-up questions over the selected whole file, with real evidence IDs', () => {
  it('works when the model receives the selected whole file again: a new ID, a source that resolves, the same question basis', async () => {
    const f = await setup('reread');
    const first = await f.ask();
    const before = citedSource(first);
    expect(before.source?.relativePath).toBe('a.ts');
    if (first.kind !== 'completed') throw new Error('expected completion');
    const next = await f.ask(first.result.conversationId);
    const after = citedSource(next);
    // a.ts was read again and got a new ID; the answer cites the new one and it resolves to a.ts.
    expect(after.id).not.toBe(before.id);
    expect(after.source?.relativePath).toBe('a.ts');
    expect(f.context.lookup(after.id)?.fileId).toBe(before.source?.evidence.fileId);
    // The follow-up still starts from the original selection.
    expect(next.kind === 'completed' && next.result.evidence.id).toBe(f.evidence.id);
    // The history the model saw still holds the old ID as it was: nothing rewrote it.
    const material = JSON.parse(f.prompts.at(-1)!.prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
    expect(material.history[0].explanation.claims[0].evidenceIds).toEqual([before.id]);
    // The model is told those old IDs cannot be cited and that no extra files can be requested.
    expect(f.prompts.at(-1)!.prompt).toContain('history 속 근거 ID 중 지금의 evidence.id나 files의 evidence.id에 없는 것은 이전 답변 때 것이라 이번 답변에 쓸 수 없다');
  });

  it('keeps the selection\'s ID valid in a follow-up, though the earlier answer cited it too', async () => {
    const f = await setup('cite-selection');
    const first = await f.ask();
    if (first.kind !== 'completed') throw new Error('expected completion');
    const next = await f.ask(first.result.conversationId);
    // The same ID is in the history and in the current material, and the answer citing it is accepted.
    const material = JSON.parse(f.prompts.at(-1)!.prompt.split('자료:\n')[1].split('\n과제:\n')[0]);
    expect(material.history[0].explanation.claims[0].evidenceIds).toEqual([f.evidence.id]);
    expect(material.evidence.id).toBe(f.evidence.id);
    expect(next).toMatchObject({ kind: 'completed', result: { evidence: { id: f.evidence.id } } });
  });

  it('refuses a follow-up answer that cites the previous turn\'s ID without reading the file again', async () => {
    const f = await setup('reuse-old');
    const first = await f.ask();
    if (first.kind !== 'completed') throw new Error('expected completion');
    expect(await f.ask(first.result.conversationId)).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
  });

  it('refuses an ID that no material ever offered', async () => {
    const f = await setup('unknown-id');
    const first = await f.ask();
    if (first.kind !== 'completed') throw new Error('expected completion');
    expect(await f.ask(first.result.conversationId)).toMatchObject({ kind: 'failed', error: { code: 'AI_RESPONSE' } });
  });

  it('refuses the follow-up once the selected file changed after the first answer', async () => {
    const f = await setup('reread');
    const first = await f.ask();
    if (first.kind !== 'completed') throw new Error('expected completion');
    await writeFile(path.join(f.root, 'a.ts'), 'export const helper = () => 7;\n');
    expect(await f.ask(first.result.conversationId)).toMatchObject({ kind: 'failed', error: { code: 'CHANGED' } });
  });
});
