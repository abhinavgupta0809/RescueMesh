import { SimulationEngine, systemClock } from '@rescuemesh/engine';
import {
  isCommandType,
  pittsburghFloodScenario,
  type Command,
  type CommandErrorCode,
  type CommandResponse,
  type Scenario,
  type WorldStateEvent,
  type WorldStateResponse
} from '@rescuemesh/shared';

/**
 * The single authoritative world. Every state change goes through the
 * deterministic simulation engine — no route handler mutates the scenario, and
 * no model output reaches it without passing the engine's validation first.
 */
export class World {
  private readonly engine: SimulationEngine;

  constructor(engine?: SimulationEngine) {
    // The server uses a real clock; tests inject a fixed one for reproducibility.
    this.engine = engine ?? new SimulationEngine({ clock: systemClock });
  }

  get scenario(): Scenario {
    return this.engine.scenario;
  }

  get revision(): number {
    return this.engine.revision;
  }

  execute(command: Command): CommandResponse {
    return this.engine.execute(command);
  }

  /**
   * Events strictly after `since`. Seed events carry revision 0, so `since=0`
   * correctly returns only what commands have produced.
   */
  eventsSince(since: number): WorldStateEvent[] {
    return this.scenario.events.filter((event) => (event.revision ?? 0) > since);
  }

  worldStateSince(since: number | undefined): WorldStateResponse {
    const scenario = this.scenario;
    const base = {
      revision: scenario.revision,
      simulatedTime: scenario.simulatedTime,
      status: scenario.status
    };

    // No cursor, or a cursor from a previous run that is ahead of us (for
    // example after a reset): send the whole world rather than a bad delta.
    if (since === undefined || since < 0 || since > scenario.revision) {
      return { ...base, upToDate: false, events: scenario.events, scenario };
    }
    if (since === scenario.revision) {
      return { ...base, upToDate: true, events: [] };
    }
    return { ...base, upToDate: false, events: this.eventsSince(since), scenario };
  }
}

export const HTTP_STATUS_BY_ERROR: Record<CommandErrorCode, number> = {
  validation_failed: 400,
  unknown_command: 400,
  not_found: 404,
  revision_conflict: 409,
  resource_double_booked: 409,
  plan_stale: 409,
  plan_not_proposed: 409,
  bridge_already_in_state: 409,
  infeasible: 422,
  zone_offline: 422,
  resource_unavailable: 422,
  route_closed: 422,
  provider_unavailable: 503,
  internal_error: 500
};

export interface CommandParseFailure {
  ok: false;
  reason: string;
}

/**
 * Validates the envelope before the engine sees it, so a malformed request is a
 * 400 with a CommandResponse body rather than a thrown error.
 */
export const parseCommand = (
  body: unknown
): { ok: true; command: Command } | CommandParseFailure => {
  if (typeof body !== 'object' || body === null)
    return { ok: false, reason: 'body must be an object' };
  const candidate = body as Record<string, unknown>;
  if (!isCommandType(candidate.type)) {
    return { ok: false, reason: `unknown command type ${JSON.stringify(candidate.type)}` };
  }
  if (typeof candidate.commandId !== 'string' || !candidate.commandId.trim()) {
    return { ok: false, reason: 'commandId is required and must be a non-empty string' };
  }
  if (typeof candidate.issuedAt !== 'string' || !candidate.issuedAt.trim()) {
    return { ok: false, reason: 'issuedAt is required and must be an ISO timestamp' };
  }
  if (
    candidate.expectedRevision !== undefined &&
    (!Number.isInteger(candidate.expectedRevision) || Number(candidate.expectedRevision) < 0)
  ) {
    return { ok: false, reason: 'expectedRevision must be a non-negative integer when present' };
  }
  if (typeof candidate.payload !== 'object' || candidate.payload === null) {
    return { ok: false, reason: 'payload must be an object' };
  }
  return { ok: true, command: body as Command };
};

export const seedFacilityMix = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const facility of pittsburghFloodScenario.facilities) {
    counts[facility.kind] = (counts[facility.kind] ?? 0) + 1;
  }
  return counts;
};
