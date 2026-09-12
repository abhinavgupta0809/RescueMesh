import {
  checkInvariants,
  pittsburghFloodScenario,
  type Command,
  type CommandFailure,
  type CommandResponse,
  type CommandSuccess,
  type CommandType
} from '@rescuemesh/shared';
import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine.js';

let counter = 0;
const cmd = <T extends Command>(command: Omit<T, 'commandId' | 'issuedAt'>): Command =>
  ({
    ...command,
    commandId: `cmd-${(counter += 1)}`,
    issuedAt: '2026-07-18T18:40:00-04:00'
  }) as Command;

const ok = <T extends CommandType>(response: CommandResponse): CommandSuccess<T> => {
  if (!response.ok)
    throw new Error(`expected success, got ${response.error.code}: ${response.error.message}`);
  return response as CommandSuccess<T>;
};
const err = (response: CommandResponse): CommandFailure => {
  if (response.ok) throw new Error('expected failure, got success');
  return response;
};

const engine = () => new SimulationEngine();

const OFFLINE_ZONE = 'zone-south-side';

describe('determinism', () => {
  it('produces byte-identical state for the same command sequence', () => {
    const script = (): Command[] => {
      counter = 0;
      return [
        cmd({
          type: 'scenario.trigger_flood',
          payload: { intensity: 'severe', zoneIds: ['zone-east'] }
        }),
        cmd({
          type: 'route.close_bridge',
          payload: { bridgeId: 'bridge-hot-metal', closed: true }
        }),
        cmd({
          type: 'zone.set_connectivity',
          payload: { zoneId: OFFLINE_ZONE, connectivity: 'offline' }
        })
      ];
    };
    const a = new SimulationEngine();
    a.executeAll(script());
    const b = new SimulationEngine();
    b.executeAll(script());
    expect(a.scenario).toEqual(b.scenario);
  });

  it('keeps every invariant clean after each command', () => {
    const sim = engine();
    sim.execute(cmd({ type: 'scenario.trigger_flood', payload: { intensity: 'catastrophic' } }));
    expect(checkInvariants(sim.scenario)).toEqual([]);
    sim.execute(
      cmd({ type: 'route.close_bridge', payload: { bridgeId: 'bridge-birmingham', closed: true } })
    );
    expect(checkInvariants(sim.scenario)).toEqual([]);
  });
});

describe('1. trigger a flood', () => {
  it('raises a reproducible number of incidents and marks them modeled', () => {
    const sim = engine();
    const before = sim.scenario.incidents.length;
    const result = ok(
      sim.execute(
        cmd({
          type: 'scenario.trigger_flood',
          payload: { intensity: 'severe', zoneIds: ['zone-east'] }
        })
      )
    );
    const data = result.data as { raisedIncidents: { id: string; description: string }[] };
    expect(data.raisedIncidents).toHaveLength(2);
    expect(sim.scenario.incidents).toHaveLength(before + 2);
    for (const incident of data.raisedIncidents) {
      expect(incident.description).toContain('modeled');
    }
    expect(sim.scenario.zones.find((zone) => zone.id === 'zone-east')?.incidentIds).toHaveLength(3);
  });

  it('rejects an unknown zone without changing state', () => {
    const sim = engine();
    const before = sim.scenario;
    const failure = err(
      sim.execute(
        cmd({
          type: 'scenario.trigger_flood',
          payload: { intensity: 'severe', zoneIds: ['zone-nowhere'] }
        })
      )
    );
    expect(failure.error.code).toBe('not_found');
    expect(sim.scenario).toEqual(before);
  });
});

describe('2. close a bridge or route', () => {
  it('is allowed even when it strands an already-dispatched unit', () => {
    const sim = engine();
    // as-001 has boat-2 (home r-river) dispatched to inc-parkway over this route
    ok(
      sim.execute(
        cmd({
          type: 'route.close_bridge',
          payload: { bridgeId: 'bridge-fort-duquesne', closed: true }
        })
      )
    );
    expect(sim.scenario.routes.find((route) => route.id === 'route-river-parkway')?.status).toBe(
      'closed'
    );
    expect(checkInvariants(sim.scenario)).toEqual([]);
  });

  it('closes and reopens deterministically', () => {
    const sim = engine();
    const closed = ok(
      sim.execute(
        cmd({
          type: 'route.close_bridge',
          payload: { bridgeId: 'bridge-fort-duquesne', closed: true }
        })
      )
    );
    expect((closed.data as { closedRouteIds: string[] }).closedRouteIds).toEqual([
      'route-river-parkway'
    ]);
    expect(sim.scenario.routes.find((route) => route.id === 'route-river-parkway')?.status).toBe(
      'closed'
    );

    ok(
      sim.execute(
        cmd({
          type: 'route.close_bridge',
          payload: { bridgeId: 'bridge-fort-duquesne', closed: false }
        })
      )
    );
    // restored to its original 'slow', not blindly set to 'open'
    expect(sim.scenario.routes.find((route) => route.id === 'route-river-parkway')?.status).toBe(
      'slow'
    );
  });

  it('rejects closing an already-closed bridge', () => {
    const sim = engine();
    ok(
      sim.execute(
        cmd({ type: 'route.close_bridge', payload: { bridgeId: 'bridge-hot-metal', closed: true } })
      )
    );
    const failure = err(
      sim.execute(
        cmd({ type: 'route.close_bridge', payload: { bridgeId: 'bridge-hot-metal', closed: true } })
      )
    );
    expect(failure.error.code).toBe('bridge_already_in_state');
  });
});

describe('3 & 4. disconnect a zone and queue its reports', () => {
  it('queues an offline report without touching central incident state', () => {
    const sim = engine();
    ok(
      sim.execute(
        cmd({
          type: 'zone.set_connectivity',
          payload: { zoneId: OFFLINE_ZONE, connectivity: 'offline' }
        })
      )
    );
    const incidentsBefore = sim.scenario.incidents.length;

    const result = ok(
      sim.execute(
        cmd({
          type: 'report.submit',
          payload: {
            clientReportId: 'rep-1',
            zoneId: OFFLINE_ZONE,
            body: 'Water waist deep on Sarah Street, two people stuck on a porch roof.',
            capturedAt: '2026-07-18T18:44:00-04:00'
          }
        })
      )
    );

    const data = result.data as { queuedOffline: boolean; report: { syncState: string } };
    expect(data.queuedOffline).toBe(true);
    expect(data.report.syncState).toBe('queued');
    expect(sim.scenario.incidents).toHaveLength(incidentsBefore);
    expect(sim.scenario.reports).toHaveLength(1);
  });

  it('applies a report immediately when the zone is online', () => {
    const sim = engine();
    const before = sim.scenario.incidents.length;
    const result = ok(
      sim.execute(
        cmd({
          type: 'report.submit',
          payload: {
            clientReportId: 'rep-online',
            zoneId: 'zone-east',
            body: 'Trail flooded, one cyclist stranded.',
            capturedAt: '2026-07-18T18:45:00-04:00'
          }
        })
      )
    );
    expect((result.data as { queuedOffline: boolean }).queuedOffline).toBe(false);
    expect(sim.scenario.incidents).toHaveLength(before + 1);
  });
});

describe('5. reconnect and sync exactly once', () => {
  const queueTwo = (sim: SimulationEngine) => {
    ok(
      sim.execute(
        cmd({
          type: 'zone.set_connectivity',
          payload: { zoneId: OFFLINE_ZONE, connectivity: 'offline' }
        })
      )
    );
    for (const [index, body] of [
      'Two people trapped in a stalled van.',
      'Basement flooding on the 1800 block.'
    ].entries()) {
      ok(
        sim.execute(
          cmd({
            type: 'report.submit',
            payload: {
              clientReportId: `rep-q${index}`,
              zoneId: OFFLINE_ZONE,
              body,
              capturedAt: '2026-07-18T18:44:00-04:00'
            }
          })
        )
      );
    }
  };

  const syncPayload = () => ({
    reports: [
      {
        clientReportId: 'rep-q0',
        zoneId: OFFLINE_ZONE,
        body: 'Two people trapped in a stalled van.',
        capturedAt: '2026-07-18T18:44:00-04:00'
      },
      {
        clientReportId: 'rep-q1',
        zoneId: OFFLINE_ZONE,
        body: 'Basement flooding on the 1800 block.',
        capturedAt: '2026-07-18T18:44:00-04:00'
      }
    ]
  });

  it('applies queued reports once on reconnect and grades severity deterministically', () => {
    const sim = engine();
    queueTwo(sim);
    const reconnect = ok(
      sim.execute(
        cmd({
          type: 'zone.set_connectivity',
          payload: { zoneId: OFFLINE_ZONE, connectivity: 'online' }
        })
      )
    );
    expect((reconnect.data as { syncableReportIds: string[] }).syncableReportIds).toEqual([
      'rep-q0',
      'rep-q1'
    ]);

    const before = sim.scenario.incidents.length;
    const synced = ok(sim.execute(cmd({ type: 'report.sync', payload: syncPayload() })));
    const data = synced.data as { applied: unknown[]; duplicates: unknown[] };
    expect(data.applied).toHaveLength(2);
    expect(data.duplicates).toHaveLength(0);
    expect(sim.scenario.incidents).toHaveLength(before + 2);

    const trapped = sim.scenario.incidents.find((incident) =>
      incident.description.includes('stalled van')
    );
    expect(trapped?.severity).toBe('critical');
  });

  it('a sync retry with a fresh commandId adds no incidents and no events', () => {
    const sim = engine();
    queueTwo(sim);
    ok(
      sim.execute(
        cmd({
          type: 'zone.set_connectivity',
          payload: { zoneId: OFFLINE_ZONE, connectivity: 'online' }
        })
      )
    );
    ok(sim.execute(cmd({ type: 'report.sync', payload: syncPayload() })));

    const incidentsAfterFirst = sim.scenario.incidents.length;
    const eventsAfterFirst = sim.scenario.events.length;

    const retry = ok(sim.execute(cmd({ type: 'report.sync', payload: syncPayload() })));
    const data = retry.data as { applied: unknown[]; duplicates: unknown[] };
    expect(data.applied).toHaveLength(0);
    expect(data.duplicates).toHaveLength(2);
    expect(sim.scenario.incidents).toHaveLength(incidentsAfterFirst);
    expect(sim.scenario.events).toHaveLength(eventsAfterFirst);
  });

  it('a replayed commandId is a no-op that returns the original result', () => {
    const sim = engine();
    const command = cmd({
      type: 'scenario.trigger_flood',
      payload: { intensity: 'moderate', zoneIds: ['zone-east'] }
    });
    const first = ok(sim.execute(command));
    const incidents = sim.scenario.incidents.length;
    const revision = sim.revision;

    const replay = ok(sim.execute(command));
    expect(replay.duplicate).toBe(true);
    expect(replay.events).toEqual([]);
    expect(replay.revision).toBe(revision);
    expect(sim.scenario.incidents).toHaveLength(incidents);
    expect(replay.data).toEqual(first.data);
  });

  it('rejects a report whose zone is still offline', () => {
    const sim = engine();
    queueTwo(sim);
    const synced = ok(sim.execute(cmd({ type: 'report.sync', payload: syncPayload() })));
    const data = synced.data as { applied: unknown[]; rejected: { rejectionReason?: string }[] };
    expect(data.applied).toHaveLength(0);
    expect(data.rejected).toHaveLength(2);
    expect(data.rejected[0]?.rejectionReason).toContain('offline');
  });
});

describe('6. propose a plan', () => {
  it('gives every assignment an explicit rationale and reports unmet needs', () => {
    const sim = engine();
    const plan = ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const data = plan.data as {
      plan: {
        assignments: { rationale: string; status: string }[];
        rationale: string;
        shortfalls: unknown[];
        forecast: { synthetic: boolean };
        generatedBy: string;
      };
    };
    expect(data.plan.assignments.length).toBeGreaterThan(0);
    for (const assignment of data.plan.assignments) {
      expect(assignment.rationale.length).toBeGreaterThan(20);
      expect(assignment.status).toBe('proposed');
    }
    expect(data.plan.forecast.synthetic).toBe(true);
    expect(data.plan.generatedBy).toBe('mock');
  });

  it('never proposes a unit whose only modeled route is closed', () => {
    const sim = engine();
    // Close the one route p-zone1 -> inc-trail is already closed in the seed;
    // close the east approach too and confirm no proposal crosses it.
    ok(
      sim.execute(
        cmd({ type: 'route.close_bridge', payload: { bridgeId: 'bridge-hot-metal', closed: true } })
      )
    );
    const plan = ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const data = plan.data as {
      plan: { assignments: { incidentId: string; resourceIds: string[] }[] };
    };

    for (const assignment of data.plan.assignments) {
      for (const resourceId of assignment.resourceIds) {
        const resource = sim.scenario.resources.find((candidate) => candidate.id === resourceId);
        const route = sim.scenario.routes.find(
          (candidate) =>
            candidate.fromId === resource?.homeFacilityId &&
            candidate.toId === assignment.incidentId
        );
        expect(route?.status).not.toBe('closed');
      }
    }
    // boat-5 lives at r-east and its only modeled route to inc-parkway is now closed
    const parkway = data.plan.assignments.find(
      (assignment) => assignment.incidentId === 'inc-parkway'
    );
    expect(parkway?.resourceIds ?? []).not.toContain('boat-5');
  });

  it('supersedes the previous proposal rather than leaving two open', () => {
    const sim = engine();
    ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const proposed = sim.scenario.plans.filter((plan) => plan.status === 'proposed');
    expect(proposed).toHaveLength(1);
    expect(sim.scenario.plans.filter((plan) => plan.status === 'superseded')).toHaveLength(1);
    expect(checkInvariants(sim.scenario)).toEqual([]);
  });

  it('honours the reserve guardrail, refusing to strip the reserve', () => {
    const sim = engine();
    const failure = err(
      sim.execute(cmd({ type: 'plan.propose', payload: { reserveUnitsPerKind: 99 } }))
    );
    expect(failure.error.code).toBe('infeasible');
    expect(failure.error.details?.shortfalls).toBeDefined();
    // the world is untouched by a refused proposal
    expect(sim.scenario.plans).toHaveLength(0);
  });

  it('reports unmet needs as shortfalls when only some capabilities can be covered', () => {
    const sim = engine();
    const plan = ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const data = plan.data as {
      plan: { shortfalls: { incidentId: string; missingCapabilities: string[]; reason: string }[] };
    };
    // only one available unit carries `evacuation`, so the second incident that
    // needs it must be reported as an unmet need rather than silently dropped
    expect(data.plan.shortfalls.length).toBeGreaterThan(0);
    expect(data.plan.shortfalls[0]?.missingCapabilities).toContain('evacuation');
    expect(data.plan.shortfalls[0]?.reason.length).toBeGreaterThan(10);
  });
});

describe('7. approve a plan', () => {
  it('moves units to assigned and records the assignment', () => {
    const sim = engine();
    const proposal = ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const planId = (proposal.data as { plan: { id: string } }).plan.id;

    const approved = ok(sim.execute(cmd({ type: 'plan.approve', payload: { planId } })));
    const data = approved.data as { assignedResourceIds: string[] };
    expect(data.assignedResourceIds.length).toBeGreaterThan(0);
    for (const resourceId of data.assignedResourceIds) {
      expect(sim.scenario.resources.find((r) => r.id === resourceId)?.status).toBe('assigned');
    }
    expect(checkInvariants(sim.scenario)).toEqual([]);
  });

  it('rejects a stale proposal once world state has moved on', () => {
    const sim = engine();
    const proposal = ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const planId = (proposal.data as { plan: { id: string } }).plan.id;
    // any other command advances the revision and staleness must be caught
    ok(
      sim.execute(
        cmd({
          type: 'zone.set_connectivity',
          payload: { zoneId: 'zone-east', connectivity: 'degraded' }
        })
      )
    );

    const failure = err(sim.execute(cmd({ type: 'plan.approve', payload: { planId } })));
    expect(failure.error.code).toBe('plan_stale');
    expect(failure.error.retryable).toBe(true);
  });

  it('never double-books a unit across two approvals', () => {
    const sim = engine();
    const first = ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const firstId = (first.data as { plan: { id: string } }).plan.id;
    ok(sim.execute(cmd({ type: 'plan.approve', payload: { planId: firstId } })));

    // A fresh proposal can only use what is still available.
    const second = sim.execute(cmd({ type: 'plan.propose', payload: {} }));
    if (second.ok) {
      const planId = (second.data as { plan: { id: string } }).plan.id;
      const approval = sim.execute(cmd({ type: 'plan.approve', payload: { planId } }));
      if (approval.ok) {
        expect(checkInvariants(sim.scenario)).toEqual([]);
      } else {
        expect(['resource_unavailable', 'resource_double_booked', 'plan_stale']).toContain(
          approval.error.code
        );
      }
    }
    // whatever happened, no unit is held twice
    const holders = sim.scenario.assignments
      .filter((a) => a.status === 'approved' || a.status === 'dispatched')
      .flatMap((a) => a.resourceIds);
    expect(new Set(holders).size).toBe(holders.length);
  });

  it('rejects approving a plan twice', () => {
    const sim = engine();
    const proposal = ok(sim.execute(cmd({ type: 'plan.propose', payload: {} })));
    const planId = (proposal.data as { plan: { id: string } }).plan.id;
    ok(sim.execute(cmd({ type: 'plan.approve', payload: { planId } })));
    const failure = err(sim.execute(cmd({ type: 'plan.approve', payload: { planId } })));
    expect(failure.error.code).toBe('plan_not_proposed');
  });

  it('rejects an unknown plan', () => {
    const sim = engine();
    expect(
      err(sim.execute(cmd({ type: 'plan.approve', payload: { planId: 'plan-nope' } }))).error.code
    ).toBe('not_found');
  });
});

describe('8. reset', () => {
  it('restores the seed and clears queues, events, and dedup state', () => {
    const sim = engine();
    ok(
      sim.execute(cmd({ type: 'scenario.trigger_flood', payload: { intensity: 'catastrophic' } }))
    );
    ok(
      sim.execute(
        cmd({
          type: 'zone.set_connectivity',
          payload: { zoneId: OFFLINE_ZONE, connectivity: 'offline' }
        })
      )
    );
    ok(
      sim.execute(
        cmd({
          type: 'report.submit',
          payload: {
            clientReportId: 'rep-reset',
            zoneId: OFFLINE_ZONE,
            body: 'Queued before reset.',
            capturedAt: '2026-07-18T18:44:00-04:00'
          }
        })
      )
    );
    expect(sim.scenario.reports.length).toBeGreaterThan(0);

    ok(sim.execute(cmd({ type: 'scenario.reset', payload: {} })));

    expect(sim.scenario).toEqual(pittsburghFloodScenario);
    expect(sim.revision).toBe(0);
    expect(sim.state.appliedReports).toEqual({});
    expect(sim.state.appliedCommands).toEqual({});
    expect(sim.state.counters).toEqual({});
    expect(sim.state.bridgeRouteMemory).toEqual({});
  });

  it('lets the same commandId be reused after a reset', () => {
    const sim = engine();
    const command = cmd({
      type: 'scenario.trigger_flood',
      payload: { intensity: 'moderate', zoneIds: ['zone-east'] }
    });
    ok(sim.execute(command));
    ok(sim.execute(cmd({ type: 'scenario.reset', payload: {} })));
    const again = ok(sim.execute(command));
    expect(again.duplicate).toBe(false);
  });
});

describe('the full eight-step demo', () => {
  it('runs end to end twice with identical results', () => {
    const run = () => {
      counter = 0;
      const sim = engine();
      const responses: CommandResponse[] = [];
      responses.push(
        sim.execute(
          cmd({
            type: 'scenario.trigger_flood',
            payload: { intensity: 'severe', zoneIds: ['zone-oakland'] }
          })
        )
      );
      responses.push(
        sim.execute(
          cmd({
            type: 'route.close_bridge',
            payload: { bridgeId: 'bridge-birmingham', closed: true }
          })
        )
      );
      responses.push(
        sim.execute(
          cmd({
            type: 'zone.set_connectivity',
            payload: { zoneId: OFFLINE_ZONE, connectivity: 'offline' }
          })
        )
      );
      responses.push(
        sim.execute(
          cmd({
            type: 'report.submit',
            payload: {
              clientReportId: 'demo-rep-1',
              zoneId: OFFLINE_ZONE,
              body: 'Elderly man trapped in a stalled van, water rising.',
              capturedAt: '2026-07-18T18:46:00-04:00'
            }
          })
        )
      );
      responses.push(
        sim.execute(
          cmd({
            type: 'zone.set_connectivity',
            payload: { zoneId: OFFLINE_ZONE, connectivity: 'online' }
          })
        )
      );
      responses.push(
        sim.execute(
          cmd({
            type: 'report.sync',
            payload: {
              reports: [
                {
                  clientReportId: 'demo-rep-1',
                  zoneId: OFFLINE_ZONE,
                  body: 'Elderly man trapped in a stalled van, water rising.',
                  capturedAt: '2026-07-18T18:46:00-04:00'
                }
              ]
            }
          })
        )
      );
      const proposal = sim.execute(cmd({ type: 'plan.propose', payload: {} }));
      responses.push(proposal);
      const planId = (ok(proposal).data as { plan: { id: string } }).plan.id;
      responses.push(sim.execute(cmd({ type: 'plan.approve', payload: { planId } })));
      return { sim, responses };
    };

    const first = run();
    const second = run();

    expect(first.responses.every((response) => response.ok)).toBe(true);
    expect(first.sim.scenario).toEqual(second.sim.scenario);
    expect(checkInvariants(first.sim.scenario)).toEqual([]);
    expect(first.sim.revision).toBe(8);

    // and reset returns it to the seed
    first.sim.execute(cmd({ type: 'scenario.reset', payload: {} }));
    expect(first.sim.scenario).toEqual(pittsburghFloodScenario);
  });
});
