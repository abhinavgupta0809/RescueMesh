import type { AgentRecommendation, Incident, Scenario, WorldStateEvent } from './types.js';

/**
 * Which reasoning backend produced a response. `mock` is the deterministic
 * fixture path and is always available; the others are optional adapters.
 */
export type ReasoningProvider = 'ifm' | 'gemini' | 'mock';

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
  mode: 'ifm-live' | 'gemini-live' | 'deterministic-mock';
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
}

export interface RecommendationsResponse {
  items: RecommendationResponse[];
}
