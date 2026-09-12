# RescueMesh Build Plan

This plan optimizes for a reliable HackCMU demo, not production completeness. Each milestone ends in a usable vertical slice and keeps the deterministic mock path working.

## Demo success criteria

A judge can submit or select a field report, see it become a structured incident, review five role-specific recommendations, inspect an explainable resource assignment on the Pittsburgh operating picture, approve it, and hear a spoken alert. If any cloud integration is unavailable, the same flow completes with clearly labeled mock data.

## Milestone 0 — Verified foundation (complete)

- [x] TypeScript monorepo with web, API, and shared domain package
- [x] Fixed Pittsburgh flash-flood scenario and typed seed data
- [x] Command-center shell with incident, map, resource, agent, and event panels
- [x] Health, scenario, world-state, and deterministic report-parsing endpoints
- [x] Adapter contracts for reasoning, allocation, state, geography, voice, identity, and edge inference
- [x] Formatting, linting, type checks, tests, production builds, and runtime smoke check

**Exit check:** `npm run check` passes, `/health` returns mock mode, and the app renders without credentials.

## Milestone 1 — Interactive simulation loop (complete)

Contract: [docs/IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md) — eight typed commands, three separate state machines, thirteen invariants enforced by `checkInvariants()`.

- [x] Typed commands, transitions, response/error shapes, and invariants in `packages/shared`
- [x] Deterministic simulation engine in `packages/engine` with an injected clock and seeded IDs
- [x] `POST /api/commands` wired to the engine; the engine is the only writer of world state
- [x] `GET /api/world-state?since=<revision>` revision polling
- [x] Frontend driving those endpoints, with browser-local offline queueing
- [x] Reset restores the seed and clears queues, generated events, and command deduplication

**Exit check:** the presenter runs the full eight-step flow twice with identical results and resets in one click, with `checkInvariants()` clean after every command. Verified over HTTP and through the frontend's own client.

## Milestone 2A — Independent five-chief advice (complete)

Replaced only `ReasoningAdapter`; the deterministic mock remains the fallback.

- [x] Strict JSON output contracts for report parsing and each chief role
- [x] Gemini behind `ReasoningAdapter` with timeouts, validation, and mock fallback
- [x] A narrow prompt per chief, each seeing only its own world-state slice (`roleContext`)
- [x] Recommendations stay advisory and `pending`; approval goes back through the engine
- [x] Provider, model, and `degraded` status shown per card in the interface
- [x] Advice memoised per scenario revision, so polling triggers no model calls
- [x] Model requests confined to the backend; no credential reaches the frontend

**Exit check:** malformed, blocked, or unreachable Gemini responses fall back visibly and safely, and model output can never mutate world state. Covered by `apps/api/src/app.test.ts`.

## Milestone 2B — Visible multi-chief deliberation and final plan (complete)

Three rounds over one frozen snapshot: five initial positions, five
cross-reviews, one Incident Commander synthesis. Eleven Gemini calls per
complete deliberation. Contract: [IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md) §3a.

- [x] Typed contracts: `DeliberationSession`, `DeliberationStatus`, `ChiefPosition`, `ChiefResponse`, `FinalOperationalBrief`, `DeliberationSource`, `DeliberationError`
- [x] Backend orchestrator freezing one snapshot for all three rounds
- [x] Session API: `POST /api/simulations`, `GET /api/simulations/:id`, `POST /api/simulations/:id/final-plan`
- [x] Recorded deliberation fixture on the identical contract, labelled "Scripted fallback"
- [x] Per-session call and token budget with configurable timeouts

**Exit criteria** — all met. Verified with injected responses, and the eleven-call path
confirmed against live Gemini (`ready`, 11 calls, 0 retries, 0 substitutions, 0 errors,
36s wall clock, zero bounds violations). The deliberation frontend is complete:

- [x] Simulate creates exactly one session for one scenario revision
- [x] All five role positions appear
- [x] Each cross-review is based on the validated initial positions
- [x] The Incident Commander produces one final operational brief
- [x] Gemini output cannot change world state
- [x] A state revision during deliberation makes the result stale
- [x] The final plan passes deterministic engine validation
- [x] No plan executes before operator approval
- [x] Gemini failure produces a visibly labelled scripted fallback
- [x] Polling produces no additional Gemini calls
- [x] Reset clears the active deliberation

## Milestone 2C — Multi-hazard exercises (backend complete)

Flash flood joined by structural fire and multi-vehicle collision, one or two
per exercise, operator-selected per zone. Contract:
[IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md) §2a.

- [x] `DisasterKind`, `DisasterSpecification`, exercise validation in `packages/shared`
- [x] Capability templates aligned to the real seed vocabulary
- [x] `scenario.exercise` engine command applying one or two disasters atomically
- [x] `POST /api/simulations` accepting `disasters`, preserving the existing `step` flow

**Exit criteria** — all met with injected model responses; no live Gemini request was
made for this milestone. Frontend selection UI is Codex's and not yet built:

- [x] Any supported disaster in any zone, Downtown included
- [x] Two disasters apply in exactly one revision
- [x] Deliberation starts only after the complete exercise is applied
- [x] All five chiefs see the full multi-disaster snapshot
- [x] Duplicate `requestId` creates no extra incidents and no extra model calls
- [x] Every rejection case named and refused whole
- [x] Reset removes flood, fire and collision incidents and returns to revision zero
- [x] Polling stays at eleven calls

## Milestone 3 — OR-Tools allocation

Implement an allocation adapter as a small Python service or child process only after the interactive loop is stable.

- Objective: minimize modeled travel time and capability shortfalls.
- Constraints: one active assignment per unit, required capability coverage, facility modeled capacity, closed-route exclusion, and a reserve-unit guardrail.
- Output: ranked assignments plus a plain-language rationale and infeasibility reason.
- Fallback: preserve the seeded deterministic assignments.

**Exit check:** a unit is never double-booked, a closed route is never selected, and the same input produces the same assignment.

## Milestone 4 — Real map and routes

1. Render facilities and incidents with Google Maps using approximate demo coordinates.
2. Add Places lookup only for presenter-entered locations.
3. Use Routes travel estimates for candidate assignments, with a short-lived cache.
4. Clearly label route freshness and retain synthetic routes when the API is unavailable.

**Exit check:** the map cannot be mistaken for live emergency data, and route failure never blocks the demo.

## Milestone 5 — Persistence and presentation polish

1. Add MongoDB Atlas behind `WorldStateStore`; store scenario state and append-only events.
2. Add ElevenLabs spoken summaries behind `VoiceAdapter`, with transcript fallback and a mute control.
3. Add Auth0 presenter/observer roles only if time remains; otherwise keep the fixed demo role.
4. Deploy the API to Vultr and the web app to a simple static host.
5. Add a scripted demo reset, seeded hosted scenario, and a recorded fallback walkthrough.

**Exit check:** the hosted demo survives refresh, can reset safely, and has a rehearsed credential-free fallback.

## Optional edge track

Dropped for this submission. K2/IFM is reserved for a separate Vault Ledger submission and has no runtime role in RescueMesh. `EdgeIntelligenceAdapter` remains a mock returning an offline-ready flag.

## Suggested ownership

| Workstream                                          | Primary surface               | Owner      |
| --------------------------------------------------- | ----------------------------- | ---------- |
| Command-center frontend                             | `apps/web`                    | Codex      |
| Simulation engine and deterministic behaviour       | `packages/engine`             | Claude     |
| Five in-app AI chiefs                               | `apps/api/src/adapters`       | Gemini     |
| Shared contracts, backend integration, verification | `packages/shared`, `apps/api` | Claude     |
| OR-Tools optimizer (later)                          | isolated service              | unassigned |
| Map and route integration (later)                   | geography adapter             | unassigned |

**The deterministic engine is the sole authority for simulation state.** No
runtime state transition calls any model. **Gemini provides advisory
reasoning only** and reaches state solely through operator approval, which the
engine then validates. **K2/IFM has no runtime role.**

## Scope guardrails

Do not build production dispatch, autonomous approvals, live responder tracking, a generalized scenario editor, distributed agents, custom authentication infrastructure, full GIS analysis, or claims of operational emergency readiness. Prefer one polished scenario, visible provenance, human approval, deterministic fallbacks, and a fast reset.
