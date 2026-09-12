# RescueMesh Implementation Contract

Owner: shared contracts and integration (Claude). Source of truth for the eight-step interactive demo.

This document and `packages/shared` move together. If an implementation disagrees with this file, the implementation is wrong — raise the conflict rather than diverging. Types referenced here live in `packages/shared/src/types.ts`, `commands.ts`, `invariants.ts`, and `wire.ts`; the invariants in §6 are executable as `checkInvariants(scenario)`.

> **Exercise only.** Every capacity, incident, routing estimate, and impact forecast in this contract is synthetic. Nothing here is an emergency service, a dispatch system, or operational guidance.

## 1. Scope

In scope for this milestone: an in-memory backend, HTTP polling, browser-local persistence for the offline queue, and deterministic mock adapters. Out of scope: a database, websockets, authentication, live GIS, autonomous approval, and any external service that is not optional behind an adapter.

The demo is exactly these eight steps, in this order:

| #   | Step                                     | Command                                 |
| --- | ---------------------------------------- | --------------------------------------- |
| 1   | Trigger a flash flood                    | `scenario.trigger_flood`                |
| 2   | Close a bridge                           | `route.close_bridge`                    |
| 3   | Disconnect a zone                        | `zone.set_connectivity`                 |
| 4   | Submit and queue an offline field report | `report.submit`                         |
| 5   | Reconnect, then apply queued reports     | `zone.set_connectivity` → `report.sync` |
| 6   | Generate a proposed resource plan        | `plan.propose`                          |
| 7   | Approve the plan                         | `plan.approve`                          |
| 8   | Reset to the seeded scenario             | `scenario.reset`                        |

## 2. Three state machines, kept separate

The demo is confusing unless these three are never conflated. They are stored on different records and change through different commands.

### 2.1 Connectivity state — `Zone.connectivity`

Whether a zone can reach the command center. Per zone, not global.

```
online ──disconnect──> offline ──reconnect──> online
   └────degrade────> degraded ────────────────┘
```

| From       | To         | Trigger                            |
| ---------- | ---------- | ---------------------------------- |
| `online`   | `degraded` | `zone.set_connectivity` (degraded) |
| `online`   | `offline`  | `zone.set_connectivity` (offline)  |
| `degraded` | `offline`  | `zone.set_connectivity` (offline)  |
| `degraded` | `online`   | `zone.set_connectivity` (online)   |
| `offline`  | `online`   | `zone.set_connectivity` (online)   |

`degraded` accepts writes but the client must label the data stale. `offline` accepts a `report.submit` but only _queues_ it — `queuedOffline: true`, no incident raised until `report.sync`. Other writes from that zone are rejected with `zone_offline`. Setting a zone to the connectivity it already has is a no-op success with `duplicate: false` and no event.

The **client's own** online/offline state is browser-local and is not server state. The client decides to queue; the server decides whether a report is accepted.

### 2.2 Report synchronization state — `FieldReport.syncState`

```
queued ──sync──> pending ──┬──> applied
                           ├──> duplicate
                           └──> rejected
```

| State       | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `queued`    | Held on the device. Browser-local only; the server has never seen it.    |
| `pending`   | Received by the server, not yet turned into an incident draft.           |
| `applied`   | Became an incident draft. `appliedAt` and `incidentId` are set.          |
| `duplicate` | Its `clientReportId` was already applied. Nothing changed. Not an error. |
| `rejected`  | Failed validation. `rejectionReason` is set. Terminal.                   |

`clientReportId` is generated on the device and is the idempotency key. It is the only thing that makes step 5 exactly-once.

### 2.3 Resource assignment state

Two coupled records. A plan is the reviewable unit; a resource is the scarce thing.

```
ResourcePlan:  proposed ──approve──> approved
                   │
                   └──(a newer plan is proposed)──> superseded

Resource:      available ──plan approved──> assigned ──dispatch──> en_route ──> available
```

| `Assignment.status` | Holds the unit? | Set by                         |
| ------------------- | --------------- | ------------------------------ |
| `proposed`          | No              | `plan.propose`                 |
| `approved`          | Yes             | `plan.approve`                 |
| `dispatched`        | Yes             | seed, or a later dispatch step |
| `complete`          | No              | a later completion step        |

A proposed plan reserves nothing. Only `plan.approve` moves resources to `assigned`. This is what makes double-booking preventable: the check happens once, at approval, against live state.

## 3. Commands

All eight go to one endpoint. `POST /api/commands` with a `Command` envelope; the response is a `CommandResponse`.

```ts
interface CommandEnvelope<TType, TPayload> {
  type: TType;
  commandId: string; // idempotency key, client-generated (uuid)
  issuedAt: string; // ISO 8601
  expectedRevision?: number; // optional optimistic concurrency
  payload: TPayload;
}
```

`commandId` makes **every** command idempotent, not just report sync. Replaying a `commandId` returns the original result with `duplicate: true`, no new events, and an unchanged revision.

### 3.1 Transition table

| Command                  | Preconditions                                                                    | Effect                                                                                                           | Events                                                  |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `scenario.trigger_flood` | `zoneIds` exist (absent means all zones)                                         | Raises synthetic incidents in the named zones, sets `status: 'active'`, may downgrade route status to `slow`     | `flood_triggered`, one `incident_reported` per incident |
| `route.close_bridge`     | `bridgeId` exists; `closed` differs from current status                          | Sets the bridge status and forces every route in `routeIds` to `closed` (reopen restores `open`)                 | `bridge_closed`, one `road_changed` per route           |
| `zone.set_connectivity`  | `zoneId` exists                                                                  | Sets `connectivity` and `connectivityChangedAt`                                                                  | `zone_connectivity_changed`                             |
| `report.submit`          | `zoneId` exists; `body` is 1–4000 chars                                          | Zone `offline` → store as `queued`, raising **no** incident (`queuedOffline: true`). Otherwise apply immediately | `report_queued` or `report_applied`                     |
| `report.sync`            | Every `zoneId` exists                                                            | Applies each report in order, skipping any `clientReportId` already applied                                      | one `report_applied` per newly applied report           |
| `plan.propose`           | At least one active incident; at least one available unit                        | Builds a `proposed` plan, marks any previously `proposed` plan `superseded`. Reserves nothing                    | `plan_proposed`                                         |
| `plan.approve`           | Plan exists and is `proposed`; `basedOnRevision` still current; no unit conflict | Sets plan `approved`, assignments `approved`, resources `assigned`                                               | `plan_approved`, one `resource_dispatched` per unit     |
| `scenario.reset`         | none                                                                             | Replaces all state with a fresh clone of the seed; `revision` returns to `0`; clears the server report log       | `scenario_reset`                                        |

### 3.2 Response shapes

```ts
interface CommandSuccess<TType> {
  ok: true;
  commandId: string;
  type: TType;
  revision: number; // after applying; unchanged when duplicate
  appliedAt: string;
  duplicate: boolean; // true when this commandId was already applied
  data: CommandResultMap[TType];
  events: WorldStateEvent[]; // appended by this command; empty when duplicate
}

interface CommandFailure {
  ok: false;
  commandId: string;
  type: CommandType | 'unknown';
  revision: number; // never advances on failure
  error: { code: CommandErrorCode; message: string; retryable: boolean; details?: object };
}
```

HTTP status is `200` for `ok: true`, `400` for `validation_failed` / `unknown_command`, `404` for `not_found`, `409` for `revision_conflict` / `resource_double_booked` / `plan_stale` / `plan_not_proposed` / `bridge_already_in_state`, `422` for `infeasible` / `zone_offline` / `resource_unavailable` / `route_closed`, `503` for `provider_unavailable`, `500` for `internal_error`. The body is always a `CommandResponse` — never a bare string or an HTML error page.

### 3.3 Error codes

| Code                      | Retryable | When                                                        |
| ------------------------- | --------- | ----------------------------------------------------------- |
| `validation_failed`       | no        | Payload shape or field bounds wrong                         |
| `unknown_command`         | no        | `type` is not one of the eight                              |
| `not_found`               | no        | A referenced id does not exist                              |
| `revision_conflict`       | yes       | `expectedRevision` no longer matches                        |
| `zone_offline`            | yes       | The target zone cannot accept writes — **queue locally**    |
| `bridge_already_in_state` | no        | Closing a closed bridge, or opening an open one             |
| `resource_unavailable`    | yes       | A required unit is not `available`                          |
| `resource_double_booked`  | no        | Approval would give one unit two active assignments         |
| `route_closed`            | no        | The only route to the incident is closed                    |
| `plan_stale`              | yes       | World state moved past the plan's `basedOnRevision`         |
| `plan_not_proposed`       | no        | Approving a plan that is already approved or superseded     |
| `infeasible`              | no        | No plan satisfies the required capabilities                 |
| `provider_unavailable`    | yes       | An optional external adapter failed and no mock could cover |
| `internal_error`          | yes       | Unexpected; must still return a `CommandResponse`           |

## 4. Read endpoints

| Endpoint                           | Returns                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `GET /health`                      | `HealthResponse` — active reasoning provider and model         |
| `GET /api/scenario`                | `Scenario` — full current state                                |
| `GET /api/world-state?since=<rev>` | `WorldStateResponse` — only events after `<rev>`               |
| `GET /api/recommendations`         | Five `RecommendationResponse` items, each with provenance      |
| `GET /api/recommendations/:role`   | One `RecommendationResponse`                                   |
| `POST /api/reports/parse`          | `ParseReportResponse` — one report to a draft, with provenance |

Polling: the client keeps the last `revision` it saw and polls `GET /api/world-state?since=<revision>` every 2–5 seconds. `upToDate: true` means nothing changed. A `since` older than the server's event window returns the full `scenario` instead of a delta.

## 5. Provenance and mock visibility

Every reasoning result carries a `ReasoningSource`:

```ts
{ provider: 'ifm' | 'gemini' | 'mock', model: string, degraded: boolean, warning?: string }
```

- `degraded: true` means a live provider was configured and tried, and the deterministic mock answered instead. `warning` carries the reason.
- The interface must show the provider on every card that came from a model. A judge should never have to guess whether an answer was generated or seeded.
- Model output never mutates world state directly. Severities must match the domain enum, referenced ids are checked against the scenario, confidence is clamped to 0–1, and unknown ids are dropped.
- Recommendations stay `pending` until a human accepts them.

External services stay optional. Absent credentials must never break the demo: the deterministic mock path is always available and always labelled.

## 6. Invariants

Executable as `checkInvariants(scenario): InvariantViolation[]`, which must return `[]` after every command. `assertInvariants(scenario)` throws with all violations listed.

| Id  | Invariant                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | Exactly 3 hospitals, at least 3 fire houses, exactly 2 police hubs, exactly 2 rescue centers                                                                             |
| I2  | No unit is held by more than one active (`approved` or `dispatched`) assignment                                                                                          |
| I3  | A held unit is not `available`; a unit marked `assigned` holds exactly one active assignment                                                                             |
| I4  | Every referenced incident, resource, and facility id exists — in assignments and in plans                                                                                |
| I5  | No **proposed** plan routes a unit over a `closed` route. An already-dispatched unit stranded by a later closure is a valid state the exercise surfaces, not a violation |
| I6  | A `closed` bridge implies every route in its `routeIds` is `closed`                                                                                                      |
| I7  | Every facility belongs to exactly one zone; every incident to at most one                                                                                                |
| I8  | `clientReportId` is unique; `applied` reports have `appliedAt`; only `applied` reports name an incident; `rejected` reports have a reason                                |
| I9  | At most one plan is `proposed` at a time                                                                                                                                 |
| I10 | A `proposed` plan holds only `proposed` assignments; an `approved` plan holds none                                                                                       |
| I11 | Every route, bridge, and impact forecast is flagged `synthetic`                                                                                                          |
| I12 | `revision` is a non-negative integer; event revisions never decrease or exceed it                                                                                        |
| I13 | Modeled capacities stay in bounds: `0 <= currentLoad <= syntheticCapacity`, with non-negative crew and people-at-risk                                                    |

Three properties are behavioural rather than structural, so they are asserted by tests rather than by `checkInvariants`:

- **Exactly-once sync.** Replaying `report.sync` with the same `clientReportId` set adds no incidents and no events, and returns those reports as `duplicates`.
- **Reset fidelity.** After `scenario.reset`, the state deep-equals the seed, `revision` is `0`, and every ledger — queued reports, generated events, and command deduplication — is cleared.
- **Command idempotency.** Replaying any `commandId` returns the original result with `duplicate: true`, appends no events, and leaves the revision unchanged.

## 7. Ownership

| Area                                           | Owner          |
| ---------------------------------------------- | -------------- |
| `packages/shared`, `docs/`, integration review | Claude         |
| `apps/web` and matching the UI reference       | Codex          |
| `apps/api` command handlers, in-memory store   | K2             |
| Five in-app chiefs behind `ReasoningAdapter`   | Gemini (later) |

Rules for everyone: do not change `packages/shared` without updating this document. Do not add a required field to `Scenario` without seeding it. Do not make an external service mandatory. Do not print or log secret values.

## 8. Open items

- Command handlers for all eight commands are **not yet implemented** — `POST /api/commands` does not exist yet. The contract, types, and invariants are ready for K2 to build against.
- `GET /api/world-state` does not yet match `WorldStateResponse`: it currently returns `{ simulatedTime, status, assignments, routes, events }` with no `revision`, `upToDate`, or `since` support. K2 owns bringing it into line; the web client should not depend on the current shape.
- Incident-raising detail for `scenario.trigger_flood` (how many synthetic incidents per intensity level) is deliberately left to the backend, constrained only by I1–I12.
- Dispatch and completion transitions (`dispatched` → `complete`) are out of scope for these eight steps.
- `ReasoningAdapter` currently has an IFM implementation and the deterministic mock. A Gemini implementation slots in behind the same interface with no contract change.
