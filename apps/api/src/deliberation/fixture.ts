import type {
  AgentRole,
  ChiefPosition,
  ChiefResponse,
  FinalOperationalBrief
} from '@rescuemesh/shared';

/**
 * Recorded deliberation, on the identical contract. Authored deterministic
 * content — never labelled "Gemini-generated". Used when Gemini is missing,
 * slow, blocked, or malformed, and for any single chief that fails.
 *
 * Fictional exercise content written against the Pittsburgh seed.
 */

export const FIXTURE_MODEL = 'recorded-deliberation-v1';

export const fixturePosition = (role: AgentRole): ChiefPosition => POSITIONS[role];
export const fixtureResponse = (role: AgentRole): ChiefResponse => RESPONSES[role];
export const fixtureBrief = (): FinalOperationalBrief => ({ ...BRIEF });

const POSITIONS: Record<AgentRole, ChiefPosition> = {
  incident_commander: {
    role: 'incident_commander',
    situationSummary:
      'Three active incidents; the Parkway entrapment is the only critical one and the west trail approach is already closed.',
    topPriorities: [
      'Life safety at the Parkway entrapment',
      'Keep one rescue asset uncommitted',
      'Protect the remaining river crossings'
    ],
    risks: [
      'Committing every boat leaves no reserve',
      'A second crossing closure would isolate the South Side'
    ],
    proposedActions: [
      'Request a resource plan weighted to the Parkway entrapment',
      'Hold one swift-water unit in reserve'
    ],
    confidence: 0.86
  },
  medical_chief: {
    role: 'medical_chief',
    situationSummary:
      'Modeled hospital load is uneven: AGH has the most spare capacity, Presbyterian the least.',
    topPriorities: ['Route criticals to AGH', 'Preserve Mercy for South Side walk-ins'],
    risks: ['Presbyterian saturates if transport defaults to nearest'],
    proposedActions: ['Direct new criticals to AGH', 'Keep one ALS unit uncommitted'],
    confidence: 0.83
  },
  police_chief: {
    role: 'police_chief',
    situationSummary:
      'One route is closed and access to the Parkway approach depends on holding traffic control.',
    topPriorities: ['Hold the eastbound approach', 'Keep evacuation routes signed'],
    risks: ['Only one police unit is currently available'],
    proposedActions: ['Commit the available unit to traffic control at the entrapment'],
    confidence: 0.8
  },
  rescue_chief: {
    role: 'rescue_chief',
    situationSummary:
      'Swift-water capability is the binding constraint; one boat is already committed.',
    topPriorities: ['Swift-water rescue at the Parkway entrapment', 'Maintain a reserve boat'],
    risks: ['No swift-water capacity remains if both boats commit'],
    proposedActions: ['Commit the nearest reachable boat', 'Stage the second boat east'],
    confidence: 0.88
  },
  logistics_chief: {
    role: 'logistics_chief',
    situationSummary:
      'Supply movement is constrained by the closed approach; staging is workable from the east.',
    topPriorities: ['Pre-position barriers', 'Keep the supply truck uncommitted'],
    risks: ['A supply run behind a closed crossing strands the truck'],
    proposedActions: ['Stage barriers near the entrapment approach'],
    confidence: 0.79
  }
};

const RESPONSES: Record<AgentRole, ChiefResponse> = {
  incident_commander: {
    role: 'incident_commander',
    agreements: [
      'Rescue Chief is right that swift-water is the binding constraint',
      'Medical Chief is right to protect Presbyterian'
    ],
    objections: ['Logistics staging should not consume the last available unit'],
    revisedPriority: 'Swift-water rescue at the Parkway entrapment, with one boat held back',
    recommendation: 'Request a plan focused on the critical entrapment and keep a reserve',
    confidence: 0.89
  },
  medical_chief: {
    role: 'medical_chief',
    agreements: ['Incident Commander is right to prioritise the entrapment'],
    objections: ['Committing the only ALS unit to a non-critical incident is premature'],
    revisedPriority: 'Hold ALS capacity for the entrapment casualties',
    recommendation: 'Transport criticals to AGH and keep the second ALS unit uncommitted',
    confidence: 0.85
  },
  police_chief: {
    role: 'police_chief',
    agreements: ['Traffic control is a prerequisite for the rescue, not a parallel task'],
    objections: ['Splitting the single available unit across two incidents helps neither'],
    revisedPriority: 'Traffic control at the entrapment approach first',
    recommendation: 'Commit the available unit to the entrapment and re-task once it is stable',
    confidence: 0.82
  },
  rescue_chief: {
    role: 'rescue_chief',
    agreements: ['Reserve discipline matters; one boat stays back'],
    objections: ['A closed route rules out the eastern approach for the second boat'],
    revisedPriority: 'Commit the reachable boat, stage the other where a route remains open',
    recommendation: 'One boat to the entrapment, one staged east and uncommitted',
    confidence: 0.9
  },
  logistics_chief: {
    role: 'logistics_chief',
    agreements: ['The truck should not go behind the closed crossing'],
    objections: [],
    revisedPriority: 'Stage from the east and keep the truck uncommitted',
    recommendation: 'Hold the supply truck until an approach is confirmed open',
    confidence: 0.81
  }
};

const BRIEF: FinalOperationalBrief = {
  situationSummary:
    'One critical entrapment with two supporting incidents. Swift-water capability and a single available police unit are the binding constraints; one river approach is closed.',
  pointsOfAgreement: [
    'The Parkway entrapment is the priority',
    'One swift-water unit is held in reserve',
    'Traffic control is a prerequisite for the rescue, not a parallel task'
  ],
  unresolvedDisputes: [
    'Whether the supply truck should stage forward or hold until an approach is confirmed'
  ],
  orderedPriorities: [
    'Swift-water rescue at the Parkway entrapment',
    'Traffic control on the entrapment approach',
    'Preserve hospital capacity at Presbyterian'
  ],
  proposedActions: ['Request a resource plan prioritising the critical entrapment'],
  rationale:
    'All five roles converge on the entrapment as the only life-safety-critical incident, and on keeping one swift-water asset uncommitted. Logistics staging is deferred because the closed crossing makes a forward position a modeled risk with no offsetting benefit.',
  confidence: 0.87
};
