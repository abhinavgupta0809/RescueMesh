import { describe, expect, it } from 'vitest';
import { assertInvariants, checkInvariants } from './invariants.js';
import { pittsburghFloodScenario } from './scenario.js';
import type { Scenario } from './types.js';

const clone = (): Scenario => structuredClone(pittsburghFloodScenario);
const codes = (scenario: Scenario) => checkInvariants(scenario).map((item) => item.invariant);

describe('seed scenario', () => {
  it('satisfies every contract invariant', () => {
    expect(checkInvariants(pittsburghFloodScenario)).toEqual([]);
    expect(() => assertInvariants(pittsburghFloodScenario, 'seed')).not.toThrow();
  });

  it('places every facility in exactly one zone', () => {
    const zoned = pittsburghFloodScenario.zones.flatMap((zone) => zone.facilityIds);
    expect(new Set(zoned).size).toBe(pittsburghFloodScenario.facilities.length);
  });
});

describe('invariant detection', () => {
  it('I1 catches a missing hospital', () => {
    const scenario = clone();
    scenario.facilities = scenario.facilities.filter((facility) => facility.id !== 'h-agh');
    scenario.zones = scenario.zones.map((zone) => ({
      ...zone,
      facilityIds: zone.facilityIds.filter((id) => id !== 'h-agh')
    }));
    scenario.assignments = scenario.assignments.map((assignment) =>
      assignment.destinationFacilityId === 'h-agh'
        ? { ...assignment, destinationFacilityId: 'h-mercy' }
        : assignment
    );
    expect(codes(scenario)).toContain('I1');
  });

  it('I2 catches a double-booked unit', () => {
    const scenario = clone();
    const [first, second] = scenario.assignments;
    if (!first || !second) throw new Error('seed needs two assignments');
    second.resourceIds = [...second.resourceIds, 'boat-2'];
    expect(codes(scenario)).toContain('I2');
  });

  it('I3 catches a held unit still marked available', () => {
    const scenario = clone();
    const resource = scenario.resources.find((candidate) => candidate.id === 'eng-07');
    if (!resource) throw new Error('seed needs eng-07');
    resource.status = 'available';
    expect(codes(scenario)).toContain('I3');
  });

  it('I4 catches an assignment pointing at an unknown resource', () => {
    const scenario = clone();
    scenario.assignments[0]?.resourceIds.push('ghost-unit');
    expect(codes(scenario)).toContain('I4');
  });

  it('I5 catches an active assignment over a closed route', () => {
    const scenario = clone();
    const route = scenario.routes.find((candidate) => candidate.id === 'route-river-parkway');
    if (!route) throw new Error('seed needs route-river-parkway');
    route.status = 'closed';
    expect(codes(scenario)).toContain('I5');
  });

  it('I6 catches a closed bridge whose route is still open', () => {
    const scenario = clone();
    const bridge = scenario.bridges.find((candidate) => candidate.id === 'bridge-birmingham');
    if (!bridge) throw new Error('seed needs bridge-birmingham');
    bridge.status = 'closed';
    expect(codes(scenario)).toContain('I6');
  });

  it('I7 catches a facility placed in two zones', () => {
    const scenario = clone();
    scenario.zones[1]?.facilityIds.push('h-mercy');
    expect(codes(scenario)).toContain('I7');
  });

  it('I8 catches a duplicate client report id', () => {
    const scenario = clone();
    const report = {
      clientReportId: 'rep-local-1',
      zoneId: 'zone-south-side',
      body: 'Water rising on Sarah Street.',
      capturedAt: '2026-07-18T18:41:00-04:00',
      syncState: 'queued' as const
    };
    scenario.reports = [report, { ...report }];
    expect(codes(scenario)).toContain('I8');
  });

  it('I8 catches an applied report with no timestamp', () => {
    const scenario = clone();
    scenario.reports = [
      {
        clientReportId: 'rep-local-2',
        zoneId: 'zone-south-side',
        body: 'Basement flooding.',
        capturedAt: '2026-07-18T18:41:00-04:00',
        syncState: 'applied'
      }
    ];
    expect(codes(scenario)).toContain('I8');
  });

  it('I9 catches two plans awaiting approval', () => {
    const scenario = clone();
    const plan = {
      id: 'plan-a',
      status: 'proposed' as const,
      createdAt: '2026-07-18T18:41:00-04:00',
      basedOnRevision: 0,
      generatedBy: 'mock' as const,
      assignments: [],
      rationale: 'test',
      shortfalls: [],
      forecast: {
        synthetic: true as const,
        peopleReachableWithin30Min: 10,
        unmetCapabilityCount: 0,
        modeledTotalTravelMinutes: 20
      }
    };
    scenario.plans = [plan, { ...plan, id: 'plan-b' }];
    expect(codes(scenario)).toContain('I9');
  });

  it('I11 catches a route that dropped its synthetic label', () => {
    const scenario = clone();
    const route = scenario.routes[0];
    if (!route) throw new Error('seed needs a route');
    route.synthetic = false;
    expect(codes(scenario)).toContain('I11');
  });

  it('I12 catches an event revision ahead of the scenario revision', () => {
    const scenario = clone();
    const event = scenario.events[0];
    if (!event) throw new Error('seed needs an event');
    event.revision = 99;
    expect(codes(scenario)).toContain('I12');
  });
});
