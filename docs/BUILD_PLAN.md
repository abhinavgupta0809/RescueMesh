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

## Milestone 2 — Gemini chiefs (complete)

Replaced only `ReasoningAdapter`; the deterministic mock remains the fallback.

- [x] Strict JSON output contracts for report parsing and each chief role
- [x] Gemini behind `ReasoningAdapter` with timeouts, validation, and mock fallback
- [x] A narrow prompt per chief, each seeing only its own world-state slice (`roleContext`)
- [x] Recommendations stay advisory and `pending`; approval goes back through the engine
- [x] Provider, model, and `degraded` status shown per card in the interface
- [x] Advice memoised per scenario revision, so polling triggers no model calls
- [x] Model requests confined to the backend; no credential reaches the frontend

**Exit check:** malformed, blocked, or unreachable Gemini responses fall back visibly and safely, and model output can never mutate world state. Covered by `apps/api/src/app.test.ts`.

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

| Workstream                                          | Primary surface               | Owner      |
| --------------------------------------------------- | ----------------------------- | ---------- |
| Command-center frontend                             | `apps/web`                    | Codex      |
| Simulation engine and deterministic behaviour       | `packages/engine`             | K2         |
| Five in-app AI chiefs                               | `apps/api/src/adapters`       | Gemini     |
| Shared contracts, backend integration, verification | `packages/shared`, `apps/api` | Claude     |
| OR-Tools optimizer (later)                          | isolated service              | unassigned |
| Map and route integration (later)                   | geography adapter             | unassigned |

**K2 owns the simulation engine** — it builds and maintains the deterministic
simulation code. No runtime state transition calls a hosted model. **Gemini
provides advisory reasoning only** and never mutates world state.

## Scope guardrails

Do not build production dispatch, autonomous approvals, live responder tracking, a generalized scenario editor, distributed agents, custom authentication infrastructure, full GIS analysis, or claims of operational emergency readiness. Prefer one polished scenario, visible provenance, human approval, deterministic fallbacks, and a fast reset.
