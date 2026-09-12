import type {
  AgentRecommendation,
  AgentRole,
  Incident,
  Scenario,
  Severity
} from '@rescuemesh/shared';
import type { IfmConfig } from '../config.js';
import type { ReasoningAdapter } from './contracts.js';

export type IfmFailureStage = 'transport' | 'timeout' | 'http' | 'shape';

export class IfmError extends Error {
  constructor(
    readonly stage: IfmFailureStage,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'IfmError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface IfmCompletion {
  content: string;
  /** `length` means the reply hit the token cap before it finished. */
  finishReason?: string;
}

const truncate = (value: string, max = 300): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

/**
 * Minimal client for the IFM hosted chat-completions endpoint
 * (`POST {baseUrl}/chat/completions`, bearer auth, reply at
 * `choices[0].message.content`). No streaming and no provider SDK.
 */
export class IfmClient {
  constructor(
    private readonly config: IfmConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  get model(): string {
    return this.config.model;
  }

  get maxTokens(): number {
    return this.config.maxTokens;
  }

  async complete(messages: ChatMessage[], maxTokens?: number): Promise<IfmCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: this.config.temperature,
          max_tokens: maxTokens ?? this.config.maxTokens,
          stream: false
        }),
        signal: controller.signal
      });
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new IfmError(
        aborted ? 'timeout' : 'transport',
        aborted ? `IFM request exceeded ${this.config.timeoutMs}ms` : 'Could not reach the IFM API',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new IfmError(
        'http',
        `IFM API returned ${response.status} ${response.statusText}`.trim(),
        truncate(body)
      );
    }

    const payload: unknown = await response.json().catch(() => null);
    const content = readChoiceContent(payload);
    if (!content) {
      throw new IfmError('shape', 'IFM response had no choices[0].message.content');
    }
    const finishReason = readFinishReason(payload);
    return finishReason === undefined ? { content } : { content, finishReason };
  }
}

const readFinishReason = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const reason = (first as { finish_reason?: unknown }).finish_reason;
  return typeof reason === 'string' ? reason : undefined;
};

const readChoiceContent = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' && content.trim() ? content : undefined;
};

/**
 * Pulls the answer object out of a model reply.
 *
 * K2-Horizon is a reasoning model: it writes its chain of thought into the
 * content field before the answer, and that thinking often contains braces or
 * even a draft JSON object. So scan every balanced top-level object and keep the
 * LAST one that parses — the answer comes after the reasoning. Also tolerates
 * ```json fences.
 */
export const extractJsonObject = (raw: string): Record<string, unknown> => {
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
    throw new IfmError('shape', 'Model reply contained no JSON object', truncate(raw));
  }
  return answer;
};

/** Turns a truncated reasoning reply into an actionable error. */
const guardTruncation = (completion: IfmCompletion, cap: number): void => {
  if (completion.finishReason === 'length') {
    throw new IfmError(
      'shape',
      `IFM reply hit the ${cap}-token cap before finishing its JSON answer`,
      'This model reasons out loud before answering. Raise IFM_MAX_TOKENS in .env.'
    );
  }
};

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'moderate', 'low'];

const requireString = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IfmError('shape', `Model reply is missing a usable "${field}"`);
  }
  return value.trim().slice(0, maxLength);
};

export const ROLE_TITLES: Record<AgentRole, string> = {
  incident_commander: 'Incident Commander',
  medical_chief: 'Medical Chief',
  police_chief: 'Police Chief',
  rescue_chief: 'Rescue Chief',
  logistics_chief: 'Logistics Chief'
};

const ROLE_BRIEFS: Record<AgentRole, string> = {
  incident_commander:
    'You set overall priority across incidents and flag conflicts between agencies.',
  medical_chief:
    'You match casualties to hospital capacity and keep transport capability in reserve.',
  police_chief: 'You own scene access, traffic control, and evacuation routing.',
  rescue_chief: 'You own water rescue, extrication, and required rescue capabilities.',
  logistics_chief: 'You own supply movement, staging, and facility load balancing.'
};

const EXERCISE_GUARD = [
  'This is a training exercise on synthetic data. It is not a real emergency and your',
  'output is advisory only: a human commander reviews every recommendation before it',
  'is acted on. Never claim operational authority and never invent entity IDs.'
].join(' ');

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

const countByStatus = (scenario: Scenario): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const resource of scenario.resources) {
    counts[resource.status] = (counts[resource.status] ?? 0) + 1;
  }
  return counts;
};

/** Reasoning backed by an IFM hosted model (default: K2-Horizon-375B-A23B). */
export class IfmReasoningAdapter implements ReasoningAdapter {
  constructor(private readonly client: IfmClient) {}

  get model(): string {
    return this.client.model;
  }

  /**
   * Report parsing needs less room than a role recommendation, but still enough
   * for the model to reason before answering.
   */
  private get parseBudget(): number {
    return Math.max(1_200, Math.round(this.client.maxTokens / 2));
  }

  async parseReport(report: string): Promise<Pick<Incident, 'title' | 'description' | 'severity'>> {
    const completion = await this.client.complete(
      [
        {
          role: 'system',
          content: [
            'You are the intake analyst for RescueMesh, a multi-agency flood-response exercise.',
            EXERCISE_GUARD,
            'Convert one radio or phone field report into a structured incident draft.',
            'Reply with a single JSON object and nothing else, using exactly these keys:',
            '{"title": string (max 70 chars, no severity words), "description": string (1-2 sentences,',
            'facts from the report only), "severity": one of "critical" | "high" | "moderate" | "low"}.',
            'Grade severity on life risk: entrapment, drowning, or unconscious casualties are "critical";',
            'injuries or rising water with people present are "high"; property or access problems are',
            '"moderate"; informational reports are "low". Do not add facts the report does not contain.'
          ].join('\n')
        },
        { role: 'user', content: `Field report:\n"""\n${report.trim()}\n"""` }
      ],
      this.parseBudget
    );
    guardTruncation(completion, this.parseBudget);

    const parsed = extractJsonObject(completion.content);
    const severity = String(parsed.severity ?? '').toLowerCase() as Severity;
    if (!SEVERITIES.includes(severity)) {
      throw new IfmError('shape', `Model returned unknown severity "${String(parsed.severity)}"`);
    }
    return {
      title: requireString(parsed.title, 'title', 70),
      description: requireString(parsed.description, 'description', 600),
      severity
    };
  }

  async recommend(role: AgentRole, scenario: Scenario): Promise<AgentRecommendation> {
    const incidentIds = scenario.incidents.map((incident) => incident.id);
    const completion = await this.client.complete([
      {
        role: 'system',
        content: [
          `You are the ${ROLE_TITLES[role]} in the RescueMesh flood-response exercise.`,
          ROLE_BRIEFS[role],
          EXERCISE_GUARD,
          'Give exactly one recommendation for the current world state.',
          'Reply with a single JSON object and nothing else, using exactly these keys:',
          '{"summary": string (max 90 chars, the decision), "action": string (max 260 chars, the',
          'concrete next step naming the unit or facility IDs you were given), "confidence": number',
          'between 0 and 1, "relatedIncidentId": one of the incident IDs provided, or null}.',
          `Valid incident IDs: ${incidentIds.join(', ') || 'none'}.`,
          'Only reference IDs present in the world state. Stay inside your own role.',
          'Answer immediately. Do not deliberate at length, do not weigh alternatives in',
          'your reply, and do not restate the world state. Emit the JSON object and stop.'
        ].join('\n')
      },
      {
        role: 'user',
        content: `World state:\n${roleBriefText(role, scenario)}\n\nRespond with the JSON object only.`
      }
    ]);

    guardTruncation(completion, this.client.maxTokens);
    const parsed = extractJsonObject(completion.content);
    const rawConfidence = Number(parsed.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(
          1,
          Math.max(
            0,
            rawConfidence > 1 && rawConfidence <= 100 ? rawConfidence / 100 : rawConfidence
          )
        )
      : 0.5;
    const relatedIncidentId =
      typeof parsed.relatedIncidentId === 'string' && incidentIds.includes(parsed.relatedIncidentId)
        ? parsed.relatedIncidentId
        : undefined;

    return {
      id: `rec-ifm-${role}-${Date.now().toString(36)}`,
      agent: role,
      summary: requireString(parsed.summary, 'summary', 90),
      action: requireString(parsed.action, 'action', 260),
      confidence: Math.round(confidence * 100) / 100,
      createdAt: new Date().toISOString(),
      status: 'pending',
      ...(relatedIncidentId ? { relatedIncidentId } : {})
    };
  }
}
