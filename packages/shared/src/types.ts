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

export interface AgentRecommendation {
  id: string;
  agent: AgentRole;
  summary: string;
  confidence: number;
  action: string;
  relatedIncidentId?: string;
  createdAt: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

export interface WorldStateEvent {
  id: string;
  occurredAt: string;
  type: 'incident_reported' | 'road_changed' | 'resource_dispatched' | 'facility_updated';
  message: string;
  entityIds: string[];
}

export interface Scenario {
  id: string;
  name: string;
  city: 'Pittsburgh';
  simulatedTime: string;
  status: 'monitoring' | 'active' | 'stabilizing';
  facilities: Facility[];
  resources: Resource[];
  incidents: Incident[];
  routes: Route[];
  assignments: Assignment[];
  recommendations: AgentRecommendation[];
  events: WorldStateEvent[];
}
