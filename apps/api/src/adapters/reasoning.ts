import type {
  AgentRecommendation,
  AgentRole,
  Incident,
  ReasoningSource,
  Scenario
} from '@rescuemesh/shared';
import type { ReasoningAdapter } from './contracts.js';
import { GeminiError } from './gemini.js';

const describe = (error: unknown): string => {
  if (error instanceof GeminiError) {
    return error.detail ? `${error.message} (${error.stage}: ${error.detail})` : error.message;
  }
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    return typeof detail === 'string' ? `${error.message} (${detail})` : error.message;
  }
  return String(error);
};

/**
 * Tries the live provider and falls back to the deterministic mock on any
 * failure — missing key, network error, timeout, HTTP error, safety block, or
 * output that fails validation. Model output therefore can never reach the UI
 * unlabelled, and can never reach world state at all: only the simulation
 * engine mutates state, and it never consults a model.
 */
export class ResilientReasoningAdapter implements ReasoningAdapter {
  constructor(
    private readonly primary: (ReasoningAdapter & { model: string }) | null,
    private readonly fallback: ReasoningAdapter,
    private readonly providerName: ReasoningSource['provider'] = 'gemini'
  ) {}

  get configured(): boolean {
    return this.primary !== null;
  }

  get provider(): ReasoningSource['provider'] {
    return this.primary ? this.providerName : 'mock';
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
            provider: this.providerName,
            model: this.primary.model,
            degraded: false
          } satisfies ReasoningSource
        };
      } catch (error: unknown) {
        const warning = describe(error);
        console.warn(
          `[rescuemesh] ${this.providerName} reasoning failed, using deterministic mock: ${warning}`
        );
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
