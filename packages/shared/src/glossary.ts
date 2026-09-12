import type { Scenario } from './types.js';

/**
 * ── Presentation-layer entity glossary ────────────────────────────────────────
 *
 * Maps authoritative identifiers to names a nontechnical reader understands.
 * Purely presentational: engine state, commands and API payloads keep their real
 * ids, and nothing here is ever written back into world state.
 *
 * Built from the authoritative scenario, so it can never drift from the seed.
 */

export interface EntityGlossary {
  /** Human label for any known id, or the id itself when unknown. */
  label: (id: string) => string;
  /** Replaces every known identifier in a sentence. Safe against overlap. */
  humanize: (text: string) => string;
  /** Known ids, longest first — the order that makes replacement safe. */
  ids: string[];
}

/** advanced-life-support -> advanced life support. */
export const humanizeCapability = (capability: string): string => {
  const named: Record<string, string> = {
    'advanced-life-support': 'advanced life support',
    'swift-water-rescue': 'swift-water rescue',
    'fire-suppression': 'fire suppression',
    'traffic-control': 'traffic control',
    'high-water-response': 'high-water response',
    'medical-supplies': 'medical supplies',
    evacuation: 'evacuation',
    barriers: 'barriers'
  };
  return named[capability] ?? capability.replaceAll('-', ' ');
};

/** amb-21 / MED-21 -> "Ambulance 21". */
const resourceLabel = (kind: string, callsign: string): string => {
  const digits = /(\d+)\s*$/.exec(callsign)?.[1] ?? callsign;
  const kinds: Record<string, string> = {
    ambulance: 'Ambulance',
    fire_engine: 'Fire Engine',
    police_unit: 'Police Unit',
    rescue_boat: 'Rescue Boat',
    supply_truck: 'Supply Truck'
  };
  const name = kinds[kind];
  return name ? `${name} ${digits}` : callsign;
};

export const buildGlossary = (scenario: Scenario): EntityGlossary => {
  const map = new Map<string, string>();

  for (const incident of scenario.incidents) {
    map.set(
      incident.id,
      incident.address ? `${incident.title} (${incident.address})` : incident.title
    );
  }
  for (const resource of scenario.resources) {
    const label = resourceLabel(resource.kind, resource.callsign);
    map.set(resource.id, label);
    // Chiefs sometimes quote the callsign instead of the id.
    if (resource.callsign !== resource.id) map.set(resource.callsign, label);
  }
  for (const facility of scenario.facilities) map.set(facility.id, facility.name);
  for (const zone of scenario.zones) map.set(zone.id, zone.name);
  for (const bridge of scenario.bridges) map.set(bridge.id, bridge.name);
  for (const route of scenario.routes) {
    const from = map.get(route.fromId) ?? route.fromId;
    const to = map.get(route.toId) ?? route.toId;
    map.set(route.id, `the route from ${from} to ${to}`);
  }

  // Longest first: replacing `inc-south` before `inc-southside` would corrupt
  // the longer id, so every replacement considers longer keys first.
  const ids = [...map.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));

  const label = (id: string): string => map.get(id) ?? id;

  /**
   * Token-boundary replacement. Ids may contain hyphens, so a plain word
   * boundary is not enough: a match must not be flanked by an identifier
   * character or a hyphen, or `inc-south` would match inside `inc-southside`.
   */
  const humanize = (text: string): string => {
    if (!text) return text;
    let out = text;
    for (const id of ids) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'g');
      out = out.replace(pattern, (_match, prefix: string) => `${prefix}${map.get(id) ?? id}`);
    }
    return out;
  };

  return { label, humanize, ids };
};

/** A compact "id — human name" table for a model prompt. */
export const glossaryLines = (scenario: Scenario): string => {
  const glossary = buildGlossary(scenario);
  const rows: string[] = [];
  for (const incident of scenario.incidents) rows.push(`${incident.id} = ${incident.title}`);
  for (const resource of scenario.resources)
    rows.push(`${resource.id} = ${glossary.label(resource.id)}`);
  for (const facility of scenario.facilities) rows.push(`${facility.id} = ${facility.name}`);
  for (const zone of scenario.zones) rows.push(`${zone.id} = ${zone.name}`);
  return rows.join('\n');
};
