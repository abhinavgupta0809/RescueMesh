import type { AgentRole } from './types.js';
import type { DisasterSpecification } from './disaster.js';
import type { ScenarioStepName } from './scripted-scenario.js';

/**
 * ── Five-chief deliberation ───────────────────────────────────────────────────
 *
 * Three rounds over ONE frozen scenario snapshot: five chiefs state an initial
 * position, five respond to each other, and the Incident Commander synthesises
 * a final brief. Eleven model calls per complete deliberation.
 *
 * This is an explicit, public-facing transcript. Chiefs are asked only for
 * short stated positions; hidden chain-of-thought is never requested, stored,
 * or displayed. Nothing here mutates world state: the deterministic engine
 * turns supported actions into a plan, and only operator approval executes it.
 */

/** Non-terminal stages, usable as an error's origin. */
export type DeliberationStage =
  'triggered' | 'initial_analysis' | 'cross_review' | 'synthesis' | 'validating';

export type DeliberationTerminalStatus = 'ready' | 'degraded' | 'stale' | 'failed';

export type DeliberationStatus = DeliberationStage | DeliberationTerminalStatus;

export const DELIBERATION_STAGES: readonly DeliberationStage[] = [
  'triggered',
  'initial_analysis',
  'cross_review',
  'synthesis',
  'validating'
];

export const DELIBERATION_TERMINAL_STATUSES: readonly DeliberationTerminalStatus[] = [
  'ready',
  'degraded',
  'stale',
  'failed'
];

export const isTerminalStatus = (
  status: DeliberationStatus
): status is DeliberationTerminalStatus =>
  (DELIBERATION_TERMINAL_STATUSES as readonly string[]).includes(status);

/** Exactly five initial, five cross-review, one synthesis. */
export const DELIBERATION_CALL_COUNT = 11;

/** Bounds every artefact is validated against. Exceeding one rejects the reply. */
export const DELIBERATION_BOUNDS = {
  situationSummaryMaxLength: 400,
  itemMaxLength: 200,
  maxTopPriorities: 3,
  maxRisks: 3,
  maxProposedActions: 3,
  maxAgreements: 4,
  maxObjections: 4,
  maxPointsOfAgreement: 5,
  maxUnresolvedDisputes: 5,
  maxOrderedPriorities: 5,
  rationaleMaxLength: 600
} as const;

/** Which backend produced a deliberation. `scripted` is the recorded fixture. */
export interface DeliberationSource {
  provider: 'gemini' | 'scripted';
  model: string;
  /** True when Gemini was configured and the fixture answered instead. */
  degraded: boolean;
  warning?: string;
}

export type DeliberationErrorCode =
  | 'provider_unavailable'
  | 'timeout'
  | 'malformed_output'
  | 'blocked'
  | 'stale_revision'
  | 'budget_exhausted'
  | 'unknown_entity'
  | 'unsupported_action'
  | 'plan_infeasible'
  | 'session_not_found'
  | 'not_ready'
  | 'internal_error';

export interface DeliberationError {
  code: DeliberationErrorCode;
  message: string;
  /** Present when the failure belongs to one chief rather than the session. */
  role?: AgentRole;
  stage: DeliberationStage;
  at: string;
}

/** One chief's opening position on the frozen snapshot. */
export interface ChiefPosition {
  role: AgentRole;
  situationSummary: string;
  /** At most 3. */
  topPriorities: string[];
  /** At most 3. */
  risks: string[];
  /** At most 3. */
  proposedActions: string[];
  confidence: number;
  /** True when this role was filled from the fixture rather than the model. */
  substituted?: boolean;
}

/** One chief's reply after reading the other four positions. */
export interface ChiefResponse {
  role: AgentRole;
  agreements: string[];
  objections: string[];
  revisedPriority: string;
  recommendation: string;
  confidence: number;
  substituted?: boolean;
}

/** The Incident Commander's synthesis of both rounds. */
export interface FinalOperationalBrief {
  situationSummary: string;
  pointsOfAgreement: string[];
  unresolvedDisputes: string[];
  orderedPriorities: string[];
  proposedActions: string[];
  rationale: string;
  confidence: number;
}

export interface DeliberationUsage {
  /** Model calls actually made. Fixture rounds contribute none. */
  calls: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Wall-clock time spent in the provider. Never added to the simulation clock. */
  latencyMs: number;
  /** True when a provider returned no usage figures, so spend is under-counted. */
  hasUnreportedUsage: boolean;
}

export interface DeliberationSession {
  sessionId: string;
  /** The frozen revision every round analyzed. */
  scenarioRevision: number;
  /** The scripted step that triggered this, when there was one. */
  scenarioStep?: ScenarioStepName;
  /** Human-readable description of what was triggered. */
  disaster: string;
  status: DeliberationStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  initialPositions: ChiefPosition[];
  crossReview: ChiefResponse[];
  finalBrief?: FinalOperationalBrief;
  /** The deterministic candidate plan, once produced. */
  planId?: string;
  source: DeliberationSource;
  errors: DeliberationError[];
  usage: DeliberationUsage;
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface ArtefactValidation<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}

const B = DELIBERATION_BOUNDS;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : undefined;

const list = (value: unknown, maxItems: number): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (value.length > maxItems) return undefined;
  const items: string[] = [];
  for (const entry of value) {
    const line = text(entry, B.itemMaxLength);
    if (line === undefined) return undefined;
    items.push(line);
  }
  return items;
};

const confidenceOf = (value: unknown): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0.5;
  const scaled = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return Math.round(Math.min(1, Math.max(0, scaled)) * 100) / 100;
};

const fail = <T>(reason: string): ArtefactValidation<T> => ({ ok: false, reason });

/** Strict: a reply outside the shape is rejected, never trimmed into shape. */
export const validateChiefPosition = (
  role: AgentRole,
  raw: unknown
): ArtefactValidation<ChiefPosition> => {
  if (typeof raw !== 'object' || raw === null) return fail('reply was not a JSON object');
  const r = raw as Record<string, unknown>;
  const situationSummary = text(r.situationSummary, B.situationSummaryMaxLength);
  if (!situationSummary) return fail('situationSummary missing or too long');
  const topPriorities = list(r.topPriorities, B.maxTopPriorities);
  if (!topPriorities || topPriorities.length === 0)
    return fail(`topPriorities must be 1-${B.maxTopPriorities} short strings`);
  const risks = list(r.risks, B.maxRisks);
  if (!risks) return fail(`risks must be at most ${B.maxRisks} short strings`);
  const proposedActions = list(r.proposedActions, B.maxProposedActions);
  if (!proposedActions) return fail(`proposedActions must be at most ${B.maxProposedActions}`);
  return {
    ok: true,
    value: {
      role,
      situationSummary,
      topPriorities,
      risks,
      proposedActions,
      confidence: confidenceOf(r.confidence)
    }
  };
};

export const validateChiefResponse = (
  role: AgentRole,
  raw: unknown
): ArtefactValidation<ChiefResponse> => {
  if (typeof raw !== 'object' || raw === null) return fail('reply was not a JSON object');
  const r = raw as Record<string, unknown>;
  const agreements = list(r.agreements, B.maxAgreements);
  if (!agreements) return fail(`agreements must be at most ${B.maxAgreements} short strings`);
  const objections = list(r.objections, B.maxObjections);
  if (!objections) return fail(`objections must be at most ${B.maxObjections} short strings`);
  const revisedPriority = text(r.revisedPriority, B.itemMaxLength);
  if (!revisedPriority) return fail('revisedPriority missing or too long');
  const recommendation = text(r.recommendation, B.itemMaxLength);
  if (!recommendation) return fail('recommendation missing or too long');
  return {
    ok: true,
    value: {
      role,
      agreements,
      objections,
      revisedPriority,
      recommendation,
      confidence: confidenceOf(r.confidence)
    }
  };
};

export const validateFinalBrief = (raw: unknown): ArtefactValidation<FinalOperationalBrief> => {
  if (typeof raw !== 'object' || raw === null) return fail('reply was not a JSON object');
  const r = raw as Record<string, unknown>;
  const situationSummary = text(r.situationSummary, B.situationSummaryMaxLength);
  if (!situationSummary) return fail('situationSummary missing or too long');
  const pointsOfAgreement = list(r.pointsOfAgreement, B.maxPointsOfAgreement);
  if (!pointsOfAgreement) return fail('pointsOfAgreement out of bounds');
  const unresolvedDisputes = list(r.unresolvedDisputes, B.maxUnresolvedDisputes);
  if (!unresolvedDisputes) return fail('unresolvedDisputes out of bounds');
  const orderedPriorities = list(r.orderedPriorities, B.maxOrderedPriorities);
  if (!orderedPriorities || orderedPriorities.length === 0)
    return fail('orderedPriorities must have at least one entry');
  const proposedActions = list(r.proposedActions, B.maxProposedActions);
  if (!proposedActions) return fail('proposedActions out of bounds');
  const rationale = text(r.rationale, B.rationaleMaxLength);
  if (!rationale) return fail('rationale missing or too long');
  return {
    ok: true,
    value: {
      situationSummary,
      pointsOfAgreement,
      unresolvedDisputes,
      orderedPriorities,
      proposedActions,
      rationale,
      confidence: confidenceOf(r.confidence)
    }
  };
};

/** Wire shape for `POST /api/simulations`. */
export interface StartSimulationRequest {
  /** A scripted step to advance, or omit to deliberate on current state. */
  step?: ScenarioStepName;
  /** One or two operator-selected disasters, applied atomically before deliberation. */
  disasters?: DisasterSpecification[];
  /** Idempotency key: the same value returns the existing session. */
  requestId?: string;
}

export interface SimulationSessionResponse {
  session: DeliberationSession;
}
