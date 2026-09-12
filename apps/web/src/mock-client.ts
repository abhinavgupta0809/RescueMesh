import { SimulationEngine } from '@rescuemesh/engine';
import { pittsburghFloodScenario } from '@rescuemesh/shared';
import type { FrontendClient, Scenario } from './contract';

export const createSeed = (): Scenario => structuredClone(pittsburghFloodScenario);

/** Local transport, same deterministic engine. No cloud clients or duplicate simulation rules. */
export function createMockClient(): FrontendClient {
  const engine = new SimulationEngine();
  return {
    mode: 'mock',
    scenario: async () => engine.scenario,
    poll: async (revision) => (revision === engine.revision ? null : engine.scenario),
    command: async (command) => engine.execute(command),
    recommendations: async () => {
      const state = engine.scenario;
      return state.recommendations.map((recommendation) => ({
        recommendation: { ...recommendation, status: 'pending' },
        analyzedRevision: state.revision,
        source: {
          provider: 'mock',
          model: 'scripted-chief-fixture',
          degraded: false,
          warning: 'Scripted advisory fixture. Cloud reasoning is not used in local mock mode.'
        }
      }));
    }
  };
}
