import {
  checkInvariants,
  validateScriptedBatch,
  type EngineCommand,
  type CommandError,
  type CommandErrorCode,
  type CommandFailure,
  type CommandResponse,
  type CommandSuccess,
  type CommandType,
  type EngineCommandType,
  type EngineCommandResultMap,
  type FieldReport,
  type Incident,
  type ResourcePlan,
  type Severity,
  type WorldStateEvent,
  type WorldStateEventType,
  type Zone,
  type AppliedDevelopment,
  type ScriptedEvent
} from '@rescuemesh/shared';
import { allocate, isReachable } from './allocator.js';
import { nextId, type EngineState } from './state.js';
import type { Clock, Rng } from './determinism.js';

/** Recorded, not generated. Surfaced so the UI never mislabels it as AI output. */
export const SCRIPT_SOURCE_VERSION = 'recorded-pittsburgh-sequence-v1';

export interface ApplyContext {
  clock: Clock;
  rng: Rng;
  /** The scenario `scenario.reset` restores. */
  seedScenario: Parameters<typeof checkInvariants>[0];
}

export interface ApplyResult {
  state: EngineState;
  response: CommandResponse;
}

const ERROR_RETRYABLE: Record<CommandErrorCode, boolean> = {
  validation_failed: false,
  unknown_command: false,
  not_found: false,
  revision_conflict: true,
  zone_offline: true,
  bridge_already_in_state: false,
  resource_unavailable: true,
  resource_double_booked: false,
  route_closed: false,
  plan_stale: true,
  plan_not_proposed: false,
  infeasible: false,
  provider_unavailable: true,
  scenario_batch_stale: true,
  no_acceptable_developments: false,
  internal_error: true
};

const fail = (
  state: EngineState,
  command: { commandId: string; type: EngineCommandType },
  code: CommandErrorCode,
  message: string,
  details?: Record<string, unknown>
): ApplyResult => {
  const error: CommandError = {
    code,
    message,
    retryable: ERROR_RETRYABLE[code],
    ...(details ? { details } : {})
  };
  const response: CommandFailure = {
    ok: false,
    commandId: command.commandId,
    type: command.type,
    revision: state.scenario.revision,
    error
  };
  return { state, response };
};

/** Incident text templates, chosen deterministically. Synthetic by construction. */
const FLOOD_TEMPLATES: readonly {
  title: string;
  description: string;
  capabilities: string[];
}[] = [
  {
    title: 'Underpass flooding with vehicles trapped',
    description: 'Modeled rapid inundation of a low underpass; vehicles reported stalled.',
    capabilities: ['swift-water-rescue', 'traffic-control']
  },
  {
    title: 'Residential basement flooding',
    description: 'Modeled street-level flooding entering basements on a low-lying block.',
    capabilities: ['evacuation', 'advanced-life-support']
  },
  {
    title: 'Riverside trail washout',
    description: 'Modeled washout of a riverside path with people cut off above the water.',
    capabilities: ['evacuation']
  },
  {
    title: 'Storm drain backup across an arterial road',
    description: 'Modeled drain failure closing lanes and stranding traffic.',
    capabilities: ['traffic-control', 'barriers']
  }
];

const SEVERITY_BY_INTENSITY: Record<'moderate' | 'severe' | 'catastrophic', Severity> = {
  moderate: 'moderate',
  severe: 'high',
  catastrophic: 'critical'
};

const INCIDENTS_BY_INTENSITY: Record<'moderate' | 'severe' | 'catastrophic', number> = {
  moderate: 1,
  severe: 2,
  catastrophic: 3
};

/** Deterministic severity from report wording. No model call, no randomness. */
export const severityFromReport = (body: string): Severity => {
  const text = body.toLowerCase();
  if (/trapped|drowning|unconscious|submerged|swept away|not breathing/.test(text))
    return 'critical';
  if (/injur|rising|evacuat|stranded|stuck|waist|chest deep/.test(text)) return 'high';
  if (/flood|water|blocked|closed|washout|debris/.test(text)) return 'moderate';
  return 'low';
};

const titleFromReport = (body: string): string => {
  const firstSentence =
    body
      .trim()
      .split(/[.!?\n]/)[0]
      ?.trim() ?? body.trim();
  const title = firstSentence.length > 0 ? firstSentence : 'Field report';
  return title.length <= 70 ? title : `${title.slice(0, 67)}...`;
};

export const applyCommand = (
  previous: EngineState,
  command: EngineCommand,
  ctx: ApplyContext
): ApplyResult => {
  // Command deduplication: a replayed commandId returns its original result and
  // changes nothing. This is what makes retries safe for every command.
  const alreadyApplied = previous.appliedCommands[command.commandId];
  if (alreadyApplied) {
    return {
      state: previous,
      response: {
        ...alreadyApplied,
        duplicate: true,
        events: [],
        revision: previous.scenario.revision
      }
    };
  }

  if (
    command.expectedRevision !== undefined &&
    command.expectedRevision !== previous.scenario.revision
  ) {
    return fail(
      previous,
      command,
      'revision_conflict',
      `command expected revision ${command.expectedRevision} but state is at ${previous.scenario.revision}`,
      { expectedRevision: command.expectedRevision, actualRevision: previous.scenario.revision }
    );
  }

  const draft: EngineState = {
    scenario: structuredClone(previous.scenario),
    appliedCommands: { ...previous.appliedCommands },
    appliedReports: { ...previous.appliedReports },
    counters: { ...previous.counters },
    bridgeRouteMemory: structuredClone(previous.bridgeRouteMemory),
    appliedScriptBatches: { ...previous.appliedScriptBatches }
  };
  const revision = previous.scenario.revision + 1;
  const events: WorldStateEvent[] = [];
  const emit = (type: WorldStateEventType, message: string, entityIds: string[]): void => {
    events.push({
      id: nextId(draft, 'evt-sim'),
      occurredAt: ctx.clock.now(),
      type,
      message,
      entityIds,
      revision
    });
  };

  const outcome = route(draft, command, ctx, emit);
  if (!outcome.ok) return fail(previous, command, outcome.code, outcome.message, outcome.details);

  // Reset is the one command that does not advance the world: it restores the
  // seed wholesale, so the revision returns to 0 and generated events are gone.
  const isReset = command.type === 'scenario.reset';
  if (!isReset) {
    draft.scenario.revision = revision;
    draft.scenario.events = [...draft.scenario.events, ...events];
  }

  // Safety net: a command that would break an invariant is rejected outright
  // rather than applied. The previous state is returned untouched.
  const violations = checkInvariants(draft.scenario);
  if (violations.length > 0) {
    return fail(
      previous,
      command,
      'internal_error',
      `command would violate ${violations.length} invariant(s) and was rejected`,
      { violations }
    );
  }

  // CommandSuccess is a discriminated union keyed on `type`, which is what lets
  // callers narrow `data`. The reducer necessarily builds it generically, so the
  // type/data pairing is enforced by `route()` above rather than here.
  const response = {
    ok: true,
    commandId: command.commandId,
    type: command.type,
    revision: draft.scenario.revision,
    appliedAt: ctx.clock.now(),
    duplicate: false,
    data: outcome.data,
    events
  } as unknown as CommandSuccess<CommandType>;
  // The reset command is deliberately not recorded: it clears the dedup ledger,
  // so recording it would leave exactly one stale entry behind.
  if (!isReset) draft.appliedCommands[command.commandId] = response;
  return { state: draft, response };
};

type Emit = (type: WorldStateEventType, message: string, entityIds: string[]) => void;

type RouteOutcome =
  | { ok: true; data: EngineCommandResultMap[EngineCommandType] }
  | { ok: false; code: CommandErrorCode; message: string; details?: Record<string, unknown> };

const reject = (
  code: CommandErrorCode,
  message: string,
  details?: Record<string, unknown>
): RouteOutcome => (details ? { ok: false, code, message, details } : { ok: false, code, message });

const route = (
  draft: EngineState,
  command: EngineCommand,
  ctx: ApplyContext,
  emit: Emit
): RouteOutcome => {
  const scenario = draft.scenario;

  switch (command.type) {
    case 'scenario.trigger_flood': {
      const { intensity, zoneIds } = command.payload;
      if (!(intensity in INCIDENTS_BY_INTENSITY)) {
        return reject('validation_failed', `unknown intensity "${String(intensity)}"`);
      }
      const targets =
        zoneIds && zoneIds.length > 0
          ? zoneIds.map((id) => scenario.zones.find((zone) => zone.id === id))
          : scenario.zones;
      const missing = zoneIds?.filter((id) => !scenario.zones.some((zone) => zone.id === id)) ?? [];
      if (missing.length > 0) return reject('not_found', `unknown zone(s): ${missing.join(', ')}`);

      const zones = targets.filter((zone): zone is Zone => zone !== undefined);
      const perZone = INCIDENTS_BY_INTENSITY[intensity];
      const raised: Incident[] = [];

      for (const zone of zones) {
        for (let n = 0; n < perZone; n += 1) {
          const template = ctx.rng.pick(FLOOD_TEMPLATES);
          const anchor = scenario.facilities.find(
            (facility) => facility.id === zone.facilityIds[0]
          );
          const incident: Incident = {
            id: nextId(draft, 'inc-sim'),
            title: `${template.title} — ${zone.name}`,
            description: `${template.description} (modeled, ${intensity} intensity)`,
            severity: SEVERITY_BY_INTENSITY[intensity],
            location: {
              lat: Number(
                ((anchor?.location.lat ?? 40.44) + (ctx.rng.next() - 0.5) * 0.02).toFixed(5)
              ),
              lng: Number(
                ((anchor?.location.lng ?? -79.99) + (ctx.rng.next() - 0.5) * 0.02).toFixed(5)
              )
            },
            address: `${zone.name} — modeled location ${ctx.rng.int(90) + 10}`,
            reportedAt: ctx.clock.now(),
            status: 'active',
            peopleAtRisk: ctx.rng.int(12) + 2,
            requiredCapabilities: [...template.capabilities]
          };
          scenario.incidents.push(incident);
          zone.incidentIds.push(incident.id);
          raised.push(incident);
          emit('incident_reported', `Modeled incident raised: ${incident.title}.`, [incident.id]);
        }
      }

      scenario.status = 'active';
      emit(
        'flood_triggered',
        `Modeled ${intensity} flash flood triggered across ${zones.length} zone(s); ${raised.length} synthetic incident(s) raised.`,
        zones.map((zone) => zone.id)
      );
      return {
        ok: true,
        data: { raisedIncidents: raised, affectedZoneIds: zones.map((z) => z.id) }
      };
    }

    case 'route.close_bridge': {
      const { bridgeId, closed } = command.payload;
      const bridge = scenario.bridges.find((candidate) => candidate.id === bridgeId);
      if (!bridge) return reject('not_found', `unknown bridge "${bridgeId}"`);
      const target = closed ? 'closed' : 'open';
      if (bridge.status === target) {
        return reject('bridge_already_in_state', `bridge ${bridgeId} is already ${target}`);
      }

      const touched: string[] = [];
      if (closed) {
        const memory: Record<string, (typeof scenario.routes)[number]['status']> = {};
        for (const routeId of bridge.routeIds) {
          const affected = scenario.routes.find((candidate) => candidate.id === routeId);
          if (!affected) continue;
          memory[routeId] = affected.status;
          affected.status = 'closed';
          touched.push(routeId);
          emit('road_changed', `Route ${routeId} closed with ${bridge.name} (modeled).`, [routeId]);
        }
        draft.bridgeRouteMemory[bridgeId] = memory;
      } else {
        const memory = draft.bridgeRouteMemory[bridgeId] ?? {};
        for (const routeId of bridge.routeIds) {
          const affected = scenario.routes.find((candidate) => candidate.id === routeId);
          if (!affected) continue;
          affected.status = memory[routeId] ?? 'open';
          touched.push(routeId);
          emit('road_changed', `Route ${routeId} reopened with ${bridge.name} (modeled).`, [
            routeId
          ]);
        }
        delete draft.bridgeRouteMemory[bridgeId];
      }
      bridge.status = target;
      emit('bridge_closed', `${bridge.name} is now ${target} (modeled).`, [bridge.id]);
      return { ok: true, data: { bridgeId, closedRouteIds: touched } };
    }

    case 'zone.set_connectivity': {
      const { zoneId, connectivity } = command.payload;
      const zone = scenario.zones.find((candidate) => candidate.id === zoneId);
      if (!zone) return reject('not_found', `unknown zone "${zoneId}"`);
      const cameOnline = zone.connectivity !== 'online' && connectivity === 'online';
      const syncableReportIds = scenario.reports
        .filter((report) => report.zoneId === zoneId && report.syncState === 'queued')
        .map((report) => report.clientReportId);

      if (zone.connectivity === connectivity) {
        // No-op success: no event, no state change beyond the revision bump.
        return { ok: true, data: { zone: structuredClone(zone), syncableReportIds } };
      }

      zone.connectivity = connectivity;
      zone.connectivityChangedAt = ctx.clock.now();
      emit(
        'zone_connectivity_changed',
        `Zone ${zone.name} is now ${connectivity} (simulated connectivity).` +
          (cameOnline && syncableReportIds.length > 0
            ? ` ${syncableReportIds.length} queued report(s) can now sync.`
            : ''),
        [zone.id]
      );
      return { ok: true, data: { zone: structuredClone(zone), syncableReportIds } };
    }

    case 'report.submit': {
      const { clientReportId, zoneId, body, capturedAt } = command.payload;
      if (!clientReportId.trim()) return reject('validation_failed', 'clientReportId is required');
      if (body.trim().length === 0 || body.length > 4_000) {
        return reject('validation_failed', 'body must be between 1 and 4000 characters');
      }
      const zone = scenario.zones.find((candidate) => candidate.id === zoneId);
      if (!zone) return reject('not_found', `unknown zone "${zoneId}"`);

      const existing = scenario.reports.find((report) => report.clientReportId === clientReportId);
      if (existing) {
        return {
          ok: true,
          data: {
            report: structuredClone(existing),
            queuedOffline: existing.syncState === 'queued'
          }
        };
      }

      // An offline zone queues the report WITHOUT touching central incident
      // state. Nothing becomes an incident until report.sync runs.
      if (zone.connectivity === 'offline') {
        const queued: FieldReport = {
          clientReportId,
          zoneId,
          body: body.trim(),
          capturedAt,
          syncState: 'queued'
        };
        scenario.reports.push(queued);
        emit(
          'report_queued',
          `Field report queued offline in ${zone.name}; not yet in central incident state (simulated).`,
          [clientReportId, zoneId]
        );
        return { ok: true, data: { report: structuredClone(queued), queuedOffline: true } };
      }

      const applied = applyReport(draft, { clientReportId, zoneId, body, capturedAt }, ctx, emit);
      return { ok: true, data: { report: applied, queuedOffline: false } };
    }

    case 'report.sync': {
      const applied: FieldReport[] = [];
      const duplicates: FieldReport[] = [];
      const rejected: FieldReport[] = [];

      for (const submission of command.payload.reports) {
        const zone = scenario.zones.find((candidate) => candidate.id === submission.zoneId);
        const stored = scenario.reports.find(
          (report) => report.clientReportId === submission.clientReportId
        );

        // Exactly-once: an already-applied clientReportId adds no incident and
        // no event, however many times sync is retried.
        if (draft.appliedReports[submission.clientReportId]) {
          const incidentId = draft.appliedReports[submission.clientReportId];
          duplicates.push(
            stored
              ? { ...structuredClone(stored), syncState: 'duplicate' }
              : {
                  clientReportId: submission.clientReportId,
                  zoneId: submission.zoneId,
                  body: submission.body,
                  capturedAt: submission.capturedAt,
                  syncState: 'duplicate',
                  ...(incidentId ? { incidentId } : {})
                }
          );
          continue;
        }

        if (!zone) {
          const entry = rejectReport(draft, submission, `unknown zone "${submission.zoneId}"`);
          rejected.push(entry);
          continue;
        }
        if (zone.connectivity === 'offline') {
          const entry = rejectReport(draft, submission, `zone ${zone.id} is still offline`);
          rejected.push(entry);
          continue;
        }
        if (submission.body.trim().length === 0 || submission.body.length > 4_000) {
          const entry = rejectReport(
            draft,
            submission,
            'body must be between 1 and 4000 characters'
          );
          rejected.push(entry);
          continue;
        }
        applied.push(applyReport(draft, submission, ctx, emit));
      }

      return { ok: true, data: { applied, duplicates, rejected } };
    }

    case 'plan.propose': {
      const reserve = command.payload.reserveUnitsPerKind ?? 0;
      if (!Number.isInteger(reserve) || reserve < 0) {
        return reject('validation_failed', 'reserveUnitsPerKind must be a non-negative integer');
      }
      const unknown = (command.payload.incidentIds ?? []).filter(
        (id) => !scenario.incidents.some((incident) => incident.id === id)
      );
      if (unknown.length > 0)
        return reject('not_found', `unknown incident(s): ${unknown.join(', ')}`);

      const result = allocate(
        {
          scenario,
          reserveUnitsPerKind: reserve,
          ...(command.payload.incidentIds ? { incidentIds: command.payload.incidentIds } : {})
        },
        () => nextId(draft, 'as-sim')
      );
      if (result.assignments.length === 0) {
        return reject('infeasible', result.rationale, { shortfalls: result.shortfalls });
      }

      for (const plan of scenario.plans) {
        if (plan.status === 'proposed') plan.status = 'superseded';
      }

      const proposal: ResourcePlan = {
        id: nextId(draft, 'plan'),
        status: 'proposed',
        createdAt: ctx.clock.now(),
        basedOnRevision: scenario.revision + 1,
        generatedBy: 'mock',
        assignments: result.assignments,
        rationale: result.rationale,
        shortfalls: result.shortfalls,
        forecast: result.forecast
      };
      scenario.plans.push(proposal);
      emit(
        'plan_proposed',
        `Plan ${proposal.id} proposed: ${proposal.assignments.length} assignment(s), ` +
          `${proposal.forecast.unmetCapabilityCount} unmet capability need(s) (modeled).`,
        [proposal.id, ...proposal.assignments.map((assignment) => assignment.id)]
      );
      return { ok: true, data: { plan: structuredClone(proposal) } };
    }

    case 'plan.approve': {
      const plan = scenario.plans.find((candidate) => candidate.id === command.payload.planId);
      if (!plan) return reject('not_found', `unknown plan "${command.payload.planId}"`);
      if (plan.status !== 'proposed') {
        return reject(
          'plan_not_proposed',
          `plan ${plan.id} is ${plan.status}, only a proposed plan can be approved`
        );
      }
      // Stale check: world state moved on after the plan was computed.
      if (plan.basedOnRevision !== scenario.revision) {
        return reject(
          'plan_stale',
          `plan ${plan.id} was computed against revision ${plan.basedOnRevision} but state is at ${scenario.revision}`,
          { basedOnRevision: plan.basedOnRevision, currentRevision: scenario.revision }
        );
      }

      const activeHolders = new Set(
        scenario.assignments
          .filter(
            (assignment) => assignment.status === 'approved' || assignment.status === 'dispatched'
          )
          .flatMap((assignment) => assignment.resourceIds)
      );

      // Re-check availability, double-booking, and routes against live state.
      for (const assignment of plan.assignments) {
        for (const resourceId of assignment.resourceIds) {
          const resource = scenario.resources.find((candidate) => candidate.id === resourceId);
          if (!resource) return reject('not_found', `unknown resource "${resourceId}"`);
          if (activeHolders.has(resourceId)) {
            return reject(
              'resource_double_booked',
              `resource ${resourceId} already belongs to an active assignment`,
              { resourceId }
            );
          }
          if (resource.status !== 'available') {
            return reject(
              'resource_unavailable',
              `resource ${resourceId} is ${resource.status}, not available`,
              { resourceId, status: resource.status }
            );
          }
          if (!isReachable(scenario, resource, assignment.incidentId)) {
            return reject(
              'route_closed',
              `the modeled route from ${resource.homeFacilityId} to ${assignment.incidentId} is closed`,
              { resourceId, incidentId: assignment.incidentId }
            );
          }
        }
      }

      const assignedResourceIds: string[] = [];
      for (const assignment of plan.assignments) {
        assignment.status = 'approved';
        scenario.assignments.push(structuredClone(assignment));
        for (const resourceId of assignment.resourceIds) {
          const resource = scenario.resources.find((candidate) => candidate.id === resourceId);
          if (resource) {
            resource.status = 'assigned';
            assignedResourceIds.push(resourceId);
          }
        }
        emit(
          'resource_dispatched',
          `${assignment.resourceIds.join(', ')} assigned to ${assignment.incidentId} (modeled).`,
          [assignment.id, ...assignment.resourceIds, assignment.incidentId]
        );
      }
      plan.status = 'approved';
      emit('plan_approved', `Plan ${plan.id} approved by the commander.`, [plan.id]);
      return { ok: true, data: { plan: structuredClone(plan), assignedResourceIds } };
    }

    case 'scenario.advance': {
      const { batchId, basedOnRevision, step, rationale, assumptions, developments } =
        command.payload;
      if (!batchId || typeof batchId !== 'string') {
        return reject('validation_failed', 'batchId is required');
      }
      if (draft.appliedScriptBatches[batchId]) {
        return reject('scenario_batch_stale', `scenario batch ${batchId} was already applied`);
      }

      const validation = validateScriptedBatch(
        { batchId, basedOnRevision, step, rationale, assumptions, developments },
        scenario,
        { appliedBatchIds: Object.keys(draft.appliedScriptBatches) }
      );
      if (validation.batchError) {
        const code =
          validation.batchError.code === 'invalid_batch'
            ? 'validation_failed'
            : 'scenario_batch_stale';
        return reject(code, validation.batchError.reason, { batchError: validation.batchError });
      }
      if (validation.accepted.length === 0) {
        return reject(
          'no_acceptable_developments',
          'no development in this scenario step survived validation',
          { rejected: validation.rejected }
        );
      }

      const applied: AppliedDevelopment[] = [];
      for (const development of validation.accepted) {
        const outcome = applyDevelopment(draft, development, ctx, emit);
        if (outcome) applied.push(outcome);
      }

      let phase = scenario.phase;
      for (const development of validation.accepted) {
        if (development.kind === 'scenario.phase') phase = development.phase;
      }
      scenario.phase = phase;
      draft.appliedScriptBatches[batchId] = true;

      emit(
        'scenario_step_applied',
        `Recorded scenario step "${step}": ${applied.length} development(s) applied` +
          (validation.rejected.length > 0 ? `, ${validation.rejected.length} refused` : '') +
          '. Fictional exercise content from the deterministic script.',
        [batchId]
      );
      for (const refusal of validation.rejected) {
        emit(
          'scenario_development_refused',
          `Refused ${String((refusal.proposal as { kind?: string }).kind ?? 'development')}: ${refusal.code} — ${refusal.reason}`,
          [batchId]
        );
      }

      return {
        ok: true,
        data: {
          batchId,
          step,
          source: { kind: 'scripted' as const, version: SCRIPT_SOURCE_VERSION },
          rationale,
          assumptions,
          applied,
          rejected: validation.rejected,
          phase
        }
      };
    }

    case 'scenario.reset': {
      // Emit before clearing, so the event's id counter is cleared with the rest.
      emit('scenario_reset', 'Scenario reset to the seeded exercise state.', [scenario.id]);
      // Full reset: seed state, and every ledger cleared.
      draft.scenario = structuredClone(ctx.seedScenario);
      draft.appliedCommands = {};
      draft.appliedReports = {};
      draft.counters = {};
      draft.bridgeRouteMemory = {};
      draft.appliedScriptBatches = {};
      return { ok: true, data: { scenario: structuredClone(draft.scenario) } };
    }

    default: {
      const exhaustive: never = command;
      return reject('unknown_command', `unknown command ${JSON.stringify(exhaustive)}`);
    }
  }
};

const applyReport = (
  draft: EngineState,
  submission: { clientReportId: string; zoneId: string; body: string; capturedAt: string },
  ctx: ApplyContext,
  emit: Emit
): FieldReport => {
  const scenario = draft.scenario;
  const zone = scenario.zones.find((candidate) => candidate.id === submission.zoneId);
  const anchor = scenario.facilities.find((facility) => facility.id === zone?.facilityIds[0]);
  const incident: Incident = {
    id: nextId(draft, 'inc-rep'),
    title: titleFromReport(submission.body),
    description: submission.body.trim(),
    severity: severityFromReport(submission.body),
    location: { lat: anchor?.location.lat ?? 40.44, lng: anchor?.location.lng ?? -79.99 },
    address: `${zone?.name ?? 'Unknown zone'} — from field report (modeled location)`,
    reportedAt: submission.capturedAt,
    status: 'active',
    peopleAtRisk: 1,
    requiredCapabilities: ['evacuation']
  };
  scenario.incidents.push(incident);
  zone?.incidentIds.push(incident.id);
  draft.appliedReports[submission.clientReportId] = incident.id;

  const existingIndex = scenario.reports.findIndex(
    (report) => report.clientReportId === submission.clientReportId
  );
  const record: FieldReport = {
    clientReportId: submission.clientReportId,
    zoneId: submission.zoneId,
    body: submission.body.trim(),
    capturedAt: submission.capturedAt,
    syncState: 'applied',
    appliedAt: ctx.clock.now(),
    incidentId: incident.id
  };
  if (existingIndex >= 0) scenario.reports[existingIndex] = record;
  else scenario.reports.push(record);

  emit('report_applied', `Field report applied as incident ${incident.id} (modeled).`, [
    submission.clientReportId,
    incident.id
  ]);
  return structuredClone(record);
};

const rejectReport = (
  draft: EngineState,
  submission: { clientReportId: string; zoneId: string; body: string; capturedAt: string },
  reason: string
): FieldReport => {
  const record: FieldReport = {
    clientReportId: submission.clientReportId,
    zoneId: submission.zoneId,
    body: submission.body.trim(),
    capturedAt: submission.capturedAt,
    syncState: 'rejected',
    rejectionReason: reason
  };
  const index = draft.scenario.reports.findIndex(
    (report) => report.clientReportId === submission.clientReportId
  );
  if (index >= 0) draft.scenario.reports[index] = record;
  else draft.scenario.reports.push(record);
  return structuredClone(record);
};

/**
 * Applies one validated development. Every entity this creates gets an
 * engine-generated id: the script only ever supplies a localRef, so it can
 * neither collide with nor impersonate an existing entity.
 */
const applyDevelopment = (
  draft: EngineState,
  proposal: ScriptedEvent,
  ctx: ApplyContext,
  emit: Emit
): AppliedDevelopment | undefined => {
  const scenario = draft.scenario;

  switch (proposal.kind) {
    case 'incident.raise': {
      const zone = scenario.zones.find((z) => z.id === proposal.zoneId);
      const anchor = scenario.facilities.find((f) => f.id === zone?.facilityIds[0]);
      const incident: Incident = {
        id: nextId(draft, 'inc-scr'),
        title: proposal.title,
        description: `${proposal.description} (fictional exercise development)`,
        severity: proposal.severity,
        location: { lat: anchor?.location.lat ?? 40.44, lng: anchor?.location.lng ?? -79.99 },
        address: `${zone?.name ?? 'Unknown zone'} — modeled location`,
        reportedAt: ctx.clock.now(),
        status: 'active',
        peopleAtRisk: proposal.peopleAtRisk,
        requiredCapabilities: [...proposal.requiredCapabilities]
      };
      scenario.incidents.push(incident);
      zone?.incidentIds.push(incident.id);
      emit('incident_reported', `Scripted development raised ${incident.title} (modeled).`, [
        incident.id
      ]);
      return {
        kind: proposal.kind,
        summary: `Raised ${incident.id}: ${incident.title} (${incident.severity})`,
        createdEntityId: { localRef: proposal.localRef, id: incident.id }
      };
    }
    case 'incident.escalate': {
      const incident = scenario.incidents.find((i) => i.id === proposal.incidentId);
      if (!incident) return undefined;
      const from = incident.severity;
      incident.severity = proposal.toSeverity;
      if (proposal.peopleAtRiskDelta) incident.peopleAtRisk += proposal.peopleAtRiskDelta;
      emit(
        'incident_reported',
        `Scripted development escalated ${incident.id}: ${from} -> ${incident.severity} (modeled).`,
        [incident.id]
      );
      return {
        kind: proposal.kind,
        summary: `Escalated ${incident.id} from ${from} to ${incident.severity}`
      };
    }
    case 'incident.stabilize': {
      const incident = scenario.incidents.find((i) => i.id === proposal.incidentId);
      if (!incident) return undefined;
      const parts: string[] = [];
      if (proposal.toSeverity) {
        parts.push(`${incident.severity} -> ${proposal.toSeverity}`);
        incident.severity = proposal.toSeverity;
      }
      if (proposal.toStatus) {
        parts.push(`status ${incident.status} -> ${proposal.toStatus}`);
        incident.status = proposal.toStatus;
      }
      emit(
        'incident_reported',
        `Scripted development stabilized ${incident.id}: ${parts.join(', ')} (modeled).`,
        [incident.id]
      );
      return { kind: proposal.kind, summary: `Stabilized ${incident.id}: ${parts.join(', ')}` };
    }
    case 'report.inject': {
      const zone = scenario.zones.find((z) => z.id === proposal.zoneId);
      const clientReportId = nextId(draft, 'rep-scr');
      // An offline zone queues it, exactly as a real device would.
      if (zone?.connectivity === 'offline') {
        scenario.reports.push({
          clientReportId,
          zoneId: proposal.zoneId,
          body: proposal.body,
          capturedAt: ctx.clock.now(),
          syncState: 'queued'
        });
        emit(
          'report_queued',
          `Scripted development injected a field report into offline ${zone.name}; queued, not yet central (modeled).`,
          [clientReportId]
        );
        return {
          kind: proposal.kind,
          summary: `Queued report ${clientReportId} in offline ${proposal.zoneId}`,
          createdEntityId: { localRef: proposal.localRef, id: clientReportId }
        };
      }
      const record = applyReport(
        draft,
        {
          clientReportId,
          zoneId: proposal.zoneId,
          body: proposal.body,
          capturedAt: ctx.clock.now()
        },
        ctx,
        emit
      );
      return {
        kind: proposal.kind,
        summary: `Applied report ${clientReportId} as ${record.incidentId ?? 'an incident'}`,
        createdEntityId: { localRef: proposal.localRef, id: clientReportId }
      };
    }
    case 'route.restrict': {
      const route = scenario.routes.find((r) => r.id === proposal.routeId);
      if (!route) return undefined;
      const from = route.status;
      route.status = proposal.status;
      emit(
        'road_changed',
        `Scripted development set ${route.id} ${from} -> ${route.status} (modeled).`,
        [route.id]
      );
      return { kind: proposal.kind, summary: `Route ${route.id} ${from} -> ${route.status}` };
    }
    case 'route.restore': {
      const route = scenario.routes.find((r) => r.id === proposal.routeId);
      if (!route) return undefined;
      const from = route.status;
      route.status = 'open';
      emit('road_changed', `Scripted development reopened ${route.id} (was ${from}, modeled).`, [
        route.id
      ]);
      return { kind: proposal.kind, summary: `Route ${route.id} reopened from ${from}` };
    }
    case 'facility.demand': {
      const facility = scenario.facilities.find((f) => f.id === proposal.facilityId);
      if (!facility) return undefined;
      const from = facility.currentLoad;
      // Clamped as a belt-and-braces guard; validation already refused overflow.
      facility.currentLoad = Math.min(
        facility.syntheticCapacity,
        Math.max(0, facility.currentLoad + proposal.loadDelta)
      );
      emit(
        'facility_updated',
        `Scripted development moved modeled demand at ${facility.id}: ${from} -> ${facility.currentLoad} of ${facility.syntheticCapacity}.`,
        [facility.id]
      );
      return {
        kind: proposal.kind,
        summary: `${facility.id} modeled load ${from} -> ${facility.currentLoad} of ${facility.syntheticCapacity}`
      };
    }
    case 'resource.delay': {
      const resource = scenario.resources.find((r) => r.id === proposal.resourceId);
      if (!resource) return undefined;
      // Only an available unit reaches here, so no assignment is disturbed.
      resource.status = 'offline';
      emit(
        'resource_dispatched',
        `Scripted development delayed ${resource.callsign} by a modeled ${proposal.delayMinutes} min: ${proposal.reason}.`,
        [resource.id]
      );
      return {
        kind: proposal.kind,
        summary: `${resource.callsign} delayed ~${proposal.delayMinutes} min (${proposal.reason})`
      };
    }
    case 'scenario.phase': {
      emit(
        'facility_updated',
        `Scripted development marked the exercise ${proposal.phase}: ${proposal.note}`,
        [scenario.id]
      );
      return { kind: proposal.kind, summary: `Phase -> ${proposal.phase}: ${proposal.note}` };
    }
  }
};
