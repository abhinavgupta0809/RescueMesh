import type { SimulationEngine } from '@rescuemesh/engine';
import { type DeliberationSession, type StartSimulationRequest } from '@rescuemesh/shared';
import { CHIEF_ROLES } from './deliberation-contract';
import {
  FIXTURE_MODEL,
  fixtureBrief,
  fixturePosition,
  fixtureResponse
} from './deliberation-fixture';

/** Recorded playback only. Scenario changes and plans still use the shared engine. */
export function mockDeliberation(engine: SimulationEngine) {
  const sessions = new Map<string, DeliberationSession>();
  const requests = new Map<string, string>();
  const stages = [
    'triggered',
    'initial_analysis',
    'cross_review',
    'synthesis',
    'validating',
    'degraded'
  ] as const;
  const now = () => new Date().toISOString();
  function get(id: string) {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown session. It may have been cleared by reset.');
    const plan = engine.scenario.plans.find((p) => p.id === session.planId);
    if (session.scenarioRevision !== engine.revision && plan?.basedOnRevision !== engine.revision)
      session.status = 'stale';
    return session;
  }
  return {
    clear() {
      sessions.clear();
      requests.clear();
    },
    startSimulation: async (request: StartSimulationRequest) => {
      const prior = request.requestId && requests.get(request.requestId);
      if (prior) return structuredClone(get(prior));
      if (request.step) {
        if (request.step !== 'initial_flooding')
          throw new Error(
            'Local recorded demo supports only initial_flooding. No state was changed.'
          );
        const revision = engine.revision;
        const batchId = `recorded-pittsburgh-sequence-v1-initial_flooding-r${revision}`;
        // Exact initial_flooding developments from Claude's committed recorded script.
        const result = engine.execute({
          type: 'scenario.advance',
          commandId: `${batchId}-sim`,
          issuedAt: now(),
          payload: {
            batchId,
            basedOnRevision: revision,
            step: 'initial_flooding',
            rationale:
              'Rainfall continues over the Monongahela basin, so low-lying ground away from the first three incidents begins to take water and an existing trail washout worsens.',
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
          }
        });
        if (!result.ok) throw new Error(result.error.message);
      }
      const session: DeliberationSession = {
        sessionId: `recorded-${crypto.randomUUID()}`,
        scenarioRevision: engine.revision,
        ...(request.step ? { scenarioStep: request.step } : {}),
        disaster: request.step ? `Scripted step: ${request.step}` : 'Current scenario snapshot',
        status: 'triggered',
        createdAt: now(),
        updatedAt: now(),
        initialPositions: [],
        crossReview: [],
        source: {
          provider: 'scripted',
          model: FIXTURE_MODEL,
          degraded: true,
          warning:
            'Scripted fallback: recorded exercise statements, not live analysis of this scenario. Gemini is not used in local mode.'
        },
        errors: [],
        usage: { calls: 0, latencyMs: 0, hasUnreportedUsage: false }
      };
      sessions.set(session.sessionId, session);
      if (request.requestId) requests.set(request.requestId, session.sessionId);
      return structuredClone(session);
    },
    simulation: async (id: string) => {
      const s = get(id);
      if (s.status !== 'stale') {
        const index = stages.indexOf(s.status as (typeof stages)[number]);
        s.status = stages[Math.min(index + 1, stages.length - 1)]!;
        if (index >= 1)
          s.initialPositions = CHIEF_ROLES.map((role) => ({
            ...fixturePosition(role),
            substituted: true
          }));
        if (index >= 2)
          s.crossReview = CHIEF_ROLES.map((role) => ({
            ...fixtureResponse(role),
            substituted: true
          }));
        if (index >= 3) s.finalBrief = fixtureBrief();
        s.updatedAt = now();
        if (s.status === 'degraded') s.completedAt = now();
      }
      return structuredClone(s);
    },
    finalPlan: async (id: string) => {
      const s = get(id);
      if (s.status !== 'degraded' || !s.finalBrief)
        throw new Error('Session is stale or not ready. No candidate plan created.');
      if (!s.planId) {
        const result = engine.execute({
          type: 'plan.propose',
          commandId: `${id}-plan`,
          issuedAt: now(),
          payload: {}
        });
        if (!result.ok || result.type !== 'plan.propose')
          throw new Error('Engine could not produce a candidate plan.');
        s.planId = result.data.plan.id;
      }
      return structuredClone(s);
    }
  };
}
