// Frontend boundary for docs/IMPLEMENTATION_CONTRACT.md.
//
// These names are now thin aliases over `@rescuemesh/shared`, which is the
// single source of truth. The local duplicates that lived here before the
// contract branch was integrated are gone; components keep importing the same
// names, so nothing downstream had to change.
export type {
  AgentRecommendation,
  AgentRole,
  Assignment,
  Bridge,
  Command,
  CommandError,
  CommandErrorCode,
  CommandResponse,
  CommandType,
  Facility,
  FieldReport,
  FieldReportSyncState,
  Incident,
  ReasoningProvider,
  ReasoningSource,
  ApprovableAction,
  ApproveRecommendationResponse,
  Resource,
  Route,
  Scenario,
  Severity,
  WorldStateEvent,
  WorldStateEventType,
  WorldStateResponse,
  Zone,
  ZoneConnectivity
} from '@rescuemesh/shared';

import type {
  ApproveRecommendationResponse,
  CommandResultMap,
  RecommendationResponse,
  Scenario as SharedScenario,
  SubmitReportPayload,
  ResourcePlan,
  Command as SharedCommand,
  CommandResponse as SharedCommandResponse
} from '@rescuemesh/shared';

/** What a device captures before it is known whether the zone is reachable. */
export type ReportInput = SubmitReportPayload;

/** The contract calls this a ResourcePlan; the UI calls it a Plan. */
export type Plan = ResourcePlan;

/** Per-command payload map, keyed by command type. */
export type Payloads = {
  [K in SharedCommand['type']]: Extract<SharedCommand, { type: K }>['payload'];
};

/** Per-command success `data` map, keyed by command type. */
export type Results = CommandResultMap;

/** One chief's recommendation plus the provenance of the model that produced it. */
export type Recommendation = RecommendationResponse;

/**
 * The transport the UI talks to. `mock` runs entirely in the browser; `api`
 * goes to the backend, where the simulation engine is authoritative.
 */
export interface FrontendClient {
  mode: 'mock' | 'api';
  scenario(): Promise<SharedScenario>;
  poll(revision: number): Promise<SharedScenario | null>;
  recommendations(): Promise<Recommendation[]>;
  command(command: SharedCommand): Promise<SharedCommandResponse>;
  /**
   * Approves a chief's supported proposed action. The backend maps it to an
   * existing engine command; this produces a PROPOSED plan for operator review,
   * it does not dispatch anything.
   */
  approveAdvice(
    recommendationId: string,
    analyzedRevision: number
  ): Promise<ApproveRecommendationResponse>;
}
