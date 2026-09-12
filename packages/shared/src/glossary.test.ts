import { describe, expect, it } from 'vitest';
import { buildGlossary, humanizeCapability } from './glossary.js';
import { pittsburghFloodScenario } from './scenario.js';

const g = buildGlossary(pittsburghFloodScenario);

describe('entity glossary', () => {
  it('names incidents, resources, facilities, zones and routes', () => {
    expect(g.label('inc-southside')).toContain('South Side basement evacuations');
    expect(g.label('amb-21')).toBe('Ambulance 21');
    expect(g.label('pol-42')).toBe('Police Unit 42');
    expect(g.label('eng-07')).toBe('Fire Engine 07');
    expect(g.label('boat-5')).toBe('Rescue Boat 5');
    expect(g.label('log-1')).toBe('Supply Truck 1');
    expect(g.label('h-agh')).toBe('Allegheny General Hospital');
    expect(g.label('zone-downtown')).toBe('Downtown / Uptown / Strip');
    expect(g.label('route-west-trail')).toMatch(/^the route from .+ to .+$/);
  });

  it('rewrites identifiers inside prose', () => {
    const out = g.humanize('Dispatch amb-21 and pol-42 to inc-southside, transport to h-agh.');
    expect(out).toBe(
      'Dispatch Ambulance 21 and Police Unit 42 to South Side basement evacuations (S 18th St & Sarah St), transport to Allegheny General Hospital.'
    );
    expect(out).not.toMatch(/amb-21|pol-42|inc-southside|h-agh/);
  });

  it('does not corrupt a longer id that contains a shorter one', () => {
    // `inc-south` is a prefix of `inc-southside`; longest-first must win
    const out = g.humanize('inc-southside needs help');
    expect(out).toContain('South Side basement evacuations');
    expect(out).not.toContain('sideside');
    expect(out).not.toMatch(/inc-south\b/);
  });

  it('leaves unknown identifiers alone', () => {
    expect(g.humanize('inc-does-not-exist is unknown')).toBe('inc-does-not-exist is unknown');
  });

  it('handles ids at the very start and end of a sentence', () => {
    expect(g.humanize('amb-21')).toBe('Ambulance 21');
    expect(g.humanize('Send amb-21')).toBe('Send Ambulance 21');
  });

  it('humanizes capability names', () => {
    expect(humanizeCapability('advanced-life-support')).toBe('advanced life support');
    expect(humanizeCapability('swift-water-rescue')).toBe('swift-water rescue');
    expect(humanizeCapability('fire-suppression')).toBe('fire suppression');
    expect(humanizeCapability('traffic-control')).toBe('traffic control');
  });
});
