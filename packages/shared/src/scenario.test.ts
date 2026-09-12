import { describe, expect, it } from 'vitest';
import { pittsburghFloodScenario as scenario } from './scenario.js';

describe('Pittsburgh flood seed', () => {
  it('contains the promised facility mix', () => {
    const count = (kind: string) => scenario.facilities.filter((f) => f.kind === kind).length;
    expect(count('hospital')).toBe(3);
    expect(count('fire_house')).toBeGreaterThanOrEqual(3);
    expect(count('police_hub')).toBe(2);
    expect(count('rescue_center')).toBe(2);
  });

  it('keeps references internally consistent', () => {
    const resourceIds = new Set(scenario.resources.map((resource) => resource.id));
    const incidentIds = new Set(scenario.incidents.map((incident) => incident.id));
    for (const assignment of scenario.assignments) {
      expect(incidentIds.has(assignment.incidentId)).toBe(true);
      expect(assignment.resourceIds.every((id) => resourceIds.has(id))).toBe(true);
    }
  });
});
