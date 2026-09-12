import { SimulationEngine } from '@rescuemesh/engine';
import { pittsburghFloodScenario } from '@rescuemesh/shared';
import type { FrontendClient, Scenario } from './contract';
import { mockDeliberation } from './mock-deliberation';

export const createSeed = (): Scenario => structuredClone(pittsburghFloodScenario);

/** Local transport, same deterministic engine. No cloud clients or duplicate simulation rules. */
export function createMockClient(): FrontendClient {
  let engine = new SimulationEngine();
  let sessions = mockDeliberation(engine);
  /** Revision the last served advice analyzed, so staleness matches the backend. */
  let lastAdviceRevision = -1;
  return {
    mode: 'mock',
    startSimulation: (request) => sessions.startSimulation(request),
    simulation: (sessionId) => sessions.simulation(sessionId),
    finalPlan: (sessionId) => sessions.finalPlan(sessionId),
    scenario: async () => engine.scenario,
    poll: async (revision) => (revision === engine.revision ? null : engine.scenario),
    command: async (command) => {
      const result = engine.execute(command);
      if (result.ok && command.type === 'scenario.reset') {
        sessions.clear();
        engine = new SimulationEngine();
        sessions = mockDeliberation(engine);
        lastAdviceRevision = -1;
      }
      return result;
    },
    recommendations: async () => {
      const state = engine.scenario;
      lastAdviceRevision = state.revision;
      return state.recommendations.map((recommendation) => ({
        recommendation: {
          ...recommendation,
          status: 'pending' as const,
          // Mirrors the backend mock: only the commander's advice maps to a
          // supported engine command, so the UI must handle both cases.
          ...(recommendation.agent === 'incident_commander' && recommendation.relatedIncidentId
            ? {
                proposedAction: {
                  kind: 'plan.propose' as const,
                  incidentIds: [recommendation.relatedIncidentId]
                }
              }
            : {})
        },
        analyzedRevision: state.revision,
        source: {
          provider: 'mock' as const,
          model: 'scripted-chief-fixture',
          degraded: false,
          warning: 'Scripted advisory fixture. Cloud reasoning is not used in local mock mode.'
        }
      }));
    },
    /**
     * Local equivalent of the backend approval boundary: same staleness rule,
     * same translation to an existing engine command, same distinction between
     * proposing a plan and dispatching one.
     */
    approveAdvice: async (recommendationId, analyzedRevision) => {
      const state = engine.scenario;
      const found = state.recommendations.find((r) => r.id === recommendationId);
      if (!found)
        return {
          ok: false,
          recommendationId,
          revision: state.revision,
          refusal: { code: 'not_found', message: 'No such recommendation. Refresh chief advice.' }
        };
      if (analyzedRevision !== state.revision || lastAdviceRevision !== state.revision)
        return {
          ok: false,
          recommendationId,
          revision: state.revision,
          refusal: {
            code: 'stale_recommendation',
            message: `Advice analyzed revision ${analyzedRevision} but world state is at ${state.revision}. Refresh chief advice to revalidate.`,
            currentRevision: state.revision
          }
        };
      if (found.agent !== 'incident_commander' || !found.relatedIncidentId)
        return {
          ok: false,
          recommendationId,
          revision: state.revision,
          refusal: {
            code: 'advisory_only',
            message:
              'This recommendation is advisory only. Act on it through the operator controls.'
          }
        };
      const command = engine.execute({
        type: 'plan.propose',
        commandId: `approve-${recommendationId}-${state.revision}`,
        issuedAt: new Date().toISOString(),
        payload: { incidentIds: [found.relatedIncidentId] }
      });
      lastAdviceRevision = -1;
      return { ok: command.ok, recommendationId, revision: engine.revision, command };
    }
  };
}
