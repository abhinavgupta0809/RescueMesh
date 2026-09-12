import type {
  AgentRecommendation,
  AgentRole,
  Incident,
  ReasoningSource,
  Scenario
} from '@rescuemesh/shared';
import type { ReasoningAdapter } from './contracts.js';
import { IfmError } from './ifm.js';

const describe = (error: unknown): string => {
  if (error instanceof IfmError) {
    return error.detail ? `${error.message} (${error.stage}: ${error.detail})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * Tries the IFM-backed adapter and falls back to the deterministic mock on any
 * failure — missing key, network error, timeout, HTTP error, or output that does
 * not validate. Malformed model output can therefore never reach world state.
 */
export class ResilientReasoningAdapter implements ReasoningAdapter {
  constructor(
    private readonly primary: (ReasoningAdapter & { model: string }) | null,
    private readonly fallback: ReasoningAdapter
  ) {}

  get configured(): boolean {
    return this.primary !== null;
  }

  get model(): string {
    return this.primary?.model ?? 'deterministic-mock';
  }

  private async attempt<T>(run: (adapter: ReasoningAdapter) => Promise<T>) {
    if (this.primary) {
      try {
        const value = await run(this.primary);
        return {
          value,
          source: {
            provider: 'ifm',
            model: this.primary.model,
            degraded: false
          } satisfies ReasoningSource
        };
      } catch (error: unknown) {
        const warning = describe(error);
        console.warn(`[rescuemesh] IFM reasoning failed, using deterministic mock: ${warning}`);
        return {
          value: await run(this.fallback),
          source: {
            provider: 'mock',
            model: 'deterministic-mock',
            degraded: true,
            warning
          } satisfies ReasoningSource
        };
      }
    }
    return {
      value: await run(this.fallback),
      source: {
        provider: 'mock',
        model: 'deterministic-mock',
        degraded: false
      } satisfies ReasoningSource
    };
  }

  parseReportWithSource(report: string): Promise<{
    value: Pick<Incident, 'title' | 'description' | 'severity'>;
    source: ReasoningSource;
  }> {
    return this.attempt((adapter) => adapter.parseReport(report));
  }

  recommendWithSource(
    role: AgentRole,
    scenario: Scenario
  ): Promise<{ value: AgentRecommendation; source: ReasoningSource }> {
    return this.attempt((adapter) => adapter.recommend(role, scenario));
  }

  async parseReport(report: string) {
    return (await this.parseReportWithSource(report)).value;
  }

  async recommend(role: AgentRole, scenario: Scenario) {
    return (await this.recommendWithSource(role, scenario)).value;
  }
}
