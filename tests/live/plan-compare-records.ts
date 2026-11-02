import { performance } from 'node:perf_hooks';
import { maskSecrets } from '../../src/core/ai/secrets';
import type { StageRequest, StageResponse } from '../../src/core/ai/workflow';
import { GEMINI_MODEL } from '../../src/shared/ai';
import { planCompareReviewSchema } from '../../src/shared/plan-compare';

export interface PlanCompareStageRecord {
  stage: StageRequest['stage'];
  provider: StageRequest['provider'];
  requestedModel: string | null;
  reportedModel: string | null;
  timeoutMs: number;
  elapsedMs: number;
  // Receiving a response does not mean the workflow or the test accepted it.
  outcome: 'returned' | 'failed';
  review?: { status: 'schema-invalid' } | { status: 'valid'; accepted: boolean; issues: string[] };
}

/** Only for the non-secret live fixture. Never record prompts, drafts, stdio or arbitrary errors. */
export async function recordPlanCompareStage(request: StageRequest, run: (request: StageRequest) => Promise<StageResponse>,
  records: PlanCompareStageRecord[]): Promise<StageResponse> {
  const started = performance.now();
  let response: StageResponse | undefined;
  try {
    response = await run(request);
    return response;
  } finally {
    const record: PlanCompareStageRecord = {
      stage: request.stage, provider: request.provider,
      requestedModel: request.provider === 'antigravity' ? GEMINI_MODEL : null,
      reportedModel: response?.reportedModel ?? null,
      timeoutMs: request.timeoutMs ?? 120_000, elapsedMs: Math.round(performance.now() - started),
      outcome: response ? 'returned' : 'failed',
    };
    if (request.stage === 'reviewing' && response) {
      const review = planCompareReviewSchema.safeParse(response.value);
      record.review = review.success
        ? { status: 'valid', accepted: review.data.accepted, issues: review.data.issues.map(issue => maskSecrets(issue).text) }
        : { status: 'schema-invalid' };
    }
    records.push(record);
  }
}
