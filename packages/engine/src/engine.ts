import {
  pittsburghFloodScenario,
  type Command,
  type CommandResponse,
  type Scenario
} from '@rescuemesh/shared';
import { applyCommand, type ApplyContext } from './apply.js';
import {
  createFixedClock,
  createRng,
  DEFAULT_SEED,
  DEFAULT_START_TIME,
  type Clock,
  type Rng
} from './determinism.js';
import { createInitialState, type EngineState } from './state.js';

export interface SimulationEngineOptions {
  /** Defaults to the Pittsburgh seed scenario. */
  seedScenario?: Scenario;
  /** Defaults to a fixed clock, so runs are reproducible. */
  clock?: Clock;
  /** Defaults to `DEFAULT_SEED`. Ignored when `rng` is supplied. */
  seed?: number;
  rng?: Rng;
}

/**
 * A thin stateful shell over the pure reducer in `apply.ts`. Holds no HTTP, no
 * UI, and no I/O: the integration lead wires it to route handlers separately.
 *
 * Every value it produces is simulated — capacities, travel times, impact
 * forecasts, and connectivity all model an exercise, never live conditions.
 */
export class SimulationEngine {
  private current: EngineState;
  private readonly context: ApplyContext;

  constructor(options: SimulationEngineOptions = {}) {
    const seedScenario = options.seedScenario ?? pittsburghFloodScenario;
    this.current = createInitialState(seedScenario);
    this.context = {
      clock: options.clock ?? createFixedClock(DEFAULT_START_TIME),
      rng: options.rng ?? createRng(options.seed ?? DEFAULT_SEED),
      seedScenario
    };
  }

  /** A defensive copy of the world. Mutating it does not affect the engine. */
  get scenario(): Scenario {
    return structuredClone(this.current.scenario);
  }

  get revision(): number {
    return this.current.scenario.revision;
  }

  /** Internal ledgers, exposed read-only for tests and debugging. */
  get state(): Readonly<EngineState> {
    return this.current;
  }

  /** Applies one command. On failure the world is left exactly as it was. */
  execute(command: Command): CommandResponse {
    const { state, response } = applyCommand(this.current, command, this.context);
    this.current = state;
    return response;
  }

  /** Convenience for running a scripted sequence, e.g. the eight-step demo. */
  executeAll(commands: Command[]): CommandResponse[] {
    return commands.map((command) => this.execute(command));
  }
}
