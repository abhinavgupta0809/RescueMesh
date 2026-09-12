export { SimulationEngine, type SimulationEngineOptions } from './engine.js';
export { applyCommand, severityFromReport, type ApplyContext, type ApplyResult } from './apply.js';
export { createInitialState, nextId, type EngineState } from './state.js';
export {
  allocate,
  isReachable,
  modeledTravelMinutes,
  MODELED_FALLBACK_TRAVEL_MINUTES,
  type AllocationInput,
  type AllocationOutput
} from './allocator.js';
export {
  createFixedClock,
  createRng,
  systemClock,
  DEFAULT_SEED,
  DEFAULT_START_TIME,
  type Clock,
  type Rng
} from './determinism.js';
