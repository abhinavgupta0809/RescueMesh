import {
  MAX_DEVELOPMENTS_PER_STEP,
  SCENARIO_STEPS,
  type ScenarioStepName,
  type ScriptedBatch,
  type ScriptedEvent,
  type ScriptedEventKind
} from '@rescuemesh/shared';

/**
 * The recorded Pittsburgh exercise script.
 *
 * Deterministic TypeScript, authored by hand. **No model produces any of this**,
 * so the sequence is identical on every run, works with no network and no
 * credentials, and must never be presented as AI-generated content.
 *
 * Everything below is FICTIONAL exercise content written against the seed. It
 * does not describe real infrastructure or predict real flooding.
 */

interface ScriptedStep {
  rationale: string;
  assumptions: string[];
  developments: ScriptedEvent[];
}

const SEQUENCE: Record<ScenarioStepName, ScriptedStep> = {
  initial_flooding: {
    rationale:
      'Rainfall continues over the Monongahela basin, so low-lying ground away from the ' +
      'first three incidents begins to take water and an existing trail washout worsens.',
    assumptions: [
      'Rain has not stopped since the exercise clock started.',
      'Downtown storm drains are already at modeled capacity.'
    ],
    developments: [
      {
        kind: 'incident.raise',
        localRef: 'flood-downtown-1',
        zoneId: 'zone-downtown',
        title: 'Strip District street flooding',
        description:
          'Modeled drain backup putting water across a commercial block; vehicles stalling.',
        severity: 'moderate',
        peopleAtRisk: 8,
        requiredCapabilities: ['evacuation', 'traffic-control']
      },
      {
        kind: 'incident.escalate',
        incidentId: 'inc-trail',
        toSeverity: 'high',
        peopleAtRiskDelta: 3
      },
      {
        kind: 'scenario.phase',
        phase: 'escalating',
        note: 'Water still rising; expect access to degrade before it improves.'
      }
    ]
  },

  bridge_disruption: {
    rationale:
      'With the river up, the modeled Uptown-to-South-Side crossing is no longer usable, ' +
      'which pushes casualty transport onto the remaining hospitals.',
    assumptions: [
      'The closure holds for the rest of the exercise unless an operator reopens it.',
      'Crews will reroute rather than wait.'
    ],
    developments: [
      { kind: 'route.restrict', routeId: 'route-mercy-south', status: 'closed' },
      { kind: 'facility.demand', facilityId: 'h-mercy', loadDelta: 3 },
      {
        kind: 'scenario.phase',
        phase: 'escalating',
        note: 'Crossing lost; transport times lengthen and hospital demand shifts.'
      }
    ]
  },

  evacuation_pressure: {
    rationale:
      'Residents are self-evacuating ahead of instructions, which raises modeled hospital ' +
      'demand and turns the South Side basement calls into a life-safety problem.',
    assumptions: [
      'Self-evacuation outpaces formal evacuation orders.',
      'Shelter intake is being recorded as hospital load in this model.'
    ],
    developments: [
      { kind: 'facility.demand', facilityId: 'h-presby', loadDelta: 5 },
      {
        kind: 'incident.escalate',
        incidentId: 'inc-southside',
        toSeverity: 'critical',
        peopleAtRiskDelta: 6
      },
      {
        kind: 'incident.raise',
        localRef: 'flood-oakland-1',
        zoneId: 'zone-oakland',
        title: 'Bates Street approach cut off',
        description:
          'Modeled standing water isolating a block of residences uphill of the incident.',
        severity: 'high',
        peopleAtRisk: 11,
        requiredCapabilities: ['evacuation']
      }
    ]
  },

  zone_connectivity_loss: {
    rationale:
      'A modeled repeater failure takes the South Side off the network. Field reports from ' +
      'that zone stop arriving centrally and a supply run is held up behind the water.',
    assumptions: [
      'The zone still has radio-to-radio contact but no link to the command center.',
      'Reports captured while offline will arrive in a batch on reconnection.'
    ],
    developments: [
      {
        kind: 'report.inject',
        localRef: 'report-southside-1',
        zoneId: 'zone-south-side',
        body:
          'Sarah Street: water at chest height in two basement units, one resident refusing ' +
          'to leave. Requesting swift-water assistance.'
      },
      {
        kind: 'resource.delay',
        resourceId: 'log-1',
        delayMinutes: 25,
        reason: 'modeled supply run held behind the closed crossing'
      },
      {
        kind: 'scenario.phase',
        phase: 'holding',
        note: 'Partial picture: one zone dark, queued reports pending reconnection.'
      }
    ]
  },

  response_adaptation: {
    rationale:
      'Dispatched crews and traffic control are taking effect: the North Shore approach ' +
      'clears and Mercy works down its modeled backlog.',
    assumptions: [
      'Approved assignments are actually on scene.',
      'Pumping has begun on the worst approach.'
    ],
    developments: [
      { kind: 'route.restore', routeId: 'route-river-parkway' },
      { kind: 'facility.demand', facilityId: 'h-mercy', loadDelta: -2 },
      {
        kind: 'scenario.phase',
        phase: 'holding',
        note: 'Access improving; demand flattening but not yet falling.'
      }
    ]
  },

  stabilization: {
    rationale:
      'Rain has moved east of the basin. Water is receding on the trail and the South Side ' +
      'block is cleared, so the exercise can be brought to a close.',
    assumptions: [
      'No further rainfall in the exercise window.',
      'Evacuated residents are accounted for at shelters.'
    ],
    developments: [
      { kind: 'incident.stabilize', incidentId: 'inc-trail', toSeverity: 'moderate' },
      { kind: 'incident.stabilize', incidentId: 'inc-southside', toSeverity: 'high' },
      {
        kind: 'scenario.phase',
        phase: 'stabilizing',
        note: 'Rainfall ended; recovery and accounting phase.'
      }
    ]
  }
};

/** Which developments each named step may produce. Enforced by validation. */
export const STEP_ALLOWED_KINDS: Record<ScenarioStepName, ScriptedEventKind[]> = {
  initial_flooding: ['incident.raise', 'incident.escalate', 'report.inject', 'scenario.phase'],
  bridge_disruption: ['route.restrict', 'facility.demand', 'scenario.phase'],
  evacuation_pressure: [
    'incident.raise',
    'incident.escalate',
    'facility.demand',
    'report.inject',
    'scenario.phase'
  ],
  zone_connectivity_loss: ['report.inject', 'resource.delay', 'scenario.phase'],
  response_adaptation: ['route.restore', 'facility.demand', 'resource.delay', 'scenario.phase'],
  stabilization: ['incident.stabilize', 'route.restore', 'facility.demand', 'scenario.phase']
};

export const SCRIPT_VERSION = 'recorded-pittsburgh-sequence-v1';

/** Resolves one step of the script against the current revision. Pure. */
export const resolveStep = (step: ScenarioStepName, basedOnRevision: number): ScriptedBatch => {
  const scripted = SEQUENCE[step];
  const allowed = new Set(STEP_ALLOWED_KINDS[step]);
  return {
    batchId: `${SCRIPT_VERSION}-${step}-r${basedOnRevision}`,
    basedOnRevision,
    step,
    rationale: scripted.rationale,
    assumptions: [...scripted.assumptions],
    developments: scripted.developments
      .filter((development) => allowed.has(development.kind))
      .slice(0, MAX_DEVELOPMENTS_PER_STEP)
  };
};

export const scenarioSteps = (): readonly ScenarioStepName[] => SCENARIO_STEPS;
