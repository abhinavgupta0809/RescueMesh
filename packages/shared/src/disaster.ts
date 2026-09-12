import type { Scenario, Severity } from './types.js';

/**
 * ── Multi-hazard exercises ────────────────────────────────────────────────────
 *
 * An exercise is one or two operator-selected disasters, applied as a single
 * engine transition before any deliberation begins. The engine remains the sole
 * authority: this module only describes and validates what the operator asked
 * for, and every value it produces is synthetic exercise content.
 */

export type DisasterKind = 'flash_flood' | 'structural_fire' | 'multi_vehicle_collision';

export const DISASTER_KINDS: readonly DisasterKind[] = [
  'flash_flood',
  'structural_fire',
  'multi_vehicle_collision'
];

export const isDisasterKind = (value: unknown): value is DisasterKind =>
  typeof value === 'string' && (DISASTER_KINDS as readonly string[]).includes(value);

export const DISASTER_SEVERITIES: readonly Severity[] = ['critical', 'high', 'moderate', 'low'];

/** One or two per exercise. */
export const MAX_DISASTERS_PER_EXERCISE = 2;

export interface DisasterSpecification {
  kind: DisasterKind;
  /** Must be an existing zone id. Downtown is explicitly supported. */
  zoneId: string;
  severity: Severity;
}

export interface ExerciseSpecification {
  disasters: DisasterSpecification[];
}

/**
 * Capability templates, derived from the ACTUAL seed vocabulary:
 * advanced-life-support, barriers, evacuation, fire-suppression,
 * high-water-response, medical-supplies, swift-water-rescue, traffic-control.
 *
 * Nothing here requires a capability no resource type carries — an unservable
 * requirement would be a permanent, meaningless shortfall.
 *
 * Note on extrication: the seed has no `extrication` capability. Fire engines
 * are the extrication asset in practice, so a collision calls for
 * `fire-suppression` rather than inventing a capability nothing can serve.
 */
export interface DisasterTemplate {
  label: string;
  requiredCapabilities: string[];
  /** People at risk at `moderate`; scaled by severity below. */
  basePeopleAtRisk: number;
  title: (zoneName: string) => string;
  description: (zoneName: string, severity: Severity) => string;
  /** Whether this kind deterministically slows a modeled route in its zone. */
  slowsLocalRoute: boolean;
}

const SEVERITY_SCALE: Record<Severity, number> = {
  critical: 3,
  high: 2,
  moderate: 1,
  low: 0.5
};

export const DISASTER_TEMPLATES: Record<DisasterKind, DisasterTemplate> = {
  flash_flood: {
    label: 'Flash flood',
    requiredCapabilities: [
      'swift-water-rescue',
      'evacuation',
      'advanced-life-support',
      'traffic-control'
    ],
    basePeopleAtRisk: 8,
    title: (zone) => `Flash flooding — ${zone}`,
    description: (zone, severity) =>
      `Modeled ${severity} flash flooding across low-lying ground in ${zone}. ` +
      'Water rescue, evacuation and casualty transport required. Synthetic exercise content.',
    slowsLocalRoute: false
  },
  structural_fire: {
    label: 'Structural fire',
    requiredCapabilities: [
      'fire-suppression',
      'evacuation',
      'advanced-life-support',
      'traffic-control'
    ],
    basePeopleAtRisk: 6,
    title: (zone) => `Structural fire — ${zone}`,
    description: (zone, severity) =>
      `Modeled ${severity} structural fire with occupants unaccounted for in ${zone}. ` +
      'Suppression, evacuation and casualty care required. Synthetic exercise content.',
    slowsLocalRoute: false
  },
  multi_vehicle_collision: {
    label: 'Multi-vehicle collision',
    requiredCapabilities: ['advanced-life-support', 'traffic-control', 'fire-suppression'],
    basePeopleAtRisk: 5,
    title: (zone) => `Multi-vehicle collision — ${zone}`,
    description: (zone, severity) =>
      `Modeled ${severity} multi-vehicle collision blocking a carriageway in ${zone}. ` +
      'Casualty care, scene control and fire-engine support for extrication required. ' +
      'Synthetic exercise content.',
    slowsLocalRoute: true
  }
};

/** Deterministic: the same specification always yields the same figure. */
export const peopleAtRiskFor = (kind: DisasterKind, severity: Severity): number =>
  Math.max(1, Math.round(DISASTER_TEMPLATES[kind].basePeopleAtRisk * SEVERITY_SCALE[severity]));

// ── Validation ───────────────────────────────────────────────────────────────

export type ExerciseRejectionCode =
  | 'no_disasters'
  | 'too_many_disasters'
  | 'unknown_kind'
  | 'unknown_zone'
  | 'invalid_severity'
  | 'duplicate_disaster'
  | 'invalid_payload';

export interface ExerciseRejection {
  code: ExerciseRejectionCode;
  message: string;
  /** Index into the submitted list, when the fault belongs to one disaster. */
  index?: number;
}

export type ExerciseValidation =
  { ok: true; disasters: DisasterSpecification[] } | { ok: false; rejection: ExerciseRejection };

/**
 * Validates a complete exercise. An exercise is accepted or refused as a whole:
 * one bad disaster rejects the request rather than applying a partial world.
 */
export const validateExercise = (raw: unknown, scenario: Scenario): ExerciseValidation => {
  const list = Array.isArray(raw) ? raw : undefined;
  if (!list) {
    return {
      ok: false,
      rejection: { code: 'invalid_payload', message: 'disasters must be an array' }
    };
  }
  if (list.length === 0) {
    return {
      ok: false,
      rejection: { code: 'no_disasters', message: 'select at least one disaster' }
    };
  }
  if (list.length > MAX_DISASTERS_PER_EXERCISE) {
    return {
      ok: false,
      rejection: {
        code: 'too_many_disasters',
        message: `an exercise may contain at most ${MAX_DISASTERS_PER_EXERCISE} disasters`
      }
    };
  }

  const zoneIds = new Set(scenario.zones.map((zone) => zone.id));
  const seen = new Set<string>();
  const disasters: DisasterSpecification[] = [];

  for (const [index, entry] of list.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return {
        ok: false,
        rejection: { code: 'invalid_payload', message: 'each disaster must be an object', index }
      };
    }
    const candidate = entry as Record<string, unknown>;
    if (!isDisasterKind(candidate.kind)) {
      return {
        ok: false,
        rejection: {
          code: 'unknown_kind',
          message: `unknown disaster kind ${JSON.stringify(candidate.kind)}`,
          index
        }
      };
    }
    if (typeof candidate.zoneId !== 'string' || !zoneIds.has(candidate.zoneId)) {
      return {
        ok: false,
        rejection: {
          code: 'unknown_zone',
          message: `unknown zone ${JSON.stringify(candidate.zoneId)}`,
          index
        }
      };
    }
    if (
      typeof candidate.severity !== 'string' ||
      !(DISASTER_SEVERITIES as readonly string[]).includes(candidate.severity)
    ) {
      return {
        ok: false,
        rejection: {
          code: 'invalid_severity',
          message: `invalid severity ${JSON.stringify(candidate.severity)}`,
          index
        }
      };
    }
    // Two different kinds in one zone is fine; the same kind twice in one zone
    // would be two indistinguishable incidents, so it is refused.
    const fingerprint = `${candidate.kind}::${candidate.zoneId}`;
    if (seen.has(fingerprint)) {
      return {
        ok: false,
        rejection: {
          code: 'duplicate_disaster',
          message: `${candidate.kind} is already selected for ${candidate.zoneId}`,
          index
        }
      };
    }
    seen.add(fingerprint);
    disasters.push({
      kind: candidate.kind,
      zoneId: candidate.zoneId,
      severity: candidate.severity as Severity
    });
  }

  return { ok: true, disasters };
};

/**
 * The route a collision in this zone slows: the lowest-id `open` route leaving a
 * facility the zone owns. Routes gated by a closed bridge are skipped so that
 * closing a bridge and slowing a route cannot contradict each other (I6).
 * Returns undefined when the zone owns no such route — in which case the
 * exercise changes no routes at all rather than inventing a reference.
 */
export const collisionSlowdownRouteId = (
  scenario: Scenario,
  zoneId: string
): string | undefined => {
  const zone = scenario.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) return undefined;
  const facilities = new Set(zone.facilityIds);
  const gated = new Set(
    scenario.bridges
      .filter((bridge) => bridge.status === 'closed')
      .flatMap((bridge) => bridge.routeIds)
  );
  return scenario.routes
    .filter(
      (route) => route.status === 'open' && facilities.has(route.fromId) && !gated.has(route.id)
    )
    .map((route) => route.id)
    .sort()
    .at(0);
};
