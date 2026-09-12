import type {
  Assignment,
  Incident,
  PlanShortfall,
  Resource,
  Scenario,
  Severity,
  SyntheticImpactForecast
} from '@rescuemesh/shared';

/**
 * A simple deterministic allocator — greedy, capability-first, with stable
 * tie-breaks. This is NOT a solver and must not be described as optimization:
 * it produces a defensible, explainable, reproducible plan, nothing more.
 */

/** Used when no modeled route record exists between a unit's home and an incident. */
export const MODELED_FALLBACK_TRAVEL_MINUTES = 18;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };

const MEDICAL_CAPABILITIES = new Set(['advanced-life-support', 'basic-life-support']);

export interface AllocationInput {
  scenario: Scenario;
  /** Limit to these incidents; empty or absent means every active incident. */
  incidentIds?: string[];
  /** Keep this many available units of each kind unassigned as a reserve. */
  reserveUnitsPerKind: number;
}

export interface AllocationOutput {
  assignments: Assignment[];
  rationale: string;
  shortfalls: PlanShortfall[];
  forecast: SyntheticImpactForecast;
}

/** Modeled travel time from a unit's home facility to an incident. */
export const modeledTravelMinutes = (
  scenario: Scenario,
  resource: Resource,
  incidentId: string
): number => {
  const route = scenario.routes.find(
    (candidate) => candidate.fromId === resource.homeFacilityId && candidate.toId === incidentId
  );
  return route?.travelMinutes ?? MODELED_FALLBACK_TRAVEL_MINUTES;
};

/**
 * A unit is reachable unless a modeled route exists and is closed. Absence of a
 * route record means "not modeled", not "impassable".
 */
export const isReachable = (
  scenario: Scenario,
  resource: Resource,
  incidentId: string
): boolean => {
  const route = scenario.routes.find(
    (candidate) => candidate.fromId === resource.homeFacilityId && candidate.toId === incidentId
  );
  return route?.status !== 'closed';
};

const bestHospitalId = (scenario: Scenario): string | undefined =>
  scenario.facilities
    .filter((facility) => facility.kind === 'hospital' && facility.status !== 'closed')
    .map((facility) => ({
      id: facility.id,
      spare: facility.syntheticCapacity - facility.currentLoad
    }))
    .sort((a, b) => b.spare - a.spare || a.id.localeCompare(b.id))
    .at(0)?.id;

const orderIncidents = (incidents: Incident[]): Incident[] =>
  [...incidents].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.peopleAtRisk - a.peopleAtRisk ||
      a.id.localeCompare(b.id)
  );

export const allocate = (
  input: AllocationInput,
  nextAssignmentId: () => string
): AllocationOutput => {
  const { scenario, reserveUnitsPerKind } = input;
  const wanted = new Set(input.incidentIds ?? []);
  const targets = orderIncidents(
    scenario.incidents.filter(
      (incident) => incident.status === 'active' && (wanted.size === 0 || wanted.has(incident.id))
    )
  );

  const available = scenario.resources.filter((resource) => resource.status === 'available');
  const remainingByKind = new Map<string, number>();
  for (const resource of available) {
    remainingByKind.set(resource.kind, (remainingByKind.get(resource.kind) ?? 0) + 1);
  }

  const committed = new Set<string>();
  const assignments: Assignment[] = [];
  const shortfalls: PlanShortfall[] = [];
  const rationaleParts: string[] = [];
  let totalTravelMinutes = 0;
  let peopleReachable = 0;

  for (const [index, incident] of targets.entries()) {
    const chosen: Resource[] = [];
    const unmet: string[] = [];

    for (const capability of incident.requiredCapabilities) {
      const candidates = available
        .filter(
          (resource) =>
            !committed.has(resource.id) &&
            resource.capabilities.includes(capability) &&
            isReachable(scenario, resource, incident.id) &&
            (remainingByKind.get(resource.kind) ?? 0) > reserveUnitsPerKind
        )
        .sort((a, b) => {
          const byTravel =
            modeledTravelMinutes(scenario, a, incident.id) -
            modeledTravelMinutes(scenario, b, incident.id);
          return byTravel || b.crew - a.crew || a.id.localeCompare(b.id);
        });

      const pick = candidates.at(0);
      if (!pick) {
        unmet.push(capability);
        continue;
      }
      committed.add(pick.id);
      remainingByKind.set(pick.kind, (remainingByKind.get(pick.kind) ?? 0) - 1);
      chosen.push(pick);
      totalTravelMinutes += modeledTravelMinutes(scenario, pick, incident.id);
    }

    if (unmet.length > 0) {
      shortfalls.push({
        incidentId: incident.id,
        missingCapabilities: unmet,
        reason:
          available.length === 0
            ? 'no units are available'
            : `no available, reachable unit carries ${unmet.join(' or ')} within the reserve guardrail`
      });
    }

    if (chosen.length === 0) continue;

    const needsHospital =
      incident.severity === 'critical' ||
      incident.requiredCapabilities.some((capability) => MEDICAL_CAPABILITIES.has(capability));
    const destinationFacilityId = needsHospital ? bestHospitalId(scenario) : undefined;
    const slowest = Math.max(
      ...chosen.map((resource) => modeledTravelMinutes(scenario, resource, incident.id))
    );
    if (slowest <= 30) peopleReachable += incident.peopleAtRisk;

    const covered = incident.requiredCapabilities.filter(
      (capability) => !unmet.includes(capability)
    );
    assignments.push({
      id: nextAssignmentId(),
      incidentId: incident.id,
      resourceIds: chosen.map((resource) => resource.id),
      priority: index + 1,
      status: 'proposed',
      rationale:
        `${incident.severity} incident, ${incident.peopleAtRisk} at risk. ` +
        `${chosen.map((resource) => resource.callsign).join(' + ')} cover ${covered.join(', ') || 'general response'}; ` +
        `modeled arrival ${slowest} min.` +
        (unmet.length > 0 ? ` Unmet: ${unmet.join(', ')}.` : '') +
        (destinationFacilityId
          ? ` Transport to ${destinationFacilityId} (most modeled spare capacity).`
          : ''),
      ...(destinationFacilityId ? { destinationFacilityId } : {})
    });
    rationaleParts.push(
      `${incident.id}: ${chosen.map((resource) => resource.callsign).join(' + ')} (${slowest} min)`
    );
  }

  const rationale =
    assignments.length === 0
      ? 'No assignment could be formed: no available, reachable unit matched any required capability.'
      : `Greedy capability-first match over ${targets.length} active incident(s), severity then people-at-risk. ` +
        `${rationaleParts.join('; ')}. Reserve kept: ${reserveUnitsPerKind} unit(s) per kind. ` +
        'All travel times and capacities are modeled for this exercise.';

  return {
    assignments,
    rationale,
    shortfalls,
    forecast: {
      synthetic: true,
      peopleReachableWithin30Min: peopleReachable,
      unmetCapabilityCount: shortfalls.reduce(
        (sum, shortfall) => sum + shortfall.missingCapabilities.length,
        0
      ),
      modeledTotalTravelMinutes: totalTravelMinutes
    }
  };
};
