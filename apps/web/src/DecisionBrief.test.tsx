import {
  pittsburghFloodScenario,
  summarizeProvenance,
  type DeliberationSession
} from '@rescuemesh/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionBrief } from './DecisionBrief';

const brief = {
  situationSummary: 'inc-parkway is critical with 6 at risk; inc-southside needs ALS.',
  pointsOfAgreement: ['Prioritise inc-parkway', 'Route casualties to h-agh'],
  unresolvedDisputes: ['Whether log-1 stages forward'],
  orderedPriorities: ['Swift-water rescue', 'Traffic control'],
  proposedActions: ['Dispatch boat-5 and pol-42'],
  rationale: 'Life safety first.',
  confidence: 0.9
};

const session = (over: Partial<DeliberationSession> = {}): DeliberationSession => ({
  sessionId: 'sim-1',
  scenarioRevision: 0,
  disaster: 'Flash flood',
  status: 'ready',
  createdAt: 't',
  updatedAt: 't',
  initialPositions: [],
  crossReview: [],
  finalBrief: brief,
  source: { provider: 'gemini', model: 'gemini-3.6-flash', degraded: false },
  errors: [],
  usage: { calls: 11, latencyMs: 1, hasUnreportedUsage: true },
  ...over
});

/** A scenario with one proposed plan, so the brief has actions to render. */
const withPlan = () => {
  const s = structuredClone(pittsburghFloodScenario);
  s.plans = [
    {
      id: 'plan-1',
      status: 'proposed',
      createdAt: 't',
      basedOnRevision: 0,
      generatedBy: 'mock',
      assignments: [
        {
          id: 'as-1',
          incidentId: 'inc-southside',
          resourceIds: ['amb-21'],
          destinationFacilityId: 'h-agh',
          priority: 1,
          status: 'proposed',
          rationale: 'Nearest ALS unit to inc-southside.'
        }
      ],
      rationale: 'Greedy match over active incidents.',
      shortfalls: [
        {
          incidentId: 'inc-parkway',
          missingCapabilities: ['swift-water-rescue', 'traffic-control'],
          reason: 'no available unit'
        }
      ],
      forecast: {
        synthetic: true,
        peopleReachableWithin30Min: 14,
        unmetCapabilityCount: 2,
        modeledTotalTravelMinutes: 18
      }
    }
  ];
  return s;
};

const render = (over: Partial<DeliberationSession> = {}, scenario = withPlan()) => {
  const s = session(over);
  return renderToStaticMarkup(
    createElement(DecisionBrief, {
      session: s,
      scenario,
      provenance: summarizeProvenance(s),
      planId: 'plan-1',
      busy: false,
      stale: false,
      onApprove: () => {},
      onAlternate: () => {}
    })
  );
};

describe('decision brief', () => {
  it('answers the five judge questions', () => {
    const html = render();
    expect(html).toContain('Recommended response plan');
    expect(html).toContain('Situation');
    expect(html).toContain('Immediate actions');
    expect(html).toContain('Why this plan');
    expect(html).toContain('Remaining gaps');
    expect(html).toContain('Approve and dispatch this plan');
  });

  it('contains no internal identifiers anywhere', () => {
    const html = render();
    for (const id of [
      'inc-parkway',
      'inc-southside',
      'inc-exr-1',
      'amb-21',
      'pol-42',
      'eng-07',
      'log-1',
      'h-agh',
      'h-mercy',
      'p-zone1',
      'r-river'
    ]) {
      expect(html, `leaked ${id}`).not.toContain(id);
    }
  });

  it('humanizes resources, incidents and facilities in the actions', () => {
    const html = render();
    expect(html).toContain('Ambulance 21');
    expect(html).toContain('South Side basement evacuations');
    expect(html).toContain('Allegheny General Hospital');
  });

  it('states each action with resource, destination and purpose', () => {
    const html = render();
    expect(html).toMatch(/Send.*Ambulance 21.*to.*South Side basement evacuations/);
    expect(html).toContain('modeled arrival');
    expect(html).toContain('transporting to Allegheny General Hospital');
  });

  it('states remaining gaps in plain English with humanized capabilities', () => {
    const html = render();
    expect(html).toContain('One incident still needs additional support.');
    expect(html).not.toContain('3 incident(s) have unmet needs');
    expect(html).toContain('swift-water rescue');
    expect(html).toContain('traffic control');
    expect(html).not.toContain('swift-water-rescue');
    expect(html).not.toContain('traffic-control');
  });

  it('never calls the plan optimal, and says Gemini cannot dispatch', () => {
    const html = render();
    expect(html.toLowerCase()).not.toContain('optimal');
    expect(html).toContain('Engine-validated');
    expect(html).toContain('Gemini cannot dispatch them.');
  });

  it('surfaces the human decision point', () => {
    const html = render();
    expect(html).toContain('Key disagreement requiring human judgement');
    expect(html).toContain('Simulate alternate plan');
  });

  it('shows fully-live provenance honestly', () => {
    const html = render();
    expect(html).toContain('contributions generated by Gemini');
  });

  it('reports no gaps when everything is covered', () => {
    const scenario = withPlan();
    scenario.plans[0]!.shortfalls = [];
    const html = render({}, scenario);
    expect(html).toContain('Every active incident has at least one unit assigned.');
  });

  it('disables approval while the exercise has moved on', () => {
    const s = session();
    const html = renderToStaticMarkup(
      createElement(DecisionBrief, {
        session: s,
        scenario: withPlan(),
        provenance: summarizeProvenance(s),
        planId: 'plan-1',
        busy: false,
        stale: true,
        onApprove: () => {},
        onAlternate: () => {}
      })
    );
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('Re-run the deliberation before');
  });
});
