// Frontend compatibility boundary for IMPLEMENTATION_CONTRACT.md (2026-09-12).
// Replace these extensions with shared exports after the contract branch is integrated.
import type { Scenario as SeedScenario, Assignment, AgentRecommendation } from '@rescuemesh/shared';

export interface Zone {
  id: string;
  name: string;
  connectivity: 'online' | 'degraded' | 'offline';
  facilityIds: string[];
  incidentIds: string[];
  connectivityChangedAt: string;
}
export interface Bridge {
  id: string;
  name: string;
  status: 'open' | 'closed';
  routeIds: string[];
  connectsZoneIds: [string, string];
  synthetic: true;
}
export interface ReportInput {
  clientReportId: string;
  zoneId: string;
  body: string;
  capturedAt: string;
}
export interface FieldReport extends ReportInput {
  syncState: 'queued' | 'pending' | 'applied' | 'duplicate' | 'rejected';
  appliedAt?: string;
  incidentId?: string;
  rejectionReason?: string;
}
export interface Plan {
  id: string;
  status: 'proposed' | 'approved' | 'superseded' | 'rejected';
  createdAt: string;
  basedOnRevision: number;
  generatedBy: 'seeded' | 'mock' | 'or_tools';
  assignments: Assignment[];
  rationale: string;
  shortfalls: { incidentId: string; missingCapabilities: string[]; reason: string }[];
  forecast: {
    synthetic: true;
    peopleReachableWithin30Min: number;
    unmetCapabilityCount: number;
    modeledTotalTravelMinutes: number;
  };
}
export interface Scenario extends Omit<SeedScenario, 'events'> {
  revision: number;
  zones: Zone[];
  bridges: Bridge[];
  reports: FieldReport[];
  plans: Plan[];
  events: {
    id: string;
    occurredAt: string;
    type: string;
    message: string;
    entityIds: string[];
    revision?: number;
  }[];
}
export interface Payloads {
  'scenario.trigger_flood': {
    intensity: 'moderate' | 'severe' | 'catastrophic';
    zoneIds?: string[];
  };
  'route.close_bridge': { bridgeId: string; closed: boolean };
  'zone.set_connectivity': { zoneId: string; connectivity: Zone['connectivity'] };
  'report.submit': ReportInput;
  'report.sync': { reports: ReportInput[] };
  'plan.propose': { incidentIds?: string[]; reserveUnitsPerKind?: number };
  'plan.approve': { planId: string };
  'scenario.reset': Record<string, never>;
}
export type CommandType = keyof Payloads;
export type Command = {
  [K in CommandType]: {
    type: K;
    payload: Payloads[K];
    commandId: string;
    issuedAt: string;
    expectedRevision?: number;
  };
}[CommandType];
export interface Results {
  'scenario.trigger_flood': { raisedIncidents: Scenario['incidents']; affectedZoneIds: string[] };
  'route.close_bridge': { bridgeId: string; closedRouteIds: string[] };
  'zone.set_connectivity': { zone: Zone; syncableReportIds: string[] };
  'report.submit': { report: FieldReport; queuedOffline: boolean };
  'report.sync': { applied: FieldReport[]; duplicates: FieldReport[]; rejected: FieldReport[] };
  'plan.propose': { plan: Plan };
  'plan.approve': { plan: Plan; assignedResourceIds: string[] };
  'scenario.reset': { scenario: Scenario };
}
export type CommandResponse =
  | {
      [K in CommandType]: {
        ok: true;
        type: K;
        commandId: string;
        revision: number;
        appliedAt: string;
        duplicate: boolean;
        data: Results[K];
        events: Scenario['events'];
      };
    }[CommandType]
  | {
      ok: false;
      type: CommandType | 'unknown';
      commandId: string;
      revision: number;
      error: { code: string; message: string; retryable: boolean };
    };
export interface Recommendation {
  recommendation: AgentRecommendation;
  source: {
    provider: 'ifm' | 'gemini' | 'mock';
    model: string;
    degraded: boolean;
    warning?: string;
  };
}
export interface FrontendClient {
  mode: 'mock' | 'api';
  scenario(): Promise<Scenario>;
  poll(revision: number): Promise<Scenario | null>;
  recommendations(): Promise<Recommendation[]>;
  command(command: Command): Promise<CommandResponse>;
}
