import type { DisasterKind, DisasterSpecification } from './disaster.js';
import type {
  ScenarioPhase,
  ScenarioStepName,
  ScriptedEvent,
  RejectedDevelopment
} from './scripted-scenario.js';
import type {
  FieldReport,
  Incident,
  ResourcePlan,
  Scenario,
  WorldStateEvent,
  Zone,
  ZoneConnectivity
} from './types.js';

/**
 * The eight commands that make up the interactive demo. One command = one
 * applied state transition = one revision increment = at least one event.
 * See docs/IMPLEMENTATION_CONTRACT.md for the transition table and invariants.
 */
export type CommandType =
  | 'scenario.trigger_flood'
  | 'route.close_bridge'
  | 'zone.set_connectivity'
  | 'report.submit'
  | 'report.sync'
  | 'plan.propose'
  | 'plan.approve'
  | 'scenario.reset';

export const COMMAND_TYPES: readonly CommandType[] = [
  'scenario.trigger_flood',
  'route.close_bridge',
  'zone.set_connectivity',
  'report.submit',
  'report.sync',
  'plan.propose',
  'plan.approve',
  'scenario.reset'
];

export const isCommandType = (value: unknown): value is CommandType =>
  typeof value === 'string' && (COMMAND_TYPES as readonly string[]).includes(value);

/** Envelope every command shares. `commandId` is the idempotency key. */
export interface CommandEnvelope<TType extends CommandType, TPayload> {
  type: TType;
  commandId: string;
  issuedAt: string;
  /**
   * When present, the command applies only if the store is still at this
   * revision. Omit for commands that are safe to apply against any revision.
   */
  expectedRevision?: number;
  payload: TPayload;
}

export interface TriggerFloodPayload {
  /** Which zones the modeled rainfall hits. Empty means every zone. */
  zoneIds?: string[];
  /** Modeled intensity; drives how many synthetic incidents are raised. */
  intensity: 'moderate' | 'severe' | 'catastrophic';
}

export interface CloseBridgePayload {
  bridgeId: string;
  /** False reopens the bridge and restores its routes' prior status. */
  closed: boolean;
}

export interface SetZoneConnectivityPayload {
  zoneId: string;
  connectivity: ZoneConnectivity;
}

export interface SubmitReportPayload {
  /** Device-generated idempotency key. Re-submitting it is a no-op. */
  clientReportId: string;
  zoneId: string;
  body: string;
  capturedAt: string;
}

export interface SyncReportsPayload {
  /** Reports held on the device while its zone was offline, oldest first. */
  reports: SubmitReportPayload[];
}

export interface ProposePlanPayload {
  /** Limit the plan to these incidents. Empty or absent means all active ones. */
  incidentIds?: string[];
  /** Keep at least this many available units per kind unassigned. */
  reserveUnitsPerKind?: number;
}

export interface ApprovePlanPayload {
  planId: string;
}

/**
 * Applies one step of the recorded scenario script. The developments are
 * authored deterministic content, not model output; this command is how the
 * engine validates and atomically applies them.
 */
export interface AdvanceScenarioPayload {
  /** Idempotency key for the batch. Re-applying it is a no-op. */
  batchId: string;
  basedOnRevision: number;
  step: ScenarioStepName;
  rationale: string;
  assumptions: string[];
  developments: ScriptedEvent[];
}

/** Reset takes no payload: it restores the seeded scenario exactly. */
export type ResetScenarioPayload = Record<string, never>;

export type TriggerFloodCommand = CommandEnvelope<'scenario.trigger_flood', TriggerFloodPayload>;
export type CloseBridgeCommand = CommandEnvelope<'route.close_bridge', CloseBridgePayload>;
export type SetZoneConnectivityCommand = CommandEnvelope<
  'zone.set_connectivity',
  SetZoneConnectivityPayload
>;
export type SubmitReportCommand = CommandEnvelope<'report.submit', SubmitReportPayload>;
export type SyncReportsCommand = CommandEnvelope<'report.sync', SyncReportsPayload>;
export type ProposePlanCommand = CommandEnvelope<'plan.propose', ProposePlanPayload>;
export type ApprovePlanCommand = CommandEnvelope<'plan.approve', ApprovePlanPayload>;
/**
 * Applying a scripted step is a server-side operation, deliberately NOT part of
 * the public `Command` union: the UI reaches it through
 * `POST /api/scenario/advance`, never by submitting a generic command. Keeping
 * it out of `Command` leaves the frontend's command contract unchanged.
 */
export interface AdvanceScenarioCommand {
  type: 'scenario.advance';
  commandId: string;
  issuedAt: string;
  expectedRevision?: number;
  payload: AdvanceScenarioPayload;
}

/**
 * Applies a complete multi-hazard exercise as ONE transition. Server-side, like
 * `scenario.advance`: the UI reaches it through `POST /api/simulations`, so the
 * public `Command` union and the frontend's exhaustive switch are unchanged.
 */
export interface StartExercisePayload {
  /** Idempotency key. Re-applying the same exercise is a no-op. */
  exerciseId: string;
  basedOnRevision: number;
  /** One or two, already validated against the scenario. */
  disasters: DisasterSpecification[];
}

export interface StartExerciseCommand {
  type: 'scenario.exercise';
  commandId: string;
  issuedAt: string;
  expectedRevision?: number;
  payload: StartExercisePayload;
}

/** One disaster the engine actually created. */
export interface AppliedDisaster {
  kind: DisasterKind;
  zoneId: string;
  incidentId: string;
  requiredCapabilities: string[];
  peopleAtRisk: number;
}

export interface StartExerciseResult {
  exerciseId: string;
  applied: AppliedDisaster[];
  /** Routes a collision deterministically slowed. Empty when none applied. */
  slowedRouteIds: string[];
}

/** Everything the engine can apply: public commands plus server-side ones. */
export type EngineCommand = Command | AdvanceScenarioCommand | StartExerciseCommand;

export type EngineCommandResultMap = CommandResultMap & {
  'scenario.advance': AdvanceScenarioResult;
  'scenario.exercise': StartExerciseResult;
};
export type ResetScenarioCommand = CommandEnvelope<'scenario.reset', ResetScenarioPayload>;

export type Command =
  | TriggerFloodCommand
  | CloseBridgeCommand
  | SetZoneConnectivityCommand
  | SubmitReportCommand
  | SyncReportsCommand
  | ProposePlanCommand
  | ApprovePlanCommand
  | ResetScenarioCommand;

/** Per-command success payloads. */
export interface TriggerFloodResult {
  raisedIncidents: Incident[];
  affectedZoneIds: string[];
}
export interface CloseBridgeResult {
  bridgeId: string;
  closedRouteIds: string[];
}
export interface SetZoneConnectivityResult {
  zone: Zone;
  /** Reports that can now be synced because the zone came back online. */
  syncableReportIds: string[];
}
export interface SubmitReportResult {
  report: FieldReport;
  /** True when the zone was offline and the device must hold the report. */
  queuedOffline: boolean;
}
export interface SyncReportsResult {
  applied: FieldReport[];
  /** Reports whose `clientReportId` had already been applied. */
  duplicates: FieldReport[];
  rejected: FieldReport[];
}
export interface ProposePlanResult {
  plan: ResourcePlan;
}
export interface ApprovePlanResult {
  plan: ResourcePlan;
  /** Resources moved from `available` to `assigned` by this approval. */
  assignedResourceIds: string[];
}
/** One development the engine applied, with any id it generated. */
export interface AppliedDevelopment {
  kind: ScriptedEvent['kind'];
  summary: string;
  createdEntityId?: { localRef: string; id: string };
}

export interface AdvanceScenarioResult {
  batchId: string;
  step: ScenarioStepName;
  /** Always the recorded script. Present so the UI can label provenance honestly. */
  source: { kind: 'scripted'; version: string };
  rationale: string;
  assumptions: string[];
  applied: AppliedDevelopment[];
  rejected: RejectedDevelopment[];
  phase: ScenarioPhase;
}

export interface ResetScenarioResult {
  scenario: Scenario;
}

export interface CommandResultMap {
  'scenario.trigger_flood': TriggerFloodResult;
  'route.close_bridge': CloseBridgeResult;
  'zone.set_connectivity': SetZoneConnectivityResult;
  'report.submit': SubmitReportResult;
  'report.sync': SyncReportsResult;
  'plan.propose': ProposePlanResult;
  'plan.approve': ApprovePlanResult;
  'scenario.reset': ResetScenarioResult;
}

export type EngineCommandType = Command['type'] | 'scenario.advance' | 'scenario.exercise';

export type CommandErrorCode =
  | 'validation_failed'
  | 'unknown_command'
  | 'not_found'
  | 'revision_conflict'
  | 'zone_offline'
  | 'bridge_already_in_state'
  | 'resource_unavailable'
  | 'resource_double_booked'
  | 'route_closed'
  | 'plan_stale'
  | 'plan_not_proposed'
  | 'infeasible'
  | 'provider_unavailable'
  | 'scenario_batch_stale'
  | 'exercise_rejected'
  | 'no_acceptable_developments'
  | 'internal_error';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  /** Whether the same command may be retried unchanged. */
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * Distributed over CommandType so that narrowing on `type` also narrows `data`.
 * Written as a mapped type rather than an interface for exactly that reason: an
 * interface with `data: CommandResultMap[TType]` widens to a union of every
 * result shape and gives callers no way to discriminate.
 */
export type CommandSuccess<TType extends CommandType = CommandType> = {
  [K in CommandType]: {
    ok: true;
    commandId: string;
    type: K;
    /** Revision after applying. Unchanged from the request when `duplicate`. */
    revision: number;
    appliedAt: string;
    /** True when this `commandId` had already been applied; nothing changed. */
    duplicate: boolean;
    data: CommandResultMap[K];
    /** Events appended by this command, in order. Empty when `duplicate`. */
    events: WorldStateEvent[];
  };
}[TType];

export interface CommandFailure {
  ok: false;
  commandId: string;
  /** `EngineCommandType` so a server-side command can also fail here. */
  type: EngineCommandType | 'unknown';
  /** Revision at the time of rejection. Never advances on failure. */
  revision: number;
  error: CommandError;
}

export type CommandResponse<TType extends CommandType = CommandType> =
  CommandSuccess<TType> | CommandFailure;

export const isCommandSuccess = <TType extends CommandType>(
  response: CommandResponse<TType>
): response is CommandSuccess<TType> => response.ok;
