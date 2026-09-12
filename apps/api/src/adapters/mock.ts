import { pittsburghFloodScenario, type AgentRole, type Scenario } from '@rescuemesh/shared';
import type {
  AllocationAdapter,
  EdgeIntelligenceAdapter,
  GeographyAdapter,
  IdentityAdapter,
  ReasoningAdapter,
  VoiceAdapter,
  WorldStateStore
} from './contracts.js';

const clone = <T>(value: T): T => structuredClone(value);

export class MockWorldStateStore implements WorldStateStore {
  async loadScenario(): Promise<Scenario> {
    return clone(pittsburghFloodScenario);
  }
}

export class MockReasoningAdapter implements ReasoningAdapter {
  async parseReport(report: string) {
    return {
      title: 'Parsed field report',
      description: report.trim(),
      severity: report.toLowerCase().includes('trapped')
        ? ('critical' as const)
        : ('moderate' as const)
    };
  }

  async recommend(role: AgentRole, scenario: Scenario) {
    const existing = scenario.recommendations.find((item) => item.agent === role);
    if (!existing) throw new Error(`No deterministic recommendation seeded for ${role}`);
    const recommendation = clone(existing);
    // The incident commander's seeded advice maps onto a plan request, so the
    // approval boundary is demoable with no credentials at all. The other four
    // stay advisory-only, which is also what the UI must handle.
    if (role === 'incident_commander' && recommendation.relatedIncidentId) {
      recommendation.proposedAction = {
        kind: 'plan.propose',
        incidentIds: [recommendation.relatedIncidentId]
      };
    }
    recommendation.status = 'pending';
    return recommendation;
  }
}

export class MockAllocationAdapter implements AllocationAdapter {
  async propose(scenario: Scenario) {
    return clone(scenario.assignments);
  }
}

export class MockGeographyAdapter implements GeographyAdapter {
  async routes(scenario: Scenario) {
    return clone(scenario.routes);
  }
}

export class MockVoiceAdapter implements VoiceAdapter {
  async synthesize(message: string) {
    return { mode: 'mock' as const, transcript: message };
  }
}

export class MockIdentityAdapter implements IdentityAdapter {
  async currentRole() {
    return 'commander' as const;
  }
}

export class MockEdgeIntelligenceAdapter implements EdgeIntelligenceAdapter {
  async connectivity() {
    return 'offline-ready' as const;
  }
}
