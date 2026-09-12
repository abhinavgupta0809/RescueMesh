# RescueMesh

RescueMesh is a **hackathon simulation** of a multi-agency command center responding to a Pittsburgh flash flood. It combines a shared operating picture, resource assignments, and recommendations from five specialized AI roles in one compact demo.

> **Exercise only:** RescueMesh is not an emergency service, dispatch system, or source of operational guidance. All incidents, facility capacities, unit availability, travel times, assignments, and recommendations in this repository are synthetic.

## Demo scope

The fixed scenario begins at 18:40 on a fictional summer evening after intense rainfall creates three incidents near the Monongahela River. The seed contains exactly three hospitals, three fire houses, two police hubs, and two rescue centers. The Incident Commander, Medical Chief, Police Chief, Rescue Chief, and Logistics Chief each contribute one inspectable recommendation.

The first milestone intentionally does only four things:

1. Shows incidents, modeled facilities, resources, routes, and a chronological event feed.
2. Exposes a deterministic scenario through a small HTTP API.
3. Demonstrates where reasoning, optimization, mapping, persistence, voice, identity, hosting, and edge adapters connect.
4. Runs completely without cloud accounts or credentials.

It does **not** implement production authentication, live dispatch, real GIS layers, distributed coordination, or emergency-management claims.

The ordered implementation roadmap and milestone exit criteria are in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). The typed command contract, state machines, response/error shapes, and invariants for the interactive demo are in [docs/IMPLEMENTATION_CONTRACT.md](docs/IMPLEMENTATION_CONTRACT.md) — that document is the source of truth for anything touching `packages/shared`.

## Architecture

```text
apps/web             React + Vite command-center interface        (Codex)
       │  HTTP: typed commands + revision polling
apps/api             Express API, adapter boundary, Gemini chiefs  (Claude)
       │
packages/engine      Deterministic simulation engine — sole state authority
       │
packages/shared      Domain schemas, commands, invariants, seed    (Claude)
```

The API owns the adapter boundary. Its current adapters return deterministic fixture data, so the demo is repeatable and offline-friendly:

| Capability                             | Integration                    | Behaviour                                                             |
| -------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| World state and every state transition | Deterministic engine (in-repo) | Authoritative. No model is consulted.                                 |
| Five in-app AI chiefs                  | Gemini                         | Live when `GEMINI_API_KEY` is set; mock otherwise                     |
| Resource allocation                    | Deterministic allocator        | Greedy, explainable; not a solver                                     |
| Shared world state persistence         | MongoDB Atlas                  | In-memory engine state                                                |
| Geography and travel time              | Google Maps, Places, Routes    | Synthetic coordinates and modeled routes                              |
| Spoken field reports and alerts        | ElevenLabs                     | Transcript-only mock response                                         |
| User roles                             | Auth0                          | Fixed commander role                                                  |
| Backend hosting                        | Vultr                          | Local Node process                                                    |
| Development tooling (no runtime role)  | IFM / K2                       | `npm run k2`, `npm run ifm:check`. Reserved for a separate submission |

The adapters are simple interfaces in `apps/api/src/adapters/contracts.ts`. Replacing a mock should not require changing route handlers or the shared schema.

## Local setup

Requirements: Node.js 20 or newer and npm.

```bash
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API listens at [http://localhost:4000](http://localhost:4000). No environment values are needed for mock mode; `.env` is ignored by Git.

Useful endpoints:

- `GET /health` — service status, and which reasoning provider and model are active
- `GET /api/scenario` — complete typed demo scenario
- `GET /api/world-state` — assignments, routes, events, and simulated clock
- `POST /api/reports/parse` with `{ "report": "Two people trapped" }` — one field report into a reviewable incident draft, plus its provenance
- `GET /api/recommendations` — one recommendation per chief, each with its provenance
- `GET /api/recommendations/:role` — a single chief, e.g. `rescue_chief`

## Runtime architecture

```text
  UI (apps/web)
    │  POST /api/commands        typed command
    ▼
  API (apps/api)
    │  engine.execute(command)
    ▼
  Simulation engine (packages/engine)   ← the ONLY thing that mutates world state
    │  validated, deterministic, invariant-checked
    ▼
  API exposes the authoritative scenario
    │  GET /api/scenario, GET /api/world-state?since=<revision>
    ▼
  UI polls, renders, and asks for advice
    │  GET /api/recommendations
    ▼
  Gemini chiefs analyze a role-scoped slice → advisory only, never mutates state
```

The separation matters: **Gemini advises, the engine decides.** A chief's
recommendation is a `pending` suggestion carrying the revision it analyzed. To
act on it, a human approves a plan, and that approval goes back through the
engine, which re-checks live availability, double-booking, staleness, and closed
routes before any resource is assigned.

### Ownership

| Area                                                     | Owner  |
| -------------------------------------------------------- | ------ |
| `packages/engine` — simulation, transitions, determinism | Claude |
| Five in-app AI chiefs behind `ReasoningAdapter`          | Gemini |
| `apps/web` — command-center frontend                     | Codex  |
| `packages/shared`, backend integration, verification     | Claude |

The deterministic engine in `packages/engine` is the sole authority for
simulation state. **No model participates in a state transition.** Gemini
advises; the operator approves; the engine validates and applies.

## Enabling the Gemini chiefs

The five chiefs run on Gemini. Pasting a key is the only setup step:

```bash
cp .env.example .env
# edit .env and set: GEMINI_API_KEY=AIza...
npm run dev
```

Without a key the chiefs answer from deterministic mocks, labelled `mock` on
every card. Model requests are made **only by the backend** — the key is never
read by, sent to, or exposed in the frontend.

| Variable                   | Default                                            | Purpose                    |
| -------------------------- | -------------------------------------------------- | -------------------------- |
| `GEMINI_API_KEY`           | _(empty)_                                          | Empty means mock-only mode |
| `GEMINI_BASE_URL`          | `https://generativelanguage.googleapis.com/v1beta` | API base                   |
| `GEMINI_MODEL`             | `gemini-2.0-flash`                                 | Model id                   |
| `GEMINI_TIMEOUT_MS`        | `20000`                                            | Budget before falling back |
| `GEMINI_MAX_OUTPUT_TOKENS` | `1024`                                             | Reply cap                  |
| `GEMINI_TEMPERATURE`       | `0.2`                                              | Low, output must parse     |

### Provenance and fallback

Every reasoning result carries a `source`:

```json
{ "provider": "gemini", "model": "gemini-2.0-flash", "degraded": false }
```

`degraded: true` means Gemini was configured and tried, and the deterministic
mock answered instead; `warning` carries the reason. Fallback covers a missing
key, network error, timeout, non-2xx response, safety block, and output that
fails validation. The UI shows the provider on every card.

Advice is memoised against the scenario revision it analyzed, so repeated UI
polling at an unchanged revision calls no model at all. A command advances the
revision and retires the cached advice.

### IFM / K2 — development tooling, no runtime role

**RescueMesh never calls IFM.** No request path reads an IFM credential, and the
demo runs fully with `IFM_API_KEY` empty. The client below is standalone
tooling, reserved for a separate Vault Ledger submission:

```bash
npm run k2 -- "your prompt"     # one-shot chat with an IFM model
npm run ifm:check               # verify an IFM key end to end
```

These need `IFM_API_KEY` only if you use them. They are unrelated to the chiefs, to scenario progression, and to world state.

## Two-minute demo flow

1. Start on the operating picture and call out the explicit **Exercise Only** labeling.
2. Point to the critical Parkway East entrapment and the synthetic road restriction.
3. Trace the dispatched rescue boat and police unit to that incident.
4. Compare AGH’s modeled spare capacity with Mercy and Presbyterian.
5. Walk through the five chiefs’ recommendations and their confidence values.
6. Disconnect the API or run only the web app to show the deterministic browser fallback still renders the scenario.

## Data model

The shared package defines typed records for:

- facilities and their **synthetic** capacities/load;
- resources, crews, capabilities, and availability;
- incidents, severity, people at risk, and capability needs;
- route status and **synthetic** travel estimates;
- proposed/approved/dispatched assignments and rationale;
- five-role agent recommendations with confidence and review state;
- append-style world-state events.

Seed records use recognizable Pittsburgh place names only for demo orientation. Coordinates are approximate, and no facility names, capacities, response coverage, route values, or operational status should be interpreted as current facts.

## Validation

Run the full local gate:

```bash
npm run check
```

This checks formatting, lint rules, TypeScript across all workspaces, seed/API tests, and production builds. Tests verify the promised facility mix, reference integrity, health response, scenario endpoint, and basic request validation.

## Implementation choices

- **One fixed scenario:** stronger storytelling and fewer failure modes than a scenario editor.
- **Shared compile-time types:** enough safety for the first demo without introducing a schema framework.
- **Commands, not writable resources:** one `POST /api/commands` endpoint with an idempotency key per command, so retries and replays are safe and every change is one auditable transition through the simulation engine.
- **Deterministic mocks first:** integration credentials can be added one adapter at a time while keeping local development and judging reliable.
- **No provider SDK:** the Gemini chiefs are one `fetch` call against `generateContent`, which keeps the dependency tree and the failure surface small and makes the fallback path easy to test.
- **No real map SDK yet:** the stylized operating picture communicates hierarchy while avoiding keys, quotas, and a misleading claim of live routing.

## Next sensible slice

The five chiefs run on Gemini behind `ReasoningAdapter`; the eight-step command flow and the recorded scenario script run end to end through the deterministic engine, with no model in any state transition. K2/IFM has no runtime role and is reserved for a separate submission.

The next sensible slices, in order: persist world state behind `WorldStateStore` so a restart does not return to the seed; retire `apps/web/src/mock-client.ts` now that the engine covers the same behaviour; then dispatch and completion transitions (`dispatched` -> `complete`).
