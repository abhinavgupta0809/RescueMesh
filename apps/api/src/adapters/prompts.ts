import type { AgentRole, Scenario } from '@rescuemesh/shared';

/**
 * Prompt construction and reply parsing shared by every reasoning provider.
 * Gemini powers the five chiefs; the retained IFM tooling reuses the same
 * helpers, so switching providers cannot silently change what a chief sees or
 * how strictly its reply is validated.
 */

export interface ProviderErrorConstructor {
  new (stage: 'shape', message: string, detail?: string): Error;
}

const truncate = (value: string, max = 300): string =>
  value.length <= max ? value : `${value.slice(0, max)}\u2026`;

/**
 * Pulls the answer object out of a model reply.
 *
 * Reasoning models write their chain of thought into the reply before the answer,
 * and that thinking often contains braces or
 * even a draft JSON object. So scan every balanced top-level object and keep the
 * LAST one that parses — the answer comes after the reasoning. Also tolerates
 * ```json fences.
 */
export const extractJsonObject = (
  raw: string,
  ProviderError: ProviderErrorConstructor
): Record<string, unknown> => {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const text = fenced.at(-1) ?? raw;

  const candidates: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, index + 1));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            candidates.push(parsed as Record<string, unknown>);
          }
        } catch {
          // Not valid JSON on its own; keep scanning for the real answer.
        }
        start = -1;
      }
    }
  }

  const answer = candidates.at(-1);
  if (!answer) {
    throw new ProviderError('shape', 'Model reply contained no JSON object', truncate(raw));
  }
  return answer;
};

export const ROLE_TITLES: Record<AgentRole, string> = {
  incident_commander: 'Incident Commander',
  medical_chief: 'Medical Chief',
  police_chief: 'Police Chief',
  rescue_chief: 'Rescue Chief',
  logistics_chief: 'Logistics Chief'
};

/** Only the world-state slice each role is allowed to reason over. */
export const roleContext = (role: AgentRole, scenario: Scenario): Record<string, unknown> => {
  const incidents = scenario.incidents.map((incident) => ({
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    address: incident.address,
    peopleAtRisk: incident.peopleAtRisk,
    requiredCapabilities: incident.requiredCapabilities,
    status: incident.status
  }));
  const restrictedRoutes = scenario.routes
    .filter((route) => route.status !== 'open')
    .map((route) => ({
      from: route.fromId,
      to: route.toId,
      status: route.status,
      travelMinutes: route.travelMinutes
    }));
  const facilitiesOfKind = (kinds: Scenario['facilities'][number]['kind'][]) =>
    scenario.facilities
      .filter((facility) => kinds.includes(facility.kind))
      .map((facility) => ({
        id: facility.id,
        name: facility.name,
        status: facility.status,
        syntheticCapacity: facility.syntheticCapacity,
        currentLoad: facility.currentLoad,
        spare: facility.syntheticCapacity - facility.currentLoad
      }));
  const resourcesOfKind = (kinds: Scenario['resources'][number]['kind'][]) =>
    scenario.resources
      .filter((resource) => kinds.includes(resource.kind))
      .map((resource) => ({
        id: resource.id,
        callsign: resource.callsign,
        kind: resource.kind,
        status: resource.status,
        crew: resource.crew,
        capabilities: resource.capabilities
      }));

  const base = {
    simulatedTime: scenario.simulatedTime,
    scenarioStatus: scenario.status,
    incidents
  };
  switch (role) {
    case 'incident_commander':
      return {
        ...base,
        restrictedRoutes,
        resourceCounts: countByStatus(scenario),
        facilities: facilitiesOfKind(['hospital', 'fire_house', 'police_hub', 'rescue_center'])
      };
    case 'medical_chief':
      return {
        ...base,
        hospitals: facilitiesOfKind(['hospital']),
        units: resourcesOfKind(['ambulance'])
      };
    case 'police_chief':
      return {
        ...base,
        restrictedRoutes,
        policeHubs: facilitiesOfKind(['police_hub']),
        units: resourcesOfKind(['police_unit'])
      };
    case 'rescue_chief':
      return {
        ...base,
        rescueCenters: facilitiesOfKind(['rescue_center', 'fire_house']),
        units: resourcesOfKind(['rescue_boat', 'fire_engine'])
      };
    case 'logistics_chief':
      return {
        ...base,
        restrictedRoutes,
        facilities: facilitiesOfKind(['hospital', 'fire_house', 'police_hub', 'rescue_center']),
        units: resourcesOfKind(['supply_truck'])
      };
  }
};

const countByStatus = (scenario: Scenario): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const resource of scenario.resources) {
    counts[resource.status] = (counts[resource.status] ?? 0) + 1;
  }
  return counts;
};

/**
 * Renders the role's slice of world state as a compact brief. Raw JSON made
 * K2-Horizon deliberate for thousands of tokens; short labelled lines cut both
 * the input size and the reasoning it triggers.
 */
export const roleBriefText = (role: AgentRole, scenario: Scenario): string => {
  const context = roleContext(role, scenario) as Record<string, unknown>;
  const lines: string[] = [`TIME ${scenario.simulatedTime} | SCENARIO ${scenario.status}`];

  const incidents = context.incidents as
    | {
        id: string;
        severity: string;
        address: string;
        peopleAtRisk: number;
        requiredCapabilities: string[];
      }[]
    | undefined;
  if (incidents?.length) {
    lines.push('INCIDENTS');
    for (const incident of incidents) {
      lines.push(
        `  ${incident.id} | ${incident.severity} | ${incident.address} | ${incident.peopleAtRisk} at risk | needs ${incident.requiredCapabilities.join(', ') || 'none'}`
      );
    }
  }

  const units = context.units as
    | { id: string; callsign: string; kind: string; status: string; capabilities: string[] }[]
    | undefined;
  if (units?.length) {
    lines.push('MY UNITS');
    for (const unit of units) {
      lines.push(
        `  ${unit.id} (${unit.callsign}) | ${unit.kind} | ${unit.status} | ${unit.capabilities.join(', ')}`
      );
    }
  }

  for (const key of ['hospitals', 'policeHubs', 'rescueCenters', 'facilities'] as const) {
    const facilities = context[key] as
      | { id: string; name: string; status: string; spare: number; syntheticCapacity: number }[]
      | undefined;
    if (!facilities?.length) continue;
    lines.push(`${key.toUpperCase()} (modeled capacity)`);
    for (const facility of facilities) {
      lines.push(
        `  ${facility.id} | ${facility.name} | ${facility.status} | ${facility.spare} of ${facility.syntheticCapacity} spare`
      );
    }
  }

  const routes = context.restrictedRoutes as
    { from: string; to: string; status: string; travelMinutes: number }[] | undefined;
  if (routes?.length) {
    lines.push('RESTRICTED ROUTES (modeled)');
    for (const route of routes) {
      lines.push(`  ${route.from} -> ${route.to} | ${route.status} | ${route.travelMinutes} min`);
    }
  }

  const counts = context.resourceCounts as Record<string, number> | undefined;
  if (counts) {
    lines.push(
      `UNIT COUNTS ${Object.entries(counts)
        .map(([status, count]) => `${status}=${count}`)
        .join(' ')}`
    );
  }

  return lines.join('\n');
};
