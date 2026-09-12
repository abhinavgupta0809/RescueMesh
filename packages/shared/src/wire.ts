import type { CommandResponse } from './commands.js';
import type { AgentRecommendation, Incident, Scenario, WorldStateEvent } from './types.js';

/**
 * Which reasoning backend produced a response. `mock` is the deterministic
 * fixture path and is always available; the others are optional adapters.
 */
export type ReasoningProvider = 'gemini' | 'mock';

/** Provenance attached to every reasoning result the API returns. */
export interface ReasoningSource {
  provider: ReasoningProvider;
  model: string;
  /** True when IFM was configured, was attempted, and the deterministic mock answered instead. */
  degraded: boolean;
  warning?: string;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  mode: 'gemini-live' | 'deterministic-mock';
  reasoning: { provider: ReasoningProvider; model: string; configured: boolean };
  edge: 'online' | 'offline-ready';
}

/**
 * `GET /api/world-state?since=<revision>`. Polling is sufficient for the demo:
 * the client sends the revision it last saw and gets only what changed.
 */
export interface WorldStateResponse {
  revision: number;
  simulatedTime: string;
  status: Scenario['status'];
  /** True when `since` already equalled `revision`; `events` is then empty. */
  upToDate: boolean;
  /** Events after `since`, oldest first. */
  events: WorldStateEvent[];
  /** Full state, sent when `since` is absent or older than the event window. */
  scenario?: Scenario;
}

export type IncidentDraft = Pick<Incident, 'title' | 'description' | 'severity'>;

export interface ParseReportResponse {
  incident: IncidentDraft;
  source: ReasoningSource;
}

export interface RecommendationResponse {
  recommendation: AgentRecommendation;
  source: ReasoningSource;
  /**
   * The scenario revision this advice was computed against. Advice older than
   * the current revision is stale and should be labelled as such in the UI.
   */
  analyzedRevision: number;
}

export interface RecommendationsResponse {
  /** The revision every item in this response analyzed. */
  revision: number;
  /** True when the set was served from cache without calling a model. */
  cached: boolean;
  items: RecommendationResponse[];
}

/** Request to execute a chief's proposed action. */
export interface ApproveRecommendationRequest {
  recommendationId: string;
  /**
   * The revision the operator saw when they approved. If world state has moved
   * on, the approval is stale and must be revalidated before it can execute.
   */
  analyzedRevision: number;
  commandId?: string;
}

export type ApprovalRefusalCode =
  'not_found' | 'stale_recommendation' | 'advisory_only' | 'already_resolved';

export interface ApproveRecommendationResponse {
  ok: boolean;
  recommendationId: string;
  /** Current world revision, whether or not the approval executed. */
  revision: number;
  /** The engine's own response to the derived command. Absent when refused. */
  command?: CommandResponse;
  refusal?: { code: ApprovalRefusalCode; message: string; currentRevision?: number };
}
