import type {
  Command,
  CommandResponse,
  FrontendClient,
  Recommendation,
  Scenario
} from './contract';
import { createMockClient } from './mock-client';

export class ApiError extends Error {
  constructor(
    message: string,
    public code = 'connection_failed'
  ) {
    super(message);
  }
}
export function validateScenario(value: unknown): Scenario {
  const s = value as Partial<Scenario> | null;
  if (
    !s ||
    !Number.isInteger(s.revision) ||
    !Array.isArray(s.zones) ||
    !Array.isArray(s.bridges) ||
    !Array.isArray(s.plans) ||
    !Array.isArray(s.reports) ||
    !Array.isArray(s.facilities) ||
    !Array.isArray(s.resources) ||
    !Array.isArray(s.incidents) ||
    !Array.isArray(s.routes) ||
    !Array.isArray(s.events)
  )
    throw new ApiError(
      'Backend scenario does not match the interactive contract. Select Local mock explicitly to run the demo.',
      'contract_mismatch'
    );
  if (
    s.zones.length < 1 ||
    s.facilities.filter((f) => f.kind === 'hospital').length !== 3 ||
    s.facilities.filter((f) => f.kind === 'fire_house').length < 3 ||
    s.facilities.filter((f) => f.kind === 'police_hub').length !== 2 ||
    s.facilities.filter((f) => f.kind === 'rescue_center').length !== 2
  )
    throw new ApiError(
      'Backend scenario has an unexpected zone or facility mix.',
      'contract_mismatch'
    );
  return s as Scenario;
}
export function createHttpClient(baseUrl: string): FrontendClient {
  async function request(path: string, command?: Command, timeoutMs = 8000): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        ...(command
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(command)
            }
          : {})
      });
    } catch {
      throw new ApiError(
        'Cannot reach the API. No success has been assumed. Check the connection and retry.'
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError('API returned an invalid response.', 'contract_mismatch');
    }
    if (
      !response.ok &&
      !(command && typeof data === 'object' && data !== null && 'ok' in data && data.ok === false)
    )
      throw new ApiError(`API request failed (${response.status}).`);
    return data;
  }
  const client: FrontendClient = {
    mode: 'api',
    scenario: async () => validateScenario(await request('/api/scenario')),
    poll: async (revision) => {
      const result = (await request(`/api/world-state?since=${revision}`)) as {
        revision: number;
        upToDate: boolean;
        scenario?: unknown;
      };
      if (!Number.isInteger(result.revision) || typeof result.upToDate !== 'boolean')
        throw new ApiError('Polling endpoint does not match the contract.', 'contract_mismatch');
      return result.upToDate
        ? null
        : result.scenario
          ? validateScenario(result.scenario)
          : client.scenario();
    },
    recommendations: async () => {
      // The backend's default Gemini budget is 20 seconds. Do not abandon its fallback at 8s.
      const result = (await request('/api/recommendations', undefined, 30000)) as {
        items?: Recommendation[];
      };
      if (
        !result ||
        !Array.isArray(result.items) ||
        result.items.length !== 5 ||
        new Set(result.items.map((r) => r?.recommendation?.agent)).size !== 5 ||
        result.items.some(
          (r) =>
            !r ||
            !r.source ||
            !['gemini', 'mock'].includes(r.source.provider) ||
            typeof r.source.model !== 'string' ||
            !r.source.model.trim() ||
            typeof r.source.degraded !== 'boolean' ||
            (r.source.provider === 'gemini' && r.source.degraded) ||
            !Number.isInteger(r.analyzedRevision) ||
            r.analyzedRevision < 0 ||
            !r.recommendation?.id ||
            ![
              'incident_commander',
              'medical_chief',
              'police_chief',
              'rescue_chief',
              'logistics_chief'
            ].includes(r.recommendation.agent) ||
            typeof r.recommendation.summary !== 'string' ||
            typeof r.recommendation.action !== 'string' ||
            !Number.isFinite(r.recommendation.confidence) ||
            r.recommendation.confidence < 0 ||
            r.recommendation.confidence > 1
        )
      )
        throw new ApiError(
          'Chief advice has missing or unsupported provenance/revision. No advice has been accepted.',
          'contract_mismatch'
        );
      return result.items;
    },
    command: async (command) => {
      const result = (await request('/api/commands', command)) as CommandResponse;
      if (
        !result ||
        typeof result.ok !== 'boolean' ||
        result.commandId !== command.commandId ||
        result.type !== command.type ||
        !Number.isInteger(result.revision) ||
        (result.ok ? !result.data : !result.error?.message)
      )
        throw new ApiError(
          'Invalid command acknowledgement. Refresh state before retrying.',
          'contract_mismatch'
        );
      if (
        result.ok &&
        command.type === 'plan.approve' &&
        (!('plan' in result.data) || result.data.plan.status !== 'approved')
      ) {
        throw new ApiError(
          'Plan approval was not confirmed by the engine. Refresh state before retrying.',
          'contract_mismatch'
        );
      }
      return result;
    }
  };
  return client;
}
export function createClient(mode: 'mock' | 'api'): FrontendClient {
  return mode === 'mock'
    ? createMockClient()
    : createHttpClient(import.meta.env.VITE_API_URL ?? 'http://localhost:4000');
}
export function makeCommand<K extends Command['type']>(
  type: K,
  payload: Extract<Command, { type: K }>['payload'],
  expectedRevision?: number
): Command {
  return {
    type,
    payload,
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  } as Command;
}
