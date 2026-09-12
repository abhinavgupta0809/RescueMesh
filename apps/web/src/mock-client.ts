import { pittsburghFloodScenario } from '@rescuemesh/shared';
import type {
  Command,
  CommandErrorCode,
  CommandResponse,
  FieldReport,
  FrontendClient,
  Plan,
  ReportInput,
  Scenario,
  WorldStateEventType
} from './contract';

export function createSeed(): Scenario {
  const seed = structuredClone(pittsburghFloodScenario);
  return {
    ...seed,
    revision: 0,
    plans: [],
    reports: [],
    zones: [
      {
        id: 'zone-a',
        name: 'Downtown',
        connectivity: 'online',
        facilityIds: ['h-mercy', 'h-agh', 'f-03', 'p-zone1', 'r-river'],
        incidentIds: [],
        connectivityChangedAt: seed.simulatedTime
      },
      {
        id: 'zone-b',
        name: 'Oakland',
        connectivity: 'online',
        facilityIds: ['h-presby', 'f-07'],
        incidentIds: ['inc-parkway', 'inc-southside'],
        connectivityChangedAt: seed.simulatedTime
      },
      {
        id: 'zone-c',
        name: 'East End',
        connectivity: 'online',
        facilityIds: ['f-19', 'p-zone4', 'r-east'],
        incidentIds: ['inc-trail'],
        connectivityChangedAt: seed.simulatedTime
      }
    ],
    bridges: [
      {
        id: 'bridge-birmingham',
        name: 'Birmingham Bridge',
        status: 'open',
        routeIds: ['route-east-parkway'],
        connectsZoneIds: ['zone-b', 'zone-c'],
        synthetic: true
      }
    ]
  };
}

/** Isolated, deterministic browser simulation. Never used as a fallback from HTTP. */
export function createMockClient(): FrontendClient {
  let state = createSeed();
  const processed = new Map<string, CommandResponse>();
  function apply(command: Command): CommandResponse {
    const previous = processed.get(command.commandId);
    if (previous?.ok) return { ...structuredClone(previous), duplicate: true, events: [] };
    const fail = (code: CommandErrorCode, message: string): CommandResponse => ({
      ok: false,
      type: command.type,
      commandId: command.commandId,
      revision: state.revision,
      error: {
        code,
        message,
        retryable: ['zone_offline', 'plan_stale', 'revision_conflict'].includes(code)
      }
    });
    if (command.expectedRevision !== undefined && command.expectedRevision !== state.revision)
      return fail('revision_conflict', 'World state changed. Refresh and review the plan again.');
    const draft = structuredClone(state);
    const revision = state.revision + 1;
    const time = new Date(
      new Date(createSeed().simulatedTime).getTime() + revision * 60000
    ).toISOString();
    const events: Scenario['events'] = [];
    function event(type: WorldStateEventType, message: string, entityIds: string[] = []) {
      events.push({
        id: `evt-${revision}-${events.length}`,
        type,
        message,
        entityIds,
        occurredAt: time,
        revision
      });
    }
    function report(input: ReportInput): FieldReport {
      const existing = draft.reports.find((r) => r.clientReportId === input.clientReportId);
      if (existing) return { ...existing, syncState: 'duplicate' };
      const zone = draft.zones.find((z) => z.id === input.zoneId);
      if (
        !zone ||
        zone.connectivity === 'offline' ||
        !input.body.trim() ||
        input.body.length > 4000
      )
        return {
          ...input,
          syncState: 'rejected',
          rejectionReason: !zone
            ? 'Unknown zone'
            : zone.connectivity === 'offline'
              ? 'Zone is still offline; reconnect and retry.'
              : 'Report must contain 1–4000 characters.'
        };
      const incidentId = `report-${input.clientReportId}`;
      const applied: FieldReport = { ...input, syncState: 'applied', incidentId, appliedAt: time };
      draft.reports.push(applied);
      draft.incidents.push({
        id: incidentId,
        title: 'Field report · review requested',
        description: input.body,
        address: zone.name,
        location: { lat: 40.438, lng: -79.919 },
        severity: 'high',
        status: 'active',
        peopleAtRisk: 0,
        requiredCapabilities: ['evacuation'],
        reportedAt: time
      });
      zone.incidentIds.push(incidentId);
      event(
        'report_applied',
        `Field report synchronized from ${zone.name}. Unverified details require commander review.`,
        [incidentId, zone.id]
      );
      return applied;
    }
    let data: Record<string, unknown>;
    switch (command.type) {
      case 'scenario.trigger_flood': {
        const ids = command.payload.zoneIds?.length
          ? command.payload.zoneIds
          : draft.zones.map((z) => z.id);
        if (ids.some((id) => !draft.zones.some((z) => z.id === id)))
          return fail('not_found', 'Unknown flood zone.');
        const raised = ids.map((id, index) => {
          const zone = draft.zones.find((z) => z.id === id)!;
          const incident = {
            id: `flood-${revision}-${index}`,
            title: `Flash flood · ${zone.name}`,
            description: 'Synthetic rising-water exercise. Evacuation assistance requested.',
            severity: 'high' as const,
            location: { lat: 40.442 - index * 0.008, lng: -79.98 + index * 0.025 },
            address: zone.name,
            reportedAt: time,
            status: 'active' as const,
            peopleAtRisk:
              command.payload.intensity === 'catastrophic'
                ? 24
                : command.payload.intensity === 'severe'
                  ? 12
                  : 6,
            requiredCapabilities: ['evacuation']
          };
          zone.incidentIds.push(incident.id);
          return incident;
        });
        draft.incidents.push(...raised);
        draft.status = 'active';
        event(
          'flood_triggered',
          'Synthetic flash flood triggered. Operating picture updated.',
          ids
        );
        raised.forEach((i) => event('incident_reported', i.title, [i.id]));
        data = { raisedIncidents: raised, affectedZoneIds: ids };
        break;
      }
      case 'route.close_bridge': {
        const bridge = draft.bridges.find((b) => b.id === command.payload.bridgeId);
        if (!bridge) return fail('not_found', 'Bridge not found.');
        if ((bridge.status === 'closed') === command.payload.closed)
          return fail('bridge_already_in_state', 'Bridge is already in that state.');
        bridge.status = command.payload.closed ? 'closed' : 'open';
        draft.routes
          .filter((r) => bridge.routeIds.includes(r.id))
          .forEach((r) => {
            r.status = bridge.status;
            event('road_changed', `${r.id}: ${r.status}`, [r.id]);
          });
        event(
          'bridge_closed',
          `${bridge.name} ${bridge.status}. Plans must avoid affected routes.`,
          [bridge.id]
        );
        data = {
          bridgeId: bridge.id,
          closedRouteIds: command.payload.closed ? bridge.routeIds : []
        };
        break;
      }
      case 'zone.set_connectivity': {
        const zone = draft.zones.find((z) => z.id === command.payload.zoneId);
        if (!zone) return fail('not_found', 'Zone not found.');
        if (zone.connectivity !== command.payload.connectivity) {
          zone.connectivity = command.payload.connectivity;
          zone.connectivityChangedAt = time;
          event('zone_connectivity_changed', `${zone.name} ${zone.connectivity}.`, [zone.id]);
        }
        data = { zone, syncableReportIds: [] };
        break;
      }
      case 'report.submit': {
        const zone = draft.zones.find((z) => z.id === command.payload.zoneId);
        if (!zone) return fail('not_found', 'Zone not found.');
        if (zone.connectivity === 'offline')
          return fail('zone_offline', 'Zone offline. Queue this report on the device.');
        const result = report(command.payload);
        if (result.syncState === 'rejected')
          return fail('validation_failed', result.rejectionReason!);
        data = { report: result, queuedOffline: false };
        break;
      }
      case 'report.sync': {
        if (command.payload.reports.some((r) => !draft.zones.some((z) => z.id === r.zoneId)))
          return fail('not_found', 'Unknown report zone.');
        const results = command.payload.reports.map(report);
        data = {
          applied: results.filter((r) => r.syncState === 'applied'),
          duplicates: results.filter((r) => r.syncState === 'duplicate'),
          rejected: results.filter((r) => r.syncState === 'rejected')
        };
        break;
      }
      case 'plan.propose': {
        const incidents = draft.incidents.filter(
          (i) =>
            i.status === 'active' &&
            (!command.payload.incidentIds?.length || command.payload.incidentIds.includes(i.id))
        );
        if (command.payload.incidentIds?.length) {
          const order = command.payload.incidentIds;
          incidents.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        }
        const units = draft.resources.filter((r) => r.status === 'available');
        const selected = new Set<string>();
        const plan: Plan = {
          id: `plan-${revision}`,
          status: 'proposed',
          createdAt: time,
          basedOnRevision: revision,
          generatedBy: 'mock',
          assignments: [],
          shortfalls: [],
          rationale: `${command.payload.incidentIds?.length ? 'Alternate incident order evaluated. The same constraints may yield the same feasible assignment. ' : ''}Deterministic capability match using explicit open or slow routes. Unroutable needs remain visible; units are only reserved on approval.`,
          forecast: {
            synthetic: true,
            peopleReachableWithin30Min: 0,
            unmetCapabilityCount: 0,
            modeledTotalTravelMinutes: 0
          }
        };
        const reserve = command.payload.reserveUnitsPerKind ?? 0;
        for (const incident of incidents) {
          const held = draft.assignments
            .filter(
              (a) => a.incidentId === incident.id && ['approved', 'dispatched'].includes(a.status)
            )
            .flatMap((a) => a.resourceIds);
          const covered = new Set(
            draft.resources.filter((r) => held.includes(r.id)).flatMap((r) => r.capabilities)
          );
          const chosen: string[] = [];
          for (const capability of incident.requiredCapabilities.filter((c) => !covered.has(c))) {
            const unit = units.find(
              (u) =>
                !selected.has(u.id) &&
                u.capabilities.includes(capability) &&
                units.filter((v) => v.kind === u.kind && !selected.has(v.id)).length > reserve &&
                draft.routes.some(
                  (r) =>
                    r.fromId === u.homeFacilityId && r.toId === incident.id && r.status !== 'closed'
                )
            );
            if (unit) {
              selected.add(unit.id);
              chosen.push(unit.id);
              unit.capabilities.forEach((c) => covered.add(c));
              const route = draft.routes.find(
                (r) =>
                  r.fromId === unit.homeFacilityId &&
                  r.toId === incident.id &&
                  r.status !== 'closed'
              )!;
              plan.forecast.modeledTotalTravelMinutes += route.travelMinutes;
            }
          }
          const missing = incident.requiredCapabilities.filter((c) => !covered.has(c));
          if (missing.length)
            plan.shortfalls.push({
              incidentId: incident.id,
              missingCapabilities: missing,
              reason: 'No available capable unit with an explicit usable route.'
            });
          if (chosen.length) {
            plan.assignments.push({
              id: `as-${revision}-${plan.assignments.length}`,
              incidentId: incident.id,
              resourceIds: chosen,
              priority: 1,
              status: 'proposed',
              rationale: 'Capability matched; synthetic route verified open.'
            });
            if (!missing.length) plan.forecast.peopleReachableWithin30Min += incident.peopleAtRisk;
          }
        }
        if (!plan.assignments.length)
          return fail(
            'infeasible',
            'No available units with usable routes. Try the standard plan or reset the scenario.'
          );
        plan.forecast.unmetCapabilityCount = plan.shortfalls.reduce(
          (n, s) => n + s.missingCapabilities.length,
          0
        );
        draft.plans
          .filter((p) => p.status === 'proposed')
          .forEach((p) => {
            p.status = 'superseded';
          });
        draft.plans.push(plan);
        event(
          'plan_proposed',
          'Resource plan proposed for human review. Shortfalls are explicitly retained.',
          [plan.id]
        );
        data = { plan };
        break;
      }
      case 'plan.approve': {
        const plan = draft.plans.find((p) => p.id === command.payload.planId);
        if (!plan) return fail('not_found', 'Plan not found.');
        if (plan.status !== 'proposed')
          return fail('plan_not_proposed', 'Only a proposed plan can be approved.');
        if (plan.basedOnRevision !== state.revision)
          return fail('plan_stale', 'The situation changed. Generate a new plan before approval.');
        const ids = plan.assignments.flatMap((a) => a.resourceIds);
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id) => draft.resources.find((r) => r.id === id)?.status !== 'available')
        )
          return fail('resource_double_booked', 'A plan resource is already held.');
        if (
          plan.assignments.some((a) =>
            a.resourceIds.some(
              (id) =>
                !draft.routes.some(
                  (r) =>
                    r.fromId === draft.resources.find((u) => u.id === id)?.homeFacilityId &&
                    r.toId === a.incidentId &&
                    r.status !== 'closed'
                )
            )
          )
        )
          return fail('route_closed', 'A required route is unavailable.');
        plan.status = 'approved';
        plan.assignments.forEach((a) => {
          a.status = 'approved';
          draft.assignments.push(a);
        });
        draft.resources
          .filter((r) => ids.includes(r.id))
          .forEach((r) => {
            r.status = 'assigned';
            event('resource_dispatched', `${r.callsign} assigned after human approval.`, [r.id]);
          });
        event('plan_approved', 'Commander approved the synthetic resource plan.', [plan.id]);
        data = { plan, assignedResourceIds: ids };
        break;
      }
      case 'scenario.reset': {
        state = createSeed();
        const response: CommandResponse = {
          ok: true,
          type: command.type,
          commandId: command.commandId,
          revision: 0,
          appliedAt: state.simulatedTime,
          duplicate: false,
          data: { scenario: structuredClone(state) },
          events: []
        };
        processed.set(command.commandId, structuredClone(response));
        return response;
      }
    }
    if (events.length) {
      draft.revision = revision;
      draft.simulatedTime = time;
      draft.events.push(...events);
    }
    state = draft;
    const response = {
      ok: true,
      type: command.type,
      commandId: command.commandId,
      revision: state.revision,
      appliedAt: time,
      duplicate: false,
      data,
      events
    } as unknown as CommandResponse;
    processed.set(command.commandId, structuredClone(response));
    return structuredClone(response);
  }
  return {
    mode: 'mock',
    scenario: async () => structuredClone(state),
    poll: async (revision) => (state.revision === revision ? null : structuredClone(state)),
    recommendations: async () =>
      state.recommendations.map((recommendation) => ({
        recommendation: structuredClone(recommendation),
        source: { provider: 'mock' as const, model: 'deterministic fixture', degraded: false },
        analyzedRevision: state.revision
      })),
    command: async (command) => apply(command)
  };
}
