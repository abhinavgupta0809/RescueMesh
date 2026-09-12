import {
  pittsburghFloodScenario,
  type CommandSuccess,
  type CommandType,
  type Route,
  type Scenario
} from '@rescuemesh/shared';

/**
 * Everything the engine needs, held explicitly. The scenario is the world; the
 * three ledgers beside it are what make replays and retries safe.
 */
export interface EngineState {
  scenario: Scenario;
  /** commandId -> the response first produced for it. Makes every command idempotent. */
  appliedCommands: Record<string, CommandSuccess<CommandType>>;
  /** clientReportId -> incidentId. Makes report sync exactly-once across retries. */
  appliedReports: Record<string, string>;
  /** Deterministic id counters, keyed by prefix. */
  counters: Record<string, number>;
  /** Route statuses before a bridge closed them, so reopening restores rather than guesses. */
  bridgeRouteMemory: Record<string, Record<string, Route['status']>>;
  /**
   * Scenario-script batches already applied. Makes a replayed step a no-op, so
   * replay and reset never depend on anything outside the engine.
   */
  appliedScriptBatches: Record<string, true>;
}

export const createInitialState = (
  seedScenario: Scenario = pittsburghFloodScenario
): EngineState => ({
  scenario: structuredClone(seedScenario),
  appliedCommands: {},
  appliedReports: {},
  counters: {},
  bridgeRouteMemory: {},
  appliedScriptBatches: {}
});

/** Next deterministic id for a prefix, e.g. `nextId(state, 'inc-sim')` -> `inc-sim-1`. */
export const nextId = (state: EngineState, prefix: string): string => {
  const count = (state.counters[prefix] ?? 0) + 1;
  state.counters[prefix] = count;
  return `${prefix}-${count}`;
};
