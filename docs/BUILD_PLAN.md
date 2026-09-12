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

## Milestone 1 — Interactive simulation loop

The contract for this milestone is [docs/IMPLEMENTATION_CONTRACT.md](IMPLEMENTATION_CONTRACT.md): eight typed commands, three separate state machines, and twelve invariants enforced by `checkInvariants()`.

- [x] Typed commands, state transitions, response/error shapes, and invariants defined in the shared package
- [x] Field-report form with two preset reports and free text
- [x] A parsed report rendered as a reviewable incident draft with visible provenance
- [ ] `POST /api/commands` handlers for all eight commands (K2)
- [ ] `GET /api/world-state?since=<revision>` polling shape (K2)
- [ ] Browser-local offline queue and reconnect-and-sync flow (Codex)
- [ ] Reset action wired to `scenario.reset` (K2 + Codex)

**Exit check:** the presenter can run the full eight-step flow twice with identical results and reset it in one click, with `checkInvariants()` clean after every command.

## Milestone 2 — IFM K2 reasoning (complete)

Replaced only `ReasoningAdapter` while retaining the mock implementation.

- [x] Strict JSON output contracts for report parsing and each AI role
- [x] IFM K2 parsing with timeouts, validation, and fallback to the deterministic mock
- [x] A narrow prompt per chief, each seeing only the world-state fields for that role (`roleContext`)
- [x] Recommendations stay advisory and `pending` until a human accepts them
- [x] Source (`ifm` or `mock`) and confidence shown per card in the interface

**Exit check:** malformed model output cannot mutate world state; missing credentials and provider errors fall back visibly and safely. Covered by `apps/api/src/adapters/ifm.test.ts`, `reasoning.test.ts`, and the live-mode cases in `app.test.ts`.

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

An on-device IFM model is a stretch goal after the hosted flow is reliable. Limit it to offline classification or summarization of field reports behind `EdgeIntelligenceAdapter`; do not attempt peer-to-peer networking or distributed consensus during the hackathon.

## Suggested ownership

| Workstream                           | Primary surface          | Can proceed after            |
| ------------------------------------ | ------------------------ | ---------------------------- |
| Command-center interactions          | `apps/web`               | Milestone 0                  |
| World-state commands and event log   | `apps/api`               | Milestone 0                  |
| IFM K2 adapter and output validation | `apps/api/src/adapters`  | Incident review flow         |
| OR-Tools optimizer                   | isolated adapter/service | Assignment approval flow     |
| Map and route integration            | web + geography adapter  | Stable incident/resource IDs |
| Deployment and demo script           | repository operations    | Milestones 1–3               |

## Scope guardrails

Do not build production dispatch, autonomous approvals, live responder tracking, a generalized scenario editor, distributed agents, custom authentication infrastructure, full GIS analysis, or claims of operational emergency readiness. Prefer one polished scenario, visible provenance, human approval, deterministic fallbacks, and a fast reset.
