import {
  DELIBERATION_CALL_COUNT,
  isTerminalStatus,
  validateChiefPosition,
  validateChiefResponse,
  validateFinalBrief,
  type AgentRole,
  type ChiefPosition,
  type ChiefResponse,
  type DeliberationError,
  type DeliberationSession,
  type DeliberationStage,
  type DeliberationSource,
  type FinalOperationalBrief,
  type Scenario,
  type ScenarioStepName
} from '@rescuemesh/shared';
import { extractJsonObject } from '../adapters/prompts.js';
import {
  GeminiClient,
  GeminiError,
  isQuotaExhausted,
  isRetryableGeminiFailure
} from '../adapters/gemini.js';
import { AGENT_ROLES } from '../recommendations.js';
import type { World } from '../world.js';
import { FIXTURE_MODEL, fixtureBrief, fixturePosition, fixtureResponse } from './fixture.js';
import { crossReviewPrompt, initialPrompt, repairPrompt, synthesisPrompt } from './prompts.js';
import { CHIEF_POSITION_SCHEMA, CHIEF_RESPONSE_SCHEMA, FINAL_BRIEF_SCHEMA } from './schemas.js';
import {
  diagnoseReply,
  diagnoseTransport,
  type ReplyDiagnosis
} from '../adapters/gemini-failure.js';

export interface DeliberationLimits {
  /** Hard ceiling on model calls for one session, retries included. */
  maxCalls: number;
  /** Ceiling on reported tokens for one session. */
  maxTokens: number;
  /** Per-call budget; the provider client also has its own. */
  perCallTimeoutMs: number;
  /**
   * How many calls in a round may be in flight at once. Five concurrent calls
   * per round reliably trips provider rate limits, so a round is run in small
   * waves instead. Costs a little wall-clock, avoids losing chiefs to 429s.
   */
  concurrency: number;
  /**
   * Extra attempts after the first, per call. One bounded retry — never a loop.
   * Only transient failures (429/503/500/timeout) are retried; a bad key is not.
   */
  maxRetries: number;
  /**
   * Bounded format-repair attempts per contribution, after a reply arrives
   * but cannot be validated. One, never a loop: a normal run stays at 11
   * calls and a run needing one repair is 12.
   */
  maxRepairs: number;
  /**
   * Backoff before the single retry, applied ONLY to rate-limit-shaped
   * failures (429/503/500). A timeout has already spent its wait, so retrying
   * it immediately is both faster and no less polite to the provider.
   */
  retryBackoffMs: number;
}

export const DELIBERATION_DEFAULTS: DeliberationLimits = {
  // 11 calls plus headroom for one retry each.
  maxCalls: DELIBERATION_CALL_COUNT * 2,
  maxTokens: 120_000,
  perCallTimeoutMs: 45_000,
  concurrency: 3,
  maxRetries: 1,
  maxRepairs: 1,
  retryBackoffMs: 1_200
};

/**
 * Runs `task` over `items` at most `limit` at a time, preserving input order.
 * Deliberately not Promise.all: a burst of five is what trips the rate limit.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await task(item, index);
    }
  });
  await Promise.all(workers);
  return results;
};

const now = () => new Date().toISOString();

/**
 * Runs one deliberation over a FROZEN snapshot.
 *
 * The snapshot is captured once and every one of the eleven calls sees exactly
 * that state, so all three rounds reason about the same world even if the
 * operator changes something mid-flight. If world state moves, the session is
 * marked `stale` and can no longer produce or execute a plan.
 *
 * A failing chief is substituted from the recorded fixture rather than failing
 * the session; the substitution is named and the session ends `degraded`.
 * Retry policy: a transient failure (503/500, or a 429 whose retryDelay is
 * short) may receive at most ONE bounded retry. A daily-quota exhaustion is
 * never retried — it cannot succeed, and on a metered tier it would spend
 * requests the demo still needs. The first daily-quota 429 opens a
 * per-session circuit breaker so every remaining call is skipped and filled
 * from the recorded fixture.
 */
export class DeliberationOrchestrator {
  private readonly sessions = new Map<string, DeliberationSession>();
  /** requestId -> sessionId, so a duplicate Simulate returns the same session. */
  private readonly byRequest = new Map<string, string>();
  /**
   * Revision reached by a session's own plan-proposal command. Producing the
   * plan necessarily advances the revision, and a session must not be reported
   * stale because of the very action it was asked to take.
   */
  private readonly planRevisions = new Map<string, number>();
  private sequence = 0;
  /**
   * Set when the provider reports its daily quota is gone. Every remaining call
   * in the session is then skipped and filled from the fixture: continuing would
   * spend requests that cannot succeed, and on a 20/day free tier those requests
   * are the scarcest thing in the system.
   */
  private readonly quotaOut = new Set<string>();
  /** Most recent raw reply, so a failure can be classified structurally. */
  private lastRawReply = '';

  constructor(
    private readonly world: World,
    private readonly client: GeminiClient | null,
    private readonly limits: DeliberationLimits = DELIBERATION_DEFAULTS
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  get model(): string {
    return this.client?.model ?? FIXTURE_MODEL;
  }

  get(sessionId: string): DeliberationSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return this.withFreshness(session);
  }

  list(): DeliberationSession[] {
    return [...this.sessions.values()].map((session) => this.withFreshness(session));
  }

  /** Reset clears every session: advice about a discarded world is meaningless. */
  clear(): void {
    this.sessions.clear();
    this.byRequest.clear();
    this.planRevisions.clear();
    this.quotaOut.clear();
  }

  /** Records the deterministic plan this session produced. */
  attachPlan(sessionId: string, planId: string | undefined): DeliberationSession | undefined {
    const current = this.sessions.get(sessionId);
    if (!current || !planId) return current ? { ...current } : undefined;
    const updated = { ...current, planId, updatedAt: now() };
    this.sessions.set(sessionId, updated);
    this.planRevisions.set(sessionId, this.world.revision);
    return { ...updated };
  }

  findByRequestId(requestId: string): DeliberationSession | undefined {
    const sessionId = this.byRequest.get(requestId);
    return sessionId ? this.get(sessionId) : undefined;
  }

  /** A completed session whose revision has been overtaken is reported stale. */
  private withFreshness(session: DeliberationSession): DeliberationSession {
    if (session.status !== 'ready' && session.status !== 'degraded') return { ...session };
    if (this.isCurrentFor(session)) return { ...session };
    return { ...session, status: 'stale' };
  }

  /** True while world state is still what this session analyzed. */
  isCurrentFor(session: DeliberationSession): boolean {
    if (session.scenarioRevision === this.world.revision) return true;
    return this.planRevisions.get(session.sessionId) === this.world.revision;
  }

  /**
   * Starts a deliberation. Returns as soon as the session exists so the UI can
   * poll for progress rather than holding one long request.
   */
  start(options: {
    disaster: string;
    step?: ScenarioStepName;
    requestId?: string;
  }): DeliberationSession {
    if (options.requestId) {
      const existing = this.findByRequestId(options.requestId);
      if (existing) return existing;
    }

    const snapshot = this.world.scenario;
    const sessionId = `sim-${(this.sequence += 1)}-r${snapshot.revision}`;
    const session: DeliberationSession = {
      sessionId,
      scenarioRevision: snapshot.revision,
      ...(options.step ? { scenarioStep: options.step } : {}),
      disaster: options.disaster,
      status: 'triggered',
      createdAt: now(),
      updatedAt: now(),
      initialPositions: [],
      crossReview: [],
      source: this.client
        ? { provider: 'gemini', model: this.client.model, degraded: false }
        : {
            provider: 'scripted',
            model: FIXTURE_MODEL,
            degraded: false,
            warning: 'No Gemini credential configured; this is a recorded deliberation.'
          },
      errors: [],
      usage: { calls: 0, latencyMs: 0, hasUnreportedUsage: false }
    };
    this.sessions.set(sessionId, session);
    if (options.requestId) this.byRequest.set(options.requestId, sessionId);

    // Fire and forget: progress is read through GET, not by holding the request.
    void this.run(sessionId, snapshot);
    return { ...session };
  }

  private patch(sessionId: string, change: Partial<DeliberationSession>): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    this.sessions.set(sessionId, { ...current, ...change, updatedAt: now() });
  }

  private note(sessionId: string, error: DeliberationError): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    this.sessions.set(sessionId, {
      ...current,
      errors: [...current.errors, error],
      updatedAt: now()
    });
  }

  private budgetLeft(sessionId: string): boolean {
    const current = this.sessions.get(sessionId);
    if (!current) return false;
    if (current.usage.calls >= this.limits.maxCalls) return false;
    return (current.usage.totalTokens ?? 0) < this.limits.maxTokens;
  }

  /**
   * One attempt plus at most `maxRetries` more, and only for transient
   * failures. Never an unbounded loop, and every attempt counts against budget.
   */
  private async call(
    sessionId: string,
    stage: DeliberationStage,
    prompt: { system: string; user: string },
    responseSchema?: object
  ): Promise<Record<string, unknown>> {
    if (this.quotaOut.has(sessionId)) {
      throw new GeminiError(
        'http',
        'Provider daily quota exhausted; remaining calls skipped',
        undefined,
        429
      );
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.limits.maxRetries; attempt += 1) {
      if (attempt > 0) {
        if (!isRetryableGeminiFailure(lastError)) break;
        const alreadyWaited = lastError instanceof GeminiError && lastError.stage === 'timeout';
        if (!alreadyWaited) {
          await new Promise((resolve) => setTimeout(resolve, this.limits.retryBackoffMs));
        }
      }
      try {
        return await this.attemptCall(sessionId, stage, prompt, responseSchema);
      } catch (error: unknown) {
        lastError = error;
        if (isQuotaExhausted(error)) {
          // Stop the whole session's remaining calls, not just this one.
          this.quotaOut.add(sessionId);
          break;
        }
        if (!isRetryableGeminiFailure(error)) break;
      }
    }
    throw lastError;
  }

  private async attemptCall(
    sessionId: string,
    stage: DeliberationStage,
    prompt: { system: string; user: string },
    responseSchema?: object
  ): Promise<Record<string, unknown>> {
    if (!this.client) throw new GeminiError('transport', 'No Gemini client configured');
    if (!this.budgetLeft(sessionId)) {
      throw new GeminiError('transport', 'Deliberation call or token budget exhausted');
    }
    const startedAt = Date.now();
    try {
      const text = await this.client.generateJson(prompt.system, prompt.user, responseSchema);
      this.lastRawReply = text;
      return extractJsonObject(text, GeminiError);
    } finally {
      const current = this.sessions.get(sessionId);
      if (current) {
        this.sessions.set(sessionId, {
          ...current,
          usage: {
            ...current.usage,
            calls: current.usage.calls + 1,
            latencyMs: current.usage.latencyMs + (Date.now() - startedAt),
            // The generateContent client does not surface usage figures today.
            hasUnreportedUsage: true
          },
          updatedAt: now()
        });
      }
      void stage;
    }
  }

  /**
   * Classifies why a contribution failed. Truncation is detected from the reply
   * itself, because finishReason has been observed NOT to report it.
   */
  private diagnose(error: unknown): ReplyDiagnosis {
    if (error instanceof GeminiError) {
      if (error.stage === 'shape') {
        return diagnoseReply(this.lastRawReply, {
          ...(this.client?.lastFinishReason ? { finishReason: this.client.lastFinishReason } : {})
        });
      }
      return diagnoseTransport(error.stage, error.status, isQuotaExhausted(error));
    }
    return { fault: 'transport', summary: 'Unexpected failure.', repairable: false };
  }

  /**
   * One bounded format-repair attempt. Only for a reply that arrived and could
   * not be validated — never for auth, quota, timeout or a blocked prompt,
   * where a second call cannot help and only spends quota.
   */
  private async repair<T>(
    sessionId: string,
    stage: DeliberationStage,
    role: AgentRole,
    snapshot: Scenario,
    kind: 'initial' | 'review' | 'synthesis',
    schema: object,
    diagnosis: ReplyDiagnosis,
    validate: (raw: Record<string, unknown>) => { ok: boolean; value?: T; reason?: string }
  ): Promise<T | undefined> {
    if (!diagnosis.repairable || this.limits.maxRepairs < 1) return undefined;
    try {
      const raw = await this.call(
        sessionId,
        stage,
        repairPrompt(role, snapshot, kind, diagnosis.summary),
        schema
      );
      const validated = validate(raw);
      return validated.ok ? validated.value : undefined;
    } catch {
      return undefined;
    }
  }

  private async run(sessionId: string, snapshot: Scenario): Promise<void> {
    let degraded = !this.client;

    // ── Round 1: five independent positions, concurrently ────────────────────
    this.patch(sessionId, { status: 'initial_analysis' });
    const positions = await mapWithConcurrency(
      AGENT_ROLES,
      this.limits.concurrency,
      async (role): Promise<ChiefPosition> => {
        if (!this.client) return { ...fixturePosition(role), substituted: true };
        try {
          const raw = await this.call(
            sessionId,
            'initial_analysis',
            initialPrompt(role, snapshot),
            CHIEF_POSITION_SCHEMA
          );
          const validated = validateChiefPosition(role, raw);
          if (!validated.ok || !validated.value) {
            throw new GeminiError('shape', validated.reason ?? 'position failed validation');
          }
          return validated.value;
        } catch (error: unknown) {
          const diagnosis = this.diagnose(error);
          this.note(sessionId, describe(error, 'initial_analysis', role, diagnosis));
          const repaired = await this.repair(
            sessionId,
            'initial_analysis',
            role,
            snapshot,
            'initial',
            CHIEF_POSITION_SCHEMA,
            diagnosis,
            (raw) => validateChiefPosition(role, raw)
          );
          if (repaired) return repaired;
          degraded = true;
          return { ...fixturePosition(role), substituted: true };
        }
      }
    );
    this.patch(sessionId, { initialPositions: positions });

    if (this.isStale(sessionId)) return;

    // ── Round 2: cross-review, using the VALIDATED positions ─────────────────
    this.patch(sessionId, { status: 'cross_review' });
    const responses = await mapWithConcurrency(
      AGENT_ROLES,
      this.limits.concurrency,
      async (role): Promise<ChiefResponse> => {
        if (!this.client) return { ...fixtureResponse(role), substituted: true };
        try {
          const raw = await this.call(
            sessionId,
            'cross_review',
            crossReviewPrompt(role, snapshot, positions),
            CHIEF_RESPONSE_SCHEMA
          );
          const validated = validateChiefResponse(role, raw);
          if (!validated.ok || !validated.value) {
            throw new GeminiError('shape', validated.reason ?? 'response failed validation');
          }
          return validated.value;
        } catch (error: unknown) {
          const diagnosis = this.diagnose(error);
          this.note(sessionId, describe(error, 'cross_review', role, diagnosis));
          const repaired = await this.repair(
            sessionId,
            'cross_review',
            role,
            snapshot,
            'review',
            CHIEF_RESPONSE_SCHEMA,
            diagnosis,
            (raw) => validateChiefResponse(role, raw)
          );
          if (repaired) return repaired;
          degraded = true;
          return { ...fixtureResponse(role), substituted: true };
        }
      }
    );
    this.patch(sessionId, { crossReview: responses });

    if (this.isStale(sessionId)) return;

    // ── Round 3: one synthesis by the Incident Commander ─────────────────────
    this.patch(sessionId, { status: 'synthesis' });
    let brief: FinalOperationalBrief;
    if (!this.client) {
      brief = fixtureBrief();
    } else {
      try {
        const raw = await this.call(
          sessionId,
          'synthesis',
          synthesisPrompt(
            snapshot,
            positions,
            responses.map((r) => ({
              role: r.role,
              revisedPriority: r.revisedPriority,
              recommendation: r.recommendation,
              objections: r.objections
            })),
            snapshot.incidents.map((incident) => incident.id)
          ),
          FINAL_BRIEF_SCHEMA
        );
        const validated = validateFinalBrief(raw);
        if (!validated.ok || !validated.value) {
          throw new GeminiError('shape', validated.reason ?? 'brief failed validation');
        }
        brief = validated.value;
      } catch (error: unknown) {
        const diagnosis = this.diagnose(error);
        this.note(sessionId, describe(error, 'synthesis', undefined, diagnosis));
        const repaired = await this.repair(
          sessionId,
          'synthesis',
          'incident_commander',
          snapshot,
          'synthesis',
          FINAL_BRIEF_SCHEMA,
          diagnosis,
          (raw) => validateFinalBrief(raw)
        );
        if (repaired) {
          brief = repaired;
        } else {
          degraded = true;
          brief = fixtureBrief();
        }
      }
    }
    this.patch(sessionId, { finalBrief: brief, status: 'validating' });

    if (this.isStale(sessionId)) return;

    const source: DeliberationSource = degraded
      ? {
          provider: this.client ? 'gemini' : 'scripted',
          model: this.client?.model ?? FIXTURE_MODEL,
          degraded: true,
          warning: this.client
            ? 'One or more contributions came from the recorded deliberation fixture.'
            : 'No Gemini credential configured; this is a recorded deliberation.'
        }
      : { provider: 'gemini', model: this.client?.model ?? FIXTURE_MODEL, degraded: false };

    this.patch(sessionId, {
      status: degraded ? 'degraded' : 'ready',
      source,
      completedAt: now()
    });
  }

  /** Marks the session stale if world state moved while it was running. */
  private isStale(sessionId: string): boolean {
    const current = this.sessions.get(sessionId);
    if (!current) return true;
    if (isTerminalStatus(current.status)) return true;
    if (current.scenarioRevision !== this.world.revision) {
      this.patch(sessionId, {
        status: 'stale',
        completedAt: now(),
        errors: [
          ...current.errors,
          {
            code: 'stale_revision',
            message: `world state moved from revision ${current.scenarioRevision} to ${this.world.revision} during deliberation`,
            stage: current.status as DeliberationStage,
            at: now()
          }
        ]
      });
      return true;
    }
    return false;
  }
}

const describe = (
  error: unknown,
  stage: DeliberationStage,
  role?: AgentRole,
  diagnosis?: ReplyDiagnosis
): DeliberationError => {
  const base = {
    stage,
    at: now(),
    ...(role ? { role } : {}),
    ...(diagnosis ? { fault: diagnosis.fault, summary: diagnosis.summary } : {}),
    ...(diagnosis?.finishReason ? { finishReason: diagnosis.finishReason } : {})
  };
  if (error instanceof GeminiError) {
    const code =
      error.stage === 'timeout'
        ? 'timeout'
        : error.stage === 'blocked'
          ? 'blocked'
          : error.stage === 'shape'
            ? 'malformed_output'
            : 'provider_unavailable';
    return {
      ...base,
      code,
      message: error.detail ? `${error.message} (${error.detail})` : error.message
    };
  }
  return {
    ...base,
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error)
  };
};
