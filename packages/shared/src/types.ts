export type FacilityKind = 'hospital' | 'fire_house' | 'police_hub' | 'rescue_center';
export type ResourceKind =
  'ambulance' | 'fire_engine' | 'police_unit' | 'rescue_boat' | 'supply_truck';
export type ResourceStatus = 'available' | 'assigned' | 'en_route' | 'offline';
export type Severity = 'critical' | 'high' | 'moderate' | 'low';
export type AgentRole =
  'incident_commander' | 'medical_chief' | 'police_chief' | 'rescue_chief' | 'logistics_chief';

export interface Coordinate {
  lat: number;
  lng: number;
}

export interface Facility {
  id: string;
  name: string;
  kind: FacilityKind;
  location: Coordinate;
  syntheticCapacity: number;
  currentLoad: number;
  status: 'operational' | 'limited' | 'closed';
}

export interface Resource {
  id: string;
  callsign: string;
  kind: ResourceKind;
  homeFacilityId: string;
  status: ResourceStatus;
  crew: number;
  capabilities: string[];
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  location: Coordinate;
  address: string;
  reportedAt: string;
  status: 'active' | 'contained' | 'resolved';
  peopleAtRisk: number;
  requiredCapabilities: string[];
}

export interface Route {
  id: string;
  fromId: string;
  toId: string;
  distanceKm: number;
  travelMinutes: number;
  status: 'open' | 'slow' | 'closed';
  synthetic: boolean;
}

export interface Assignment {
  id: string;
  incidentId: string;
  resourceIds: string[];
  destinationFacilityId?: string;
  priority: number;
  status: 'proposed' | 'approved' | 'dispatched' | 'complete';
  rationale: string;
}

/**
 * The bounded set of actions a chief's advice may map onto. Everything else is
 * advisory-only prose: approving it changes nothing.
 *
 * Each member corresponds to an EXISTING engine command. Approval never invents
 * a new capability, and the engine validates the resulting command exactly as it
 * validates an operator's own.
 */
export type ApprovableAction = {
  kind: 'plan.propose';
  /** Limit the plan to these incidents. Must be existing incident ids. */
  incidentIds?: string[];
  /** Keep this many available units of each kind in reserve. */
  reserveUnitsPerKind?: number;
};

export interface AgentRecommendation {
  id: string;
  agent: AgentRole;
  summary: string;
  confidence: number;
  action: string;
  relatedIncidentId?: string;
  createdAt: string;
  status: 'pending' | 'accepted' | 'dismissed';
  /**
   * Present only when this advice maps onto a supported engine command. Absent
   * means the recommendation is advisory-only and cannot be executed.
   */
  proposedAction?: ApprovableAction;
}

export type WorldStateEventType =
  | 'incident_reported'
  | 'road_changed'
  | 'resource_dispatched'
  | 'facility_updated'
  | 'flood_triggered'
  | 'bridge_closed'
  | 'zone_connectivity_changed'
  | 'report_queued'
  | 'report_applied'
  | 'plan_proposed'
  | 'plan_approved'
  | 'scenario_reset'
  | 'scenario_step_applied'
  | 'scenario_development_refused'
  | 'exercise_started';

export interface WorldStateEvent {
  id: string;
  occurredAt: string;
  type: WorldStateEventType;
  message: string;
  entityIds: string[];
  /** Revision the world state reached when this event was appended. */
  revision?: number;
}

/**
 * ── Connectivity state ────────────────────────────────────────────────────────
 * Whether a zone can reach the command center. Independent of report sync state
 * and of resource assignment state; see docs/IMPLEMENTATION_CONTRACT.md.
 */
export type ZoneConnectivity = 'online' | 'degraded' | 'offline';

export interface Zone {
  id: string;
  name: string;
  connectivity: ZoneConnectivity;
  facilityIds: string[];
  incidentIds: string[];
  connectivityChangedAt: string;
}

export interface Bridge {
  id: string;
  name: string;
  status: 'open' | 'closed';
  /** Routes that become unusable while this bridge is closed. */
  routeIds: string[];
  connectsZoneIds: [string, string];
  /** Always true: this is a modeled crossing, not a live infrastructure feed. */
  synthetic: true;
}

/**
 * ── Report synchronization state ──────────────────────────────────────────────
 * A field report's journey from an offline device to applied world state.
 * `clientReportId` is the idempotency key and is generated on the device.
 */
export type FieldReportSyncState = 'queued' | 'pending' | 'applied' | 'duplicate' | 'rejected';

export interface FieldReport {
  clientReportId: string;
  zoneId: string;
  body: string;
  capturedAt: string;
  syncState: FieldReportSyncState;
  appliedAt?: string;
  /** Set once the report has been turned into an incident draft. */
  incidentId?: string;
  rejectionReason?: string;
}

/**
 * ── Resource assignment state ─────────────────────────────────────────────────
 * A plan is the reviewable unit. Resources move to `assigned` only when a plan
 * is approved by a human.
 */
export type AllocationProvider = 'seeded' | 'mock' | 'or_tools';
export type ResourcePlanStatus = 'proposed' | 'approved' | 'superseded' | 'rejected';

export interface PlanShortfall {
  incidentId: string;
  missingCapabilities: string[];
  reason: string;
}

/** Every number here is modeled for the exercise, never measured. */
export interface SyntheticImpactForecast {
  synthetic: true;
  peopleReachableWithin30Min: number;
  unmetCapabilityCount: number;
  modeledTotalTravelMinutes: number;
}

export interface ResourcePlan {
  id: string;
  status: ResourcePlanStatus;
  createdAt: string;
  /** Revision the plan was computed against; used to detect a stale approval. */
  basedOnRevision: number;
  generatedBy: AllocationProvider;
  assignments: Assignment[];
  rationale: string;
  shortfalls: PlanShortfall[];
  forecast: SyntheticImpactForecast;
}

export interface Scenario {
  id: string;
  name: string;
  city: 'Pittsburgh';
  /** Monotonic counter. Increments by exactly one per applied command. */
  revision: number;
  /** Narrative phase, moved only by the recorded scenario script. */
  phase: 'escalating' | 'holding' | 'stabilizing';
  simulatedTime: string;
  status: 'monitoring' | 'active' | 'stabilizing';
  facilities: Facility[];
  resources: Resource[];
  incidents: Incident[];
  routes: Route[];
  zones: Zone[];
  bridges: Bridge[];
  assignments: Assignment[];
  plans: ResourcePlan[];
  reports: FieldReport[];
  recommendations: AgentRecommendation[];
  events: WorldStateEvent[];
}
