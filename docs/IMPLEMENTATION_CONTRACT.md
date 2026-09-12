# RescueMesh Implementation Contract

Authoritative description of the final architecture. Where an implementation disagrees with this document, the implementation is wrong — raise it rather than diverging.

Types live in `packages/shared/src/`: `types.ts`, `commands.ts`, `invariants.ts`, `scripted-scenario.ts`, `wire.ts`. The invariants in §10 are executable as `checkInvariants(scenario)`.

> **Exercise only.** Every capacity, incident, travel estimate, connectivity state, and impact forecast here is synthetic. RescueMesh is not an emergency service, not a dispatch system, and not a source of operational guidance. It does not predict real flooding.

## 0. The three components

| Component                                    | Role                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| `packages/engine` (deterministic TypeScript) | **Sole authority for simulation state**                  |
| Gemini                                       | **Five advisory chiefs** — analysis and proposed actions |
| `apps/web`                                   | Operator interface (owned by Codex)                      |

**K2/IFM has no runtime role.** No RescueMesh request path reads an IFM credential or calls IFM. The client under `apps/api/src/adapters/ifm.ts` and `apps/api/src/scripts/` is standalone development tooling reserved for a separate Vault Ledger submission; the demo runs with `IFM_API_KEY` empty.

Claude and Codex are development tools. Neither is a runtime component.

## 1. Engine ownership

The engine is the only writer of world state. It owns:

- **Incidents** — creation, severity, status, people at risk
- **Simulated time** — the scenario clock, driven by an injected `Clock`; never wall-clock, and never advanced by model latency
- **Resources** — status, crew, capability, and every assignment
- **Routes and bridges** — status, and the modeled travel times used for planning
- **Zone connectivity** — online, degraded, offline
- **Report queues** — offline capture, sync state, exactly-once reconciliation
- **Dispatch** — resource plans, approval, and the transition to `assigned`
- **Reconciliation** — applying queued reports exactly once on reconnection
- **Reset** — restoring the seed and clearing every ledger

No route handler mutates the scenario. Every change is one `Command` applied through `applyCommand`, which re-checks all invariants and rejects the command whole if any would break.

## 2. Scenario progression

**No LLM is required to advance the scenario.** Two mechanisms, both deterministic:

**Operator controls** — the eight typed commands in §4: `scenario.trigger_flood`, `route.close_bridge`, `zone.set_connectivity`, `report.submit`, `report.sync`, `plan.propose`, `plan.approve`, `scenario.reset`.

**Recorded scenario script** — `POST /api/scenario/advance` applies one named step of a hand-authored deterministic script (`apps/api/src/scenario/script.ts`), via the `scenario.advance` command:

| Step                     | What it develops                                   |
| ------------------------ | -------------------------------------------------- |
| `initial_flooding`       | New incident, an existing one worsens              |
| `bridge_disruption`      | A crossing closes, hospital demand shifts          |
| `evacuation_pressure`    | Modeled demand rises, a call becomes critical      |
| `zone_connectivity_loss` | A report is captured offline, a supply run is held |
| `response_adaptation`    | Access improves, demand flattens                   |
| `stabilization`          | Incidents downgrade, the exercise closes           |

The script is authored TypeScript. The same step from the same revision always produces the same developments; it needs no network, no credentials, and no budget. Reset and replay never call anything external.

Script developments are bounded and validated exactly like any other input: at most three per step, only existing entity ids, no resource creation, no assignment, no travel times. New entities carry a `localRef` and **the engine generates the real id**.

## 3. Gemini ownership

Gemini powers five advisory chiefs — Incident Commander, Medical Chief, Police Chief, Rescue Chief, Logistics Chief. Each:

- Receives a **role-scoped slice of the current engine snapshot** (`roleContext`), not the whole scenario.
- Returns a summary, a concrete action, a confidence in 0–1, optionally a related incident id, and optionally a **bounded proposed action** (§4).
- Is **advisory**. Its output is a `pending` recommendation and changes nothing on its own.

Validation before any output is surfaced: severities must match the domain enum, incident ids are checked against the scenario and dropped if invented, and confidence is clamped.

## 3a. Five-chief deliberation

The chiefs can also run as a **visible deliberation** over one frozen snapshot:
three rounds, eleven Gemini calls, one operator-approvable outcome.

```
operator presses Simulate
  1. engine triggers/advances the selected scripted disaster      (deterministic)
  2. backend FREEZES the resulting scenario revision
  3. five chiefs analyze that same snapshot, in parallel          (5 calls)
  4. UI shows each chief's initial position
  5. each chief sees the other four positions and responds        (5 calls)
  6. Incident Commander synthesises both rounds into a brief      (1 call)
  7. deterministic planner turns supported actions into a plan
  8. engine validates routes, capacity, availability, freshness
  9. UI shows the candidate plan
 10. ONLY operator approval executes it
```

**Exactly eleven calls per complete deliberation.** Polling, rendering, and
reset make none. A session is computed once and read many times.

This transcript is **explicit public-facing output**. Chiefs are asked for
short stated positions only. Hidden chain-of-thought is never requested,
never stored, and never displayed.

### Lifecycle

```
triggered → initial_analysis → cross_review → synthesis → validating → ready
                     │               │            │           │
                     └───────────────┴────────────┴───────────┴──→ degraded | stale | failed
```

| Terminal   | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| `ready`    | All three rounds validated; a candidate plan exists or is obtainable  |
| `degraded` | Completed on the scripted fallback, or with a chief substituted       |
| `stale`    | World state advanced during deliberation; the result must not execute |
| `failed`   | Could not complete even on fallback                                   |

### Session shape

`DeliberationSession` carries `sessionId`, `scenarioRevision`, the disaster or
scenario step, `createdAt`/`updatedAt`/`completedAt`, `status`, five
`ChiefPosition`s, five `ChiefResponse`s, a `FinalOperationalBrief`, the
resulting `planId` when available, `DeliberationSource` provenance, any
`DeliberationError`s, and token/latency metadata when the provider reports it.

Each artefact is deliberately narrow, and anything outside the shape is
rejected rather than trimmed:

- **`ChiefPosition`** — `role`, `situationSummary`, `topPriorities` (≤3),
  `risks` (≤3), `proposedActions` (≤3), `confidence`.
- **`ChiefResponse`** — `role`, `agreements`, `objections`, `revisedPriority`,
  `recommendation`, `confidence`.
- **`FinalOperationalBrief`** — `situationSummary`, `pointsOfAgreement`,
  `unresolvedDisputes`, `orderedPriorities`, `proposedActions`, `rationale`,
  `confidence`.

Strict JSON validation throughout. Unknown action kinds and entity ids that do
not exist in the frozen snapshot are rejected, never coerced.

### Freezing and staleness

The snapshot and its revision are captured once, at step 2, and every call in
all three rounds sees that same snapshot. Before a plan is produced, and again
before it is approved, the revision is rechecked. If world state moved during
deliberation the session becomes `stale`: its brief may be read, but it cannot
produce or execute a plan. Reset clears any active session.

### Failure and fallback

Deterministic simulation continues whether or not Gemini is reachable. A
missing key, timeout, block, or malformed reply falls back to a **recorded
deliberation fixture** using the identical contract, labelled **"Scripted
fallback"** and never "Gemini-generated". There is no unbounded retry: each
call gets one attempt within its timeout, and a per-session call and token
budget caps the work.

A single chief failing does not fail the session — that role is filled from the
fixture, the session ends `degraded`, and the substitution is named.

### Routes

| Route                                         | Purpose                                                           |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/simulations`                       | Trigger the deterministic scenario action **and** start a session |
| `GET /api/simulations/:sessionId`             | Progress and whatever contributions are complete                  |
| `POST /api/simulations/:sessionId/final-plan` | Produce the deterministic candidate plan after synthesis          |
| `POST /api/recommendations/approve`           | **Unchanged.** Still the only execution boundary.                 |

These are additive. `POST /api/scenario/advance`, `GET /api/recommendations`
and every existing route keep their current shape and behaviour; the
independent five-chief advice path in §3 is untouched and still available.

## 4. Approval boundary

**Gemini must never directly mutate state.** The only path from advice to a state change:

```
chief recommendation (pending, carries analyzedRevision)
   → operator approves via POST /api/recommendations/approve
   → backend maps proposedAction to an EXISTING engine command
   → engine validates it like any operator command
```

A deliberation's candidate plan reaches execution through this same boundary:
the session produces a `proposed` plan via the engine, and the operator
approves it with the existing `plan.approve` command. Nothing about a
deliberation shortens or bypasses this path.

The approvable set is deliberately narrow. Today it is exactly one member:

```ts
type ApprovableAction = {
  kind: 'plan.propose';
  incidentIds?: string[];
  reserveUnitsPerKind?: number;
};
```

Approval cannot invent a capability the engine lacks. A recommendation with no `proposedAction` is advisory-only: approving it is refused with `advisory_only`, and the operator acts through the normal controls instead.

Refusal codes: `not_found`, `stale_recommendation`, `advisory_only`, `already_resolved`. HTTP `404` for not found, `409` for the rest, and the engine's own status codes when the derived command itself fails.

Resource dispatch still requires the existing `plan.approve` command. Approving a chief's advice at most produces a _proposed_ plan for the operator to review.

## 5. Revision handling

Every recommendation carries `analyzedRevision`: the scenario revision it was computed from. `RecommendationsResponse` carries the revision and whether it was served from cache.

An approval is refused as `stale_recommendation` unless **both** the revision the operator saw and the revision the advice analyzed still equal the current revision. A stale approval must be revalidated — the operator re-reads the chiefs at the current revision — before it can execute.

Any command that advances the revision invalidates cached advice, so stale advice cannot be approved by accident. Advice is memoised per revision, so repeated UI polling makes no model calls.

## 6. Offline behavior

Unchanged, and deliberately independent of any model:

- A device captures a report with a client-generated `clientReportId`.
- While its zone is `offline`, the report is **queued** and raises no incident.
- On reconnection, `report.sync` applies each report **exactly once**, keyed on `clientReportId`. Retries return duplicates and add no incidents and no events.

**Gemini does not run offline.** When cloud reasoning is unavailable, the chiefs fall back to the deterministic mock, which is clearly labelled `provider: 'mock'` with `degraded: true` and the reason. That is a labelled fallback, not offline AI.

## 7. Credentials

`GEMINI_API_KEY` is read **server-side only**, sent as a request header, and never returned in a response body or written to a log. `apps/web` references no model credential and makes no model call.

No IFM credential and no K2 request is required to run RescueMesh. With `GEMINI_API_KEY` empty the whole demo still runs on deterministic mocks.

## 8. Provenance

Every reasoning result carries:

```ts
{ provider: 'gemini' | 'mock', model: string, degraded: boolean, warning?: string }
```

- `provider: 'gemini'`, `degraded: false` — a live Gemini response.
- `provider: 'mock'`, `degraded: true` — Gemini was configured, tried, and failed; `warning` says why.
- `provider: 'mock'`, `degraded: false` — no Gemini key; deterministic fixture by configuration.

The interface must show the provider on every card produced by reasoning.

**Recorded scenario content is never labelled as AI generation.** `scenario.advance` returns `source: { kind: 'scripted', version }` and carries no provider field. The script is authored deterministic content and must be presented as such.

## 9. API and type compatibility

Public contracts are preserved. Changes made in this pass, for Codex to adapt to:

| Change                                                                                  | Kind                     | Impact on the frontend                            |
| --------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------- |
| `ReasoningProvider` narrowed from `'ifm' \| 'gemini' \| 'mock'` to `'gemini' \| 'mock'` | **Breaking (narrowing)** | Remove any `'ifm'` branch; it can no longer occur |
| `HealthResponse.mode` drops `'ifm-live'`                                                | **Breaking (narrowing)** | Remove any `'ifm-live'` branch                    |
| `AgentRecommendation.proposedAction?`                                                   | Additive                 | Optional; render an Approve control when present  |
| `Scenario.phase`                                                                        | Additive, seeded         | Optional to display                               |
| `scenario.advance` command + `AdvanceScenarioResult`                                    | Additive                 | Needed only to drive the script                   |
| `POST /api/recommendations/approve`                                                     | New endpoint             | Needed only for the approval control              |
| `POST /api/scenario/advance`, `GET /api/scenario/script`                                | New endpoints            | Needed only for scripted progression              |
| Two new `WorldStateEventType` values                                                    | Additive                 | Rendered as ordinary events                       |

Every existing endpoint keeps its shape. No existing field was removed or retyped except the two narrowings above, both of which only delete a case that can no longer occur.

## 10. Invariants

Executable as `checkInvariants(scenario)`, which must return `[]` after every command.

| Id  | Invariant                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| I1  | Exactly 3 hospitals, at least 3 fire houses, exactly 2 police hubs, exactly 2 rescue centers                              |
| I2  | No unit is held by more than one active (`approved` or `dispatched`) assignment                                           |
| I3  | A held unit is not `available`; a unit marked `assigned` holds exactly one active assignment                              |
| I4  | Every referenced incident, resource, and facility id exists                                                               |
| I5  | No **proposed** plan routes a unit over a `closed` route; an already-dispatched unit stranded by a later closure is valid |
| I6  | A `closed` bridge implies every route in its `routeIds` is `closed`                                                       |
| I7  | Every facility belongs to exactly one zone; every incident to at most one                                                 |
| I8  | `clientReportId` is unique; `applied` reports have `appliedAt`; only `applied` reports name an incident                   |
| I9  | At most one plan is `proposed` at a time                                                                                  |
| I10 | A `proposed` plan holds only `proposed` assignments; an `approved` plan holds none                                        |
| I11 | Every route, bridge, and impact forecast is flagged `synthetic`                                                           |
| I12 | `revision` is a non-negative integer; event revisions never decrease or exceed it                                         |
| I13 | Modeled capacities stay in bounds: `0 <= currentLoad <= syntheticCapacity`                                                |

Behavioural properties, asserted by tests rather than `checkInvariants`:

- **Exactly-once sync** — replaying `report.sync` adds no incidents and no events.
- **Reset fidelity** — after `scenario.reset` the state deep-equals the seed, `revision` is `0`, and every ledger is cleared.
- **Command idempotency** — replaying any `commandId` returns the original result with `duplicate: true`.
- **Approval staleness** — an approval against a superseded revision is refused, not executed.

## 11. Ownership

| Area                                                      | Owner  |
| --------------------------------------------------------- | ------ |
| `packages/shared`, `packages/engine`, `apps/api`, `docs/` | Claude |
| `apps/web` frontend alignment                             | Codex  |

Rules: do not change `packages/shared` without updating this document; do not add a required field to `Scenario` without seeding it; do not make an external service mandatory; do not print or log secret values.

## 12. Out of scope

Voice, additional databases, optimization solvers, and further sponsor integrations are explicitly out of scope for this pass.
