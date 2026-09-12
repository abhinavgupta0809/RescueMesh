import type { AgentRole, RecommendationsResponse, Scenario } from '@rescuemesh/shared';
import { ROLE_TITLES } from './adapters/prompts.js';
import type { ResilientReasoningAdapter } from './adapters/reasoning.js';

export const AGENT_ROLES = Object.keys(ROLE_TITLES) as AgentRole[];

/**
 * Advice is expensive and the UI polls on a timer, so recommendations are
 * memoised against the scenario revision they analyzed. Repeated polling at the
 * same revision is served from cache and calls no model at all; the cache is
 * invalidated the moment a command advances the revision.
 *
 * Concurrent requests for the same revision share one in-flight computation
 * rather than each starting their own round of model calls.
 */
export class RecommendationCache {
  private entry: { revision: number; response: RecommendationsResponse } | undefined;
  private inFlight: { revision: number; promise: Promise<RecommendationsResponse> } | undefined;

  constructor(private readonly reasoning: ResilientReasoningAdapter) {}

  /** Cached advice for this revision, if any, without computing. */
  peek(revision: number): RecommendationsResponse | undefined {
    return this.entry?.revision === revision ? { ...this.entry.response, cached: true } : undefined;
  }

  async get(
    scenario: Scenario,
    roles: AgentRole[] = AGENT_ROLES
  ): Promise<RecommendationsResponse> {
    const revision = scenario.revision;
    const cached = this.peek(revision);
    if (cached) return cached;

    if (this.inFlight?.revision === revision) {
      return { ...(await this.inFlight.promise), cached: true };
    }

    const promise = this.compute(scenario, roles);
    this.inFlight = { revision, promise };
    try {
      const response = await promise;
      this.entry = { revision, response };
      return response;
    } finally {
      if (this.inFlight?.revision === revision) this.inFlight = undefined;
    }
  }

  private async compute(scenario: Scenario, roles: AgentRole[]): Promise<RecommendationsResponse> {
    const items = await Promise.all(
      roles.map(async (role) => {
        const { value, source } = await this.reasoning.recommendWithSource(role, scenario);
        return { recommendation: value, source, analyzedRevision: scenario.revision };
      })
    );
    return { revision: scenario.revision, cached: false, items };
  }

  /** Drops cached advice. Called on reset so stale chiefs never survive it. */
  invalidate(): void {
    this.entry = undefined;
    this.inFlight = undefined;
  }
}
