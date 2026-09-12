import type { Assignment, Scenario } from './types.js';

/**
 * Executable form of the invariants in docs/IMPLEMENTATION_CONTRACT.md.
 * Any world state produced by any command must satisfy all of them, so the
 * backend, the tests, and integration review all check the same rules.
 */
export interface InvariantViolation {
  /** Invariant id from the contract document, e.g. "I2". */
  invariant: string;
  message: string;
  entityIds?: string[];
}

/** Facility mix the demo promises and every state must keep. */
export const SEED_FACILITY_MIX = {
  hospital: { exactly: 3 },
  fire_house: { atLeast: 3 },
  police_hub: { exactly: 2 },
  rescue_center: { exactly: 2 }
} as const;

/** Assignment states that hold a unit. A unit may be in at most one of these. */
export const ACTIVE_ASSIGNMENT_STATUSES: readonly Assignment['status'][] = [
  'approved',
  'dispatched'
];

const isActive = (assignment: Assignment): boolean =>
  ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status);

export const checkInvariants = (scenario: Scenario): InvariantViolation[] => {
  const violations: InvariantViolation[] = [];
  const add = (invariant: string, message: string, entityIds?: string[]) =>
    violations.push(entityIds ? { invariant, message, entityIds } : { invariant, message });

  const facilityIds = new Set(scenario.facilities.map((facility) => facility.id));
  const resourceIds = new Set(scenario.resources.map((resource) => resource.id));
  const incidentIds = new Set(scenario.incidents.map((incident) => incident.id));
  const zoneIds = new Set(scenario.zones.map((zone) => zone.id));
  const routesById = new Map(scenario.routes.map((route) => [route.id, route]));

  // I1 — seeded facility mix survives every command.
  const countKind = (kind: string) =>
    scenario.facilities.filter((facility) => facility.kind === kind).length;
  for (const [kind, rule] of Object.entries(SEED_FACILITY_MIX)) {
    const actual = countKind(kind);
    if ('exactly' in rule && actual !== rule.exactly) {
      add('I1', `expected exactly ${rule.exactly} ${kind}, found ${actual}`);
    }
    if ('atLeast' in rule && actual < rule.atLeast) {
      add('I1', `expected at least ${rule.atLeast} ${kind}, found ${actual}`);
    }
  }

  // I2 — a unit is never held by two active assignments.
  const holders = new Map<string, string[]>();
  for (const assignment of scenario.assignments.filter(isActive)) {
    for (const resourceId of assignment.resourceIds) {
      holders.set(resourceId, [...(holders.get(resourceId) ?? []), assignment.id]);
    }
  }
  for (const [resourceId, assignmentIds] of holders) {
    if (assignmentIds.length > 1) {
      add('I2', `resource ${resourceId} is held by ${assignmentIds.length} active assignments`, [
        resourceId,
        ...assignmentIds
      ]);
    }
  }

  // I3 — resource status agrees with assignment state.
  for (const resource of scenario.resources) {
    const held = holders.has(resource.id);
    if (held && resource.status === 'available') {
      add('I3', `resource ${resource.id} is in an active assignment but marked available`, [
        resource.id
      ]);
    }
    if (!held && resource.status === 'assigned') {
      add('I3', `resource ${resource.id} is marked assigned but holds no active assignment`, [
        resource.id
      ]);
    }
  }

  // I4 — referential integrity across assignments and plans.
  const checkAssignment = (assignment: Assignment, origin: string) => {
    if (!incidentIds.has(assignment.incidentId)) {
      add('I4', `${origin} ${assignment.id} references unknown incident ${assignment.incidentId}`);
    }
    for (const resourceId of assignment.resourceIds) {
      if (!resourceIds.has(resourceId)) {
        add('I4', `${origin} ${assignment.id} references unknown resource ${resourceId}`);
      }
    }
    if (assignment.destinationFacilityId && !facilityIds.has(assignment.destinationFacilityId)) {
      add(
        'I4',
        `${origin} ${assignment.id} references unknown facility ${assignment.destinationFacilityId}`
      );
    }
  };
  for (const assignment of scenario.assignments) checkAssignment(assignment, 'assignment');
  for (const plan of scenario.plans) {
    for (const assignment of plan.assignments) checkAssignment(assignment, `plan ${plan.id}`);
  }

  // I5 — a PROPOSED plan never routes a unit over a closed route.
  // Assignments already approved or dispatched may be stranded by a later
  // closure; that is a real condition the exercise wants to surface, not a
  // broken state, so it is not an invariant violation.
  for (const plan of scenario.plans) {
    if (plan.status !== 'proposed') continue;
    for (const assignment of plan.assignments) {
      for (const resourceId of assignment.resourceIds) {
        const resource = scenario.resources.find((candidate) => candidate.id === resourceId);
        if (!resource) continue;
        const route = scenario.routes.find(
          (candidate) =>
            candidate.fromId === resource.homeFacilityId && candidate.toId === assignment.incidentId
        );
        if (route?.status === 'closed') {
          add('I5', `proposed plan ${plan.id} uses closed route ${route.id}`, [plan.id, route.id]);
        }
      }
    }
  }

  // I6 — a closed bridge closes every route that crosses it.
  for (const bridge of scenario.bridges) {
    for (const routeId of bridge.routeIds) {
      const route = routesById.get(routeId);
      if (!route) {
        add('I6', `bridge ${bridge.id} references unknown route ${routeId}`, [bridge.id]);
        continue;
      }
      if (bridge.status === 'closed' && route.status !== 'closed') {
        add('I6', `bridge ${bridge.id} is closed but route ${routeId} is ${route.status}`, [
          bridge.id,
          routeId
        ]);
      }
    }
    for (const zoneId of bridge.connectsZoneIds) {
      if (!zoneIds.has(zoneId)) {
        add('I6', `bridge ${bridge.id} references unknown zone ${zoneId}`, [bridge.id]);
      }
    }
  }

  // I7 — every facility sits in exactly one zone; every incident in at most one.
  const facilityZones = new Map<string, number>();
  const incidentZones = new Map<string, number>();
  for (const zone of scenario.zones) {
    for (const facilityId of zone.facilityIds) {
      if (!facilityIds.has(facilityId)) {
        add('I7', `zone ${zone.id} references unknown facility ${facilityId}`, [zone.id]);
      }
      facilityZones.set(facilityId, (facilityZones.get(facilityId) ?? 0) + 1);
    }
    for (const incidentId of zone.incidentIds) {
      if (!incidentIds.has(incidentId)) {
        add('I7', `zone ${zone.id} references unknown incident ${incidentId}`, [zone.id]);
      }
      incidentZones.set(incidentId, (incidentZones.get(incidentId) ?? 0) + 1);
    }
  }
  for (const facilityId of facilityIds) {
    const count = facilityZones.get(facilityId) ?? 0;
    if (count !== 1) add('I7', `facility ${facilityId} belongs to ${count} zones, expected 1`);
  }
  for (const [incidentId, count] of incidentZones) {
    if (count > 1)
      add('I7', `incident ${incidentId} belongs to ${count} zones, expected at most 1`);
  }

  // I8 — report identity and sync state are consistent.
  const seenReportIds = new Set<string>();
  for (const report of scenario.reports) {
    if (seenReportIds.has(report.clientReportId)) {
      add('I8', `duplicate clientReportId ${report.clientReportId} in world state`);
    }
    seenReportIds.add(report.clientReportId);
    if (!zoneIds.has(report.zoneId)) {
      add('I8', `report ${report.clientReportId} references unknown zone ${report.zoneId}`);
    }
    if (report.syncState === 'applied' && !report.appliedAt) {
      add('I8', `report ${report.clientReportId} is applied but has no appliedAt`);
    }
    if (report.syncState !== 'applied' && report.incidentId) {
      add('I8', `report ${report.clientReportId} is ${report.syncState} but names an incident`);
    }
    if (report.incidentId && !incidentIds.has(report.incidentId)) {
      add('I8', `report ${report.clientReportId} references unknown incident ${report.incidentId}`);
    }
    if (report.syncState === 'rejected' && !report.rejectionReason) {
      add('I8', `report ${report.clientReportId} is rejected with no reason`);
    }
  }

  // I9 — at most one plan awaits approval.
  const proposed = scenario.plans.filter((plan) => plan.status === 'proposed');
  if (proposed.length > 1) {
    add(
      'I9',
      `${proposed.length} plans are proposed at once, expected at most 1`,
      proposed.map((plan) => plan.id)
    );
  }

  // I10 — an approved plan's assignments are live; a proposed plan's are not.
  for (const plan of scenario.plans) {
    for (const assignment of plan.assignments) {
      if (plan.status === 'proposed' && assignment.status !== 'proposed') {
        add('I10', `proposed plan ${plan.id} holds a ${assignment.status} assignment`, [plan.id]);
      }
      if (plan.status === 'approved' && assignment.status === 'proposed') {
        add('I10', `approved plan ${plan.id} still holds a proposed assignment`, [plan.id]);
      }
    }
  }

  // I11 — modeled values stay labelled synthetic.
  for (const route of scenario.routes) {
    if (!route.synthetic) add('I11', `route ${route.id} is not marked synthetic`, [route.id]);
  }
  for (const bridge of scenario.bridges) {
    if (!bridge.synthetic) add('I11', `bridge ${bridge.id} is not marked synthetic`, [bridge.id]);
  }
  for (const plan of scenario.plans) {
    if (!plan.forecast.synthetic) {
      add('I11', `plan ${plan.id} has an unlabelled impact forecast`, [plan.id]);
    }
  }

  // I13 — modeled capacities stay within valid bounds.
  for (const facility of scenario.facilities) {
    if (facility.syntheticCapacity < 0) {
      add('I13', `facility ${facility.id} has negative modeled capacity`, [facility.id]);
    }
    if (facility.currentLoad < 0) {
      add('I13', `facility ${facility.id} has negative load`, [facility.id]);
    }
    if (facility.currentLoad > facility.syntheticCapacity) {
      add(
        'I13',
        `facility ${facility.id} is loaded ${facility.currentLoad} over a modeled capacity of ${facility.syntheticCapacity}`,
        [facility.id]
      );
    }
  }
  for (const resource of scenario.resources) {
    if (resource.crew < 0) add('I13', `resource ${resource.id} has negative crew`, [resource.id]);
  }
  for (const incident of scenario.incidents) {
    if (incident.peopleAtRisk < 0) {
      add('I13', `incident ${incident.id} has negative people at risk`, [incident.id]);
    }
  }

  // I12 — revision is a non-negative counter and event revisions never go back.
  if (!Number.isInteger(scenario.revision) || scenario.revision < 0) {
    add('I12', `revision ${String(scenario.revision)} is not a non-negative integer`);
  }
  let highest = -1;
  for (const event of scenario.events) {
    if (event.revision === undefined) continue;
    if (event.revision < highest) {
      add('I12', `event ${event.id} has revision ${event.revision} after ${highest}`, [event.id]);
    }
    highest = Math.max(highest, event.revision);
  }
  if (highest > scenario.revision) {
    add('I12', `event revision ${highest} exceeds scenario revision ${scenario.revision}`);
  }

  return violations;
};

/** Throws with every violation listed. Intended for tests and integration review. */
export const assertInvariants = (scenario: Scenario, context = 'scenario'): void => {
  const violations = checkInvariants(scenario);
  if (violations.length > 0) {
    const lines = violations.map((item) => `  ${item.invariant}: ${item.message}`).join('\n');
    throw new Error(`${context} violates ${violations.length} invariant(s):\n${lines}`);
  }
};
