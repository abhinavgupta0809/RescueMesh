import type {
  AgentRecommendation,
  AgentRole,
  ApprovableAction,
  Incident,
  Scenario,
  Severity
} from '@rescuemesh/shared';
import type { GeminiConfig } from '../config.js';
import type { ReasoningAdapter } from './contracts.js';
import { extractJsonObject, roleBriefText, ROLE_TITLES } from './prompts.js';

export type GeminiFailureStage = 'transport' | 'timeout' | 'http' | 'shape' | 'blocked';

export class GeminiError extends Error {
  constructor(
    readonly stage: GeminiFailureStage,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const truncate = (value: string, max = 300): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

/**
 * Minimal client for the Gemini generateContent endpoint. Credentials stay here,
 * on the backend: the key is read from the environment and sent as a header, and
 * is never returned in a response body or written to a log.
 */
export class GeminiClient {
  constructor(
    private readonly config: GeminiConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  get model(): string {
    return this.config.model;
  }

  async generateJson(systemInstruction: string, prompt: string): Promise<string> {
    const url = `${this.config.baseUrl}/models/${this.config.model}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header auth, not a query parameter: keys must not land in URLs or logs.
          'x-goog-api-key': this.config.apiKey
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: this.config.temperature,
            maxOutputTokens: this.config.maxOutputTokens,
            responseMimeType: 'application/json'
          }
        }),
        signal: controller.signal
      });
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new GeminiError(
        aborted ? 'timeout' : 'transport',
        aborted
          ? `Gemini request exceeded ${this.config.timeoutMs}ms`
          : 'Could not reach the Gemini API',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GeminiError(
        'http',
        `Gemini API returned ${response.status} ${response.statusText}`.trim(),
        truncate(redact(body))
      );
    }

    const payload: unknown = await response.json().catch(() => null);
    const blocked = readBlockReason(payload);
    if (blocked) {
      throw new GeminiError('blocked', `Gemini blocked the request (${blocked})`);
    }
    const text = readCandidateText(payload);
    if (!text) throw new GeminiError('shape', 'Gemini response contained no candidate text');
    // A reply cut off at the cap looks like malformed JSON downstream; say what
    // actually happened so the fix is obvious.
    if (readFinishReason(payload) === 'MAX_TOKENS') {
      throw new GeminiError(
        'shape',
        `Gemini reply hit the ${this.config.maxOutputTokens}-token output cap before finishing its JSON`,
        'Raise GEMINI_MAX_OUTPUT_TOKENS in .env.'
      );
    }
    return text;
  }
}

/** Strips anything key-shaped out of an error body before it is logged. */
const redact = (value: string): string => value.replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***');

const readCandidateText = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return undefined;
  const first: unknown = candidates[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const content = (first as { content?: unknown }).content;
  if (typeof content !== 'object' || content === null) return undefined;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .map((part) =>
      typeof part === 'object' && part !== null ? (part as { text?: unknown }).text : undefined
    )
    .filter((value): value is string => typeof value === 'string')
    .join('');
  return text.trim() ? text : undefined;
};

const readFinishReason = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return undefined;
  const first: unknown = candidates[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const reason = (first as { finishReason?: unknown }).finishReason;
  return typeof reason === 'string' ? reason : undefined;
};

const readBlockReason = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const feedback = (payload as { promptFeedback?: unknown }).promptFeedback;
  if (typeof feedback !== 'object' || feedback === null) return undefined;
  const reason = (feedback as { blockReason?: unknown }).blockReason;
  return typeof reason === 'string' ? reason : undefined;
};

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'moderate', 'low'];

const requireString = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GeminiError('shape', `Gemini reply is missing a usable "${field}"`);
  }
  return value.trim().slice(0, maxLength);
};

const EXERCISE_GUARD = [
  'This is a training exercise on synthetic data. It is not a real emergency.',
  'Your output is advisory only: a human commander reviews every recommendation',
  'before it is acted on, and your reply never changes world state directly.',
  'Never claim operational authority and never invent entity IDs.'
].join(' ');

const ROLE_BRIEFS: Record<AgentRole, string> = {
  incident_commander:
    'You set overall priority across incidents and flag conflicts between agencies.',
  medical_chief:
    'You match casualties to hospital capacity and keep transport capability in reserve.',
  police_chief: 'You own scene access, traffic control, and evacuation routing.',
  rescue_chief: 'You own water rescue, extrication, and required rescue capabilities.',
  logistics_chief: 'You own supply movement, staging, and facility load balancing.'
};

/** The five in-app chiefs, powered by Gemini. Advisory only. */
export class GeminiReasoningAdapter implements ReasoningAdapter {
  constructor(private readonly client: GeminiClient) {}

  get model(): string {
    return this.client.model;
  }

  async parseReport(report: string): Promise<Pick<Incident, 'title' | 'description' | 'severity'>> {
    const text = await this.client.generateJson(
      [
        'You are the intake analyst for RescueMesh, a multi-agency flood-response exercise.',
        EXERCISE_GUARD,
        'Convert one radio or phone field report into a structured incident draft.',
        'Reply with a single JSON object using exactly these keys:',
        '{"title": string (max 70 chars), "description": string (1-2 sentences, facts from the',
        'report only), "severity": one of "critical" | "high" | "moderate" | "low"}.',
        'Grade severity on life risk: entrapment, drowning, or unconscious casualties are',
        '"critical"; injuries or rising water with people present are "high"; property or access',
        'problems are "moderate"; informational reports are "low".',
        'Do not add facts the report does not contain.'
      ].join('\n'),
      `Field report:\n"""\n${report.trim()}\n"""`
    );

    const parsed = extractJsonObject(text, GeminiError);
    const severity = String(parsed.severity ?? '').toLowerCase() as Severity;
    if (!SEVERITIES.includes(severity)) {
      throw new GeminiError(
        'shape',
        `Gemini returned unknown severity "${String(parsed.severity)}"`
      );
    }
    return {
      title: requireString(parsed.title, 'title', 70),
      description: requireString(parsed.description, 'description', 600),
      severity
    };
  }

  async recommend(role: AgentRole, scenario: Scenario): Promise<AgentRecommendation> {
    const incidentIds = scenario.incidents.map((incident) => incident.id);
    const text = await this.client.generateJson(
      [
        `You are the ${ROLE_TITLES[role]} in the RescueMesh flood-response exercise.`,
        ROLE_BRIEFS[role],
        EXERCISE_GUARD,
        'Give exactly one recommendation for the world state you are shown.',
        'Reply with a single JSON object using exactly these keys:',
        '{"summary": string (max 90 chars, the decision), "action": string (max 260 chars, the',
        'concrete next step naming unit or facility IDs from the brief), "confidence": number',
        'between 0 and 1, "relatedIncidentId": one of the incident IDs provided or null,',
        '"proposePlan": either null, or {"incidentIds": [ids to plan for], "reserveUnitsPerKind":',
        'integer 0-3} when your advice is best carried out by asking the allocator for a',
        'resource plan. Use null when your advice is guidance rather than an allocation.}.',
        `Valid incident IDs: ${incidentIds.join(', ') || 'none'}.`,
        'Only reference IDs present in the brief. Stay inside your own role.',
        'All capacities and travel times in the brief are modeled for this exercise.'
      ].join('\n'),
      `World state:\n${roleBriefText(role, scenario)}\n\nRespond with the JSON object only.`
    );

    const parsed = extractJsonObject(text, GeminiError);
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
    // An id the model invented is dropped rather than written into world state.
    const relatedIncidentId =
      typeof parsed.relatedIncidentId === 'string' && incidentIds.includes(parsed.relatedIncidentId)
        ? parsed.relatedIncidentId
        : undefined;

    // A bounded, validated action the operator may approve. Anything the model
    // suggests outside this shape is treated as advisory prose.
    const proposedAction = readProposedAction(parsed.proposePlan, incidentIds);

    return {
      id: `rec-gemini-${role}-${Date.now().toString(36)}`,
      agent: role,
      summary: requireString(parsed.summary, 'summary', 90),
      action: requireString(parsed.action, 'action', 260),
      confidence: Math.round(confidence * 100) / 100,
      createdAt: new Date().toISOString(),
      status: 'pending',
      ...(relatedIncidentId ? { relatedIncidentId } : {}),
      ...(proposedAction ? { proposedAction } : {})
    };
  }
}

/**
 * The only action a chief may propose is a plan request, and only against
 * incident ids that actually exist. Anything else becomes advisory-only, so a
 * hallucinated action can never be approved into a command.
 */
const readProposedAction = (raw: unknown, incidentIds: string[]): ApprovableAction | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as { incidentIds?: unknown; reserveUnitsPerKind?: unknown };
  const ids = Array.isArray(candidate.incidentIds)
    ? candidate.incidentIds.filter(
        (id): id is string => typeof id === 'string' && incidentIds.includes(id)
      )
    : [];
  const reserveRaw = Number(candidate.reserveUnitsPerKind);
  const reserve =
    Number.isInteger(reserveRaw) && reserveRaw >= 0 && reserveRaw <= 3 ? reserveRaw : undefined;
  return {
    kind: 'plan.propose',
    ...(ids.length > 0 ? { incidentIds: ids } : {}),
    ...(reserve !== undefined ? { reserveUnitsPerKind: reserve } : {})
  };
};
