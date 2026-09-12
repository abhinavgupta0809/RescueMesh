import type {
  AgentRecommendation,
  AgentRole,
  Assignment,
  Incident,
  Route,
  Scenario
} from '@rescuemesh/shared';

export interface ReasoningAdapter {
  parseReport(report: string): Promise<Pick<Incident, 'title' | 'description' | 'severity'>>;
  recommend(role: AgentRole, scenario: Scenario): Promise<AgentRecommendation>;
}

export interface AllocationAdapter {
  propose(scenario: Scenario): Promise<Assignment[]>;
}

export interface WorldStateStore {
  loadScenario(): Promise<Scenario>;
}

export interface GeographyAdapter {
  routes(scenario: Scenario): Promise<Route[]>;
}

export interface VoiceAdapter {
  synthesize(message: string): Promise<{ mode: 'mock'; transcript: string }>;
}

export interface IdentityAdapter {
  currentRole(): Promise<'commander' | 'observer'>;
}

export interface EdgeIntelligenceAdapter {
  connectivity(): Promise<'online' | 'offline-ready'>;
}
