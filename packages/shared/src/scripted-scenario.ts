import type { Route, Scenario, Severity } from './types.js';

/**
 * ── Scripted scenario progression ─────────────────────────────────────────────
 *
 * A fixed, deterministic script of FICTIONAL exercise developments. The operator
 * advances it one named step at a time.
 *
 * **No model is involved.** Scenario progression is entirely deterministic
 * TypeScript: the same step from the same revision always produces the same
 * developments, the demo is rehearsable offline, and reset plus replay need no
 * network at all. These are recorded scenario events and must never be labelled
 * as AI-generated.
 *
 * Steps are expressed as bounded proposals so the engine validates them exactly
 * as it validates anything else: nothing here bypasses the engine, and the
 * script cannot create resources, assign units, or set travel times.
 */

export type ScenarioStepName =
  | 'initial_flooding'
  | 'bridge_disruption'
  | 'evacuation_pressure'
  | 'zone_connectivity_loss'
  | 'response_adaptation'
  | 'stabilization';

export const SCENARIO_STEPS: readonly ScenarioStepName[] = [
  'initial_flooding',
  'bridge_disruption',
  'evacuation_pressure',
  'zone_connectivity_loss',
  'response_adaptation',
  'stabilization'
];

export type ScenarioPhase = 'escalating' | 'holding' | 'stabilizing';

/** Hard ceiling per step, enforced by validation. */
export const MAX_DEVELOPMENTS_PER_STEP = 3;

// ── Proposed events ──────────────────────────────────────────────────────────

export type ScriptedEventKind =
  | 'incident.raise'
  | 'incident.escalate'
  | 'incident.stabilize'
  | 'report.inject'
  | 'route.restrict'
  | 'route.restore'
  | 'facility.demand'
  | 'resource.delay'
  | 'scenario.phase';

export const SCRIPTED_EVENT_KINDS: readonly ScriptedEventKind[] = [
  'incident.raise',
  'incident.escalate',
  'incident.stabilize',
  'report.inject',
  'route.restrict',
  'route.restore',
  'facility.demand',
  'resource.delay',
  'scenario.phase'
];

/** Bounds every payload is validated against. Exceeding one rejects the proposal. */
export const PROPOSAL_BOUNDS = {
  /** Characters. */
  titleMaxLength: 70,
  descriptionMaxLength: 400,
  reportBodyMaxLength: 600,
  rationaleMaxLength: 400,
  assumptionMaxLength: 200,
  maxAssumptions: 4,
  /** People added by one raised incident. */
  peopleAtRiskMin: 1,
  peopleAtRiskMax: 40,
  /** Modeled facility load may move by at most this much per proposal. */
  facilityLoadDeltaMax: 5,
  /** A delayed unit is unavailable for at least/at most this long (modeled). */
  resourceDelayMinutesMin: 5,
  resourceDelayMinutesMax: 60,
  /** Capabilities a raised incident may require. */
  maxRequiredCapabilities: 3
} as const;

/**
 * New entities are named by a `localRef`, not an id. The engine generates the
 * real id and reports the mapping, so a script can never choose an id that
 * collides with, or impersonates, an existing entity.
 */
export interface RaiseIncidentProposal {
  kind: 'incident.raise';
  localRef: string;
  /** Must be an existing zone id. */
  zoneId: string;
  title: string;
  description: string;
  severity: Severity;
  peopleAtRisk: number;
  requiredCapabilities: string[];
}

export interface EscalateIncidentProposal {
  kind: 'incident.escalate';
  /** Must be an existing incident id. */
  incidentId: string;
  toSeverity: Severity;
  /** Optional bounded increase in people at risk. */
  peopleAtRiskDelta?: number;
}

export interface StabilizeIncidentProposal {
  kind: 'incident.stabilize';
  incidentId: string;
  /** Either lower the severity or mark it contained. */
  toSeverity?: Severity;
  toStatus?: 'contained' | 'resolved';
}

export interface InjectReportProposal {
  kind: 'report.inject';
  localRef: string;
  /** Must be an existing zone id. An offline zone queues it, as a device would. */
  zoneId: string;
  body: string;
}

/** Route status only. Travel minutes stay the engine's to model. */
export interface RestrictRouteProposal {
  kind: 'route.restrict';
  /** Must be an existing route id. */
  routeId: string;
  status: Extract<Route['status'], 'slow' | 'closed'>;
}

export interface RestoreRouteProposal {
  kind: 'route.restore';
  routeId: string;
}

/** Modeled shelter or hospital demand. The engine clamps to valid bounds. */
export interface FacilityDemandProposal {
  kind: 'facility.demand';
  /** Must be an existing facility id. */
  facilityId: string;
  /** Bounded by PROPOSAL_BOUNDS.facilityLoadDeltaMax, positive or negative. */
  loadDelta: number;
}

/**
 * A supply or crew delay. Only a unit that is currently `available` may be
 * delayed, so a delay can never disturb an active assignment.
 */
export interface ResourceDelayProposal {
  kind: 'resource.delay';
  /** Must be an existing resource id. */
  resourceId: string;
  delayMinutes: number;
  reason: string;
}

/** A narrative marker. Changes the scenario phase, never an entity. */
export interface ScenarioPhaseProposal {
  kind: 'scenario.phase';
  phase: ScenarioPhase;
  note: string;
}

export type ScriptedEvent =
  | RaiseIncidentProposal
  | EscalateIncidentProposal
  | StabilizeIncidentProposal
  | InjectReportProposal
  | RestrictRouteProposal
  | RestoreRouteProposal
  | FacilityDemandProposal
  | ResourceDelayProposal
  | ScenarioPhaseProposal;

/** One step's worth of recorded developments. */
export interface ScriptedBatch {
  /** Idempotency key. Re-applying the same batch is a no-op. */
  batchId: string;
  /** The revision the script was resolved against. */
  basedOnRevision: number;
  step: ScenarioStepName;
  /** Why these developments follow from what came before. Authored, not generated. */
  rationale: string;
  assumptions: string[];
  developments: ScriptedEvent[];
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ScriptRejectionCode =
  | 'unknown_kind'
  | 'kind_not_allowed'
  | 'unknown_entity'
  | 'duplicate_local_ref'
  | 'out_of_bounds'
  | 'invalid_payload'
  | 'no_op'
  | 'would_break_capacity'
  | 'resource_not_available'
  | 'over_limit';

export interface RejectedDevelopment {
  proposal: ScriptedEvent | { kind: string };
  code: ScriptRejectionCode;
  reason: string;
}

export interface ScriptValidation {
  accepted: ScriptedEvent[];
  rejected: RejectedDevelopment[];
  /** Set when the whole batch is unusable. */
  batchError?: { code: 'stale_revision' | 'duplicate_batch' | 'invalid_batch'; reason: string };
}

const isFiniteInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

const boundedString = (value: unknown, max: number): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };

/**
 * Validates a scripted batch against live world state. The engine re-checks
 * everything it applies, so this is the first of two gates, never the only one.
 */
export const validateScriptedBatch = (
  batch: ScriptedBatch,
  scenario: Scenario,
  options: { allowedEventKinds?: ScriptedEventKind[]; appliedBatchIds?: Iterable<string> } = {}
): ScriptValidation => {
  const accepted: ScriptedEvent[] = [];
  const rejected: RejectedDevelopment[] = [];

  if (options.appliedBatchIds) {
    for (const seen of options.appliedBatchIds) {
      if (seen === batch.batchId) {
        return {
          accepted: [],
          rejected: [],
          batchError: {
            code: 'duplicate_batch',
            reason: `batch ${batch.batchId} was already applied`
          }
        };
      }
    }
  }
  if (batch.basedOnRevision !== scenario.revision) {
    return {
      accepted: [],
      rejected: [],
      batchError: {
        code: 'stale_revision',
        reason: `batch analyzed revision ${batch.basedOnRevision} but world state is at ${scenario.revision}`
      }
    };
  }
  if (!Array.isArray(batch.developments)) {
    return {
      accepted: [],
      rejected: [],
      batchError: { code: 'invalid_batch', reason: 'developments must be an array' }
    };
  }

  const allowed = new Set(options.allowedEventKinds ?? SCRIPTED_EVENT_KINDS);
  const zoneIds = new Set(scenario.zones.map((z) => z.id));
  const facilities = new Map(scenario.facilities.map((f) => [f.id, f]));
  const resources = new Map(scenario.resources.map((r) => [r.id, r]));
  const localRefs = new Set<string>();

  const reject = (
    proposal: ScriptedEvent | { kind: string },
    code: ScriptRejectionCode,
    reason: string
  ) => rejected.push({ proposal, code, reason });

  for (const proposal of batch.developments) {
    if (accepted.length >= MAX_DEVELOPMENTS_PER_STEP) {
      reject(
        proposal,
        'over_limit',
        `at most ${MAX_DEVELOPMENTS_PER_STEP} developments per request`
      );
      continue;
    }
    if (
      typeof proposal !== 'object' ||
      proposal === null ||
      typeof (proposal as { kind?: unknown }).kind !== 'string'
    ) {
      reject({ kind: 'unknown' }, 'invalid_payload', 'proposal must be an object with a kind');
      continue;
    }
    if (!(SCRIPTED_EVENT_KINDS as readonly string[]).includes(proposal.kind)) {
      reject(proposal, 'unknown_kind', `unknown event kind "${proposal.kind}"`);
      continue;
    }
    if (!allowed.has(proposal.kind)) {
      reject(proposal, 'kind_not_allowed', `${proposal.kind} is not allowed at this step`);
      continue;
    }

    switch (proposal.kind) {
      case 'incident.raise': {
        if (!boundedString(proposal.localRef, 60)) {
          reject(proposal, 'invalid_payload', 'localRef is required');
          continue;
        }
        if (localRefs.has(proposal.localRef)) {
          reject(
            proposal,
            'duplicate_local_ref',
            `localRef "${proposal.localRef}" repeats in this batch`
          );
          continue;
        }
        if (!zoneIds.has(proposal.zoneId)) {
          reject(proposal, 'unknown_entity', `unknown zone "${proposal.zoneId}"`);
          continue;
        }
        if (!boundedString(proposal.title, PROPOSAL_BOUNDS.titleMaxLength)) {
          reject(
            proposal,
            'out_of_bounds',
            `title must be 1-${PROPOSAL_BOUNDS.titleMaxLength} chars`
          );
          continue;
        }
        if (!boundedString(proposal.description, PROPOSAL_BOUNDS.descriptionMaxLength)) {
          reject(proposal, 'out_of_bounds', 'description is required and bounded');
          continue;
        }
        if (!(proposal.severity in SEVERITY_RANK)) {
          reject(proposal, 'invalid_payload', `unknown severity "${String(proposal.severity)}"`);
          continue;
        }
        if (
          !isFiniteInt(proposal.peopleAtRisk) ||
          proposal.peopleAtRisk < PROPOSAL_BOUNDS.peopleAtRiskMin ||
          proposal.peopleAtRisk > PROPOSAL_BOUNDS.peopleAtRiskMax
        ) {
          reject(
            proposal,
            'out_of_bounds',
            `peopleAtRisk must be ${PROPOSAL_BOUNDS.peopleAtRiskMin}-${PROPOSAL_BOUNDS.peopleAtRiskMax}`
          );
          continue;
        }
        if (
          !Array.isArray(proposal.requiredCapabilities) ||
          proposal.requiredCapabilities.length === 0 ||
          proposal.requiredCapabilities.length > PROPOSAL_BOUNDS.maxRequiredCapabilities ||
          !proposal.requiredCapabilities.every((c) => boundedString(c, 60))
        ) {
          reject(proposal, 'out_of_bounds', 'requiredCapabilities must be 1-3 non-empty strings');
          continue;
        }
        localRefs.add(proposal.localRef);
        accepted.push(proposal);
        continue;
      }
      case 'incident.escalate': {
        const incident = scenario.incidents.find((i) => i.id === proposal.incidentId);
        if (!incident) {
          reject(proposal, 'unknown_entity', `unknown incident "${proposal.incidentId}"`);
          continue;
        }
        if (!(proposal.toSeverity in SEVERITY_RANK)) {
          reject(proposal, 'invalid_payload', `unknown severity "${String(proposal.toSeverity)}"`);
          continue;
        }
        if (SEVERITY_RANK[proposal.toSeverity] >= SEVERITY_RANK[incident.severity]) {
          reject(proposal, 'no_op', `${incident.id} is already ${incident.severity}`);
          continue;
        }
        if (proposal.peopleAtRiskDelta !== undefined) {
          if (
            !isFiniteInt(proposal.peopleAtRiskDelta) ||
            proposal.peopleAtRiskDelta < 0 ||
            proposal.peopleAtRiskDelta > PROPOSAL_BOUNDS.peopleAtRiskMax
          ) {
            reject(
              proposal,
              'out_of_bounds',
              'peopleAtRiskDelta must be a bounded non-negative integer'
            );
            continue;
          }
        }
        accepted.push(proposal);
        continue;
      }
      case 'incident.stabilize': {
        const incident = scenario.incidents.find((i) => i.id === proposal.incidentId);
        if (!incident) {
          reject(proposal, 'unknown_entity', `unknown incident "${proposal.incidentId}"`);
          continue;
        }
        if (proposal.toSeverity === undefined && proposal.toStatus === undefined) {
          reject(proposal, 'invalid_payload', 'give a toSeverity or a toStatus');
          continue;
        }
        if (proposal.toSeverity !== undefined && !(proposal.toSeverity in SEVERITY_RANK)) {
          reject(proposal, 'invalid_payload', `unknown severity "${String(proposal.toSeverity)}"`);
          continue;
        }
        if (
          proposal.toSeverity !== undefined &&
          SEVERITY_RANK[proposal.toSeverity] <= SEVERITY_RANK[incident.severity]
        ) {
          reject(
            proposal,
            'no_op',
            `${incident.id} is not more severe than ${proposal.toSeverity}`
          );
          continue;
        }
        if (
          proposal.toStatus !== undefined &&
          !['contained', 'resolved'].includes(proposal.toStatus)
        ) {
          reject(proposal, 'invalid_payload', 'toStatus must be contained or resolved');
          continue;
        }
        accepted.push(proposal);
        continue;
      }
      case 'report.inject': {
        if (!boundedString(proposal.localRef, 60)) {
          reject(proposal, 'invalid_payload', 'localRef is required');
          continue;
        }
        if (localRefs.has(proposal.localRef)) {
          reject(
            proposal,
            'duplicate_local_ref',
            `localRef "${proposal.localRef}" repeats in this batch`
          );
          continue;
        }
        if (!zoneIds.has(proposal.zoneId)) {
          reject(proposal, 'unknown_entity', `unknown zone "${proposal.zoneId}"`);
          continue;
        }
        if (!boundedString(proposal.body, PROPOSAL_BOUNDS.reportBodyMaxLength)) {
          reject(proposal, 'out_of_bounds', 'body is required and bounded');
          continue;
        }
        localRefs.add(proposal.localRef);
        accepted.push(proposal);
        continue;
      }
      case 'route.restrict': {
        const route = scenario.routes.find((r) => r.id === proposal.routeId);
        if (!route) {
          reject(proposal, 'unknown_entity', `unknown route "${proposal.routeId}"`);
          continue;
        }
        if (proposal.status !== 'slow' && proposal.status !== 'closed') {
          reject(proposal, 'invalid_payload', 'status must be slow or closed');
          continue;
        }
        if (route.status === proposal.status) {
          reject(proposal, 'no_op', `${route.id} is already ${route.status}`);
          continue;
        }
        accepted.push(proposal);
        continue;
      }
      case 'route.restore': {
        const route = scenario.routes.find((r) => r.id === proposal.routeId);
        if (!route) {
          reject(proposal, 'unknown_entity', `unknown route "${proposal.routeId}"`);
          continue;
        }
        if (route.status === 'open') {
          reject(proposal, 'no_op', `${route.id} is already open`);
          continue;
        }
        // A route closed by a bridge closure stays closed while the bridge is.
        const gatingBridge = scenario.bridges.find(
          (b) => b.status === 'closed' && b.routeIds.includes(route.id)
        );
        if (gatingBridge) {
          reject(
            proposal,
            'invalid_payload',
            `${route.id} is closed by ${gatingBridge.id}; reopen the bridge`
          );
          continue;
        }
        accepted.push(proposal);
        continue;
      }
      case 'facility.demand': {
        const facility = facilities.get(proposal.facilityId);
        if (!facility) {
          reject(proposal, 'unknown_entity', `unknown facility "${proposal.facilityId}"`);
          continue;
        }
        if (
          !isFiniteInt(proposal.loadDelta) ||
          proposal.loadDelta === 0 ||
          Math.abs(proposal.loadDelta) > PROPOSAL_BOUNDS.facilityLoadDeltaMax
        ) {
          reject(
            proposal,
            'out_of_bounds',
            `loadDelta must be a non-zero integer within ±${PROPOSAL_BOUNDS.facilityLoadDeltaMax}`
          );
          continue;
        }
        const next = facility.currentLoad + proposal.loadDelta;
        if (next < 0 || next > facility.syntheticCapacity) {
          reject(
            proposal,
            'would_break_capacity',
            `load ${facility.currentLoad} ${proposal.loadDelta > 0 ? '+' : ''}${proposal.loadDelta} leaves ${next}, outside 0-${facility.syntheticCapacity}`
          );
          continue;
        }
        accepted.push(proposal);
        continue;
      }
      case 'resource.delay': {
        const resource = resources.get(proposal.resourceId);
        if (!resource) {
          reject(proposal, 'unknown_entity', `unknown resource "${proposal.resourceId}"`);
          continue;
        }
        // Only an idle unit may be delayed, so a delay cannot disturb an assignment.
        if (resource.status !== 'available') {
          reject(
            proposal,
            'resource_not_available',
            `${resource.id} is ${resource.status}; only an available unit may be delayed`
          );
          continue;
        }
        if (
          !isFiniteInt(proposal.delayMinutes) ||
          proposal.delayMinutes < PROPOSAL_BOUNDS.resourceDelayMinutesMin ||
          proposal.delayMinutes > PROPOSAL_BOUNDS.resourceDelayMinutesMax
        ) {
          reject(
            proposal,
            'out_of_bounds',
            `delayMinutes must be ${PROPOSAL_BOUNDS.resourceDelayMinutesMin}-${PROPOSAL_BOUNDS.resourceDelayMinutesMax}`
          );
          continue;
        }
        if (!boundedString(proposal.reason, 200)) {
          reject(proposal, 'invalid_payload', 'reason is required');
          continue;
        }
        accepted.push(proposal);
        continue;
      }
      case 'scenario.phase': {
        if (!['escalating', 'holding', 'stabilizing'].includes(proposal.phase)) {
          reject(proposal, 'invalid_payload', `unknown phase "${String(proposal.phase)}"`);
          continue;
        }
        if (!boundedString(proposal.note, 240)) {
          reject(proposal, 'invalid_payload', 'note is required');
          continue;
        }
        accepted.push(proposal);
        continue;
      }
    }
  }

  return { accepted, rejected };
};
