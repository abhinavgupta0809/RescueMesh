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
apps/web             React + Vite command-center interface
       │  HTTP
apps/api             Express API and integration adapter boundary
       │
packages/shared      TypeScript domain schemas + Pittsburgh seed scenario
```

The API owns the adapter boundary. Its current adapters return deterministic fixture data, so the demo is repeatable and offline-friendly:

| Capability                               | Intended integration        | Milestone behavior                             |
| ---------------------------------------- | --------------------------- | ---------------------------------------------- |
| Incident parsing and five-role reasoning | IFM Labs K2 (hosted)        | Live when `IFM_API_KEY` is set; mock otherwise |
| Resource allocation                      | OR-Tools                    | Seeded, explainable assignments                |
| Shared world state                       | MongoDB Atlas               | In-memory cloned scenario fixture              |
| Geography and travel time                | Google Maps, Places, Routes | Synthetic coordinates and modeled routes       |
| Spoken field reports and alerts          | ElevenLabs                  | Transcript-only mock response                  |
| User roles                               | Auth0                       | Fixed commander role                           |
| Backend hosting                          | Vultr                       | Local Node process                             |
| Offline edge intelligence                | IFM (on-device)             | Offline-ready status flag                      |

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

## Enabling IFM K2 reasoning

Report parsing and the five chief recommendations run on an IFM Labs hosted model. Pasting a key is the only setup step:

```bash
cp .env.example .env        # if you have not already
# edit .env and set: IFM_API_KEY=IFM-xf...
npm run ifm:check           # one real call, prints the model's reply
npm run dev
```

`npm run ifm:check` verifies the key, the base URL, and that the model's JSON output validates against the domain schema. It exits non-zero on failure and tells you what broke.

Defaults come from the IFM quickstart and can be overridden in `.env`:

| Variable          | Default                    | Purpose                                     |
| ----------------- | -------------------------- | ------------------------------------------- |
| `IFM_API_KEY`     | _(empty)_                  | Your key. Empty means mock-only mode.       |
| `IFM_BASE_URL`    | `https://api.ifm.ai/v1`    | Chat-completions base URL.                  |
| `IFM_MODEL`       | `IFM/K2-Horizon-375B-A23B` | Hosted model id.                            |
| `IFM_TIMEOUT_MS`  | `20000`                    | Per-request budget before falling back.     |
| `IFM_MAX_TOKENS`  | `800`                      | Reply cap.                                  |
| `IFM_TEMPERATURE` | `0.2`                      | Low, because the output must parse as JSON. |

The API reads `.env` itself — no dotenv dependency and no shell exports needed. Real environment variables take precedence over the file.

### How the fallback works

`ResilientReasoningAdapter` wraps the IFM adapter and the deterministic mock. It falls back to the mock on a missing key, a network error, a timeout, any non-2xx response, or output that fails validation. Every response carries a `source`:

```json
{ "provider": "ifm", "model": "IFM/K2-Horizon-375B-A23B", "degraded": false }
```

`degraded: true` means IFM was configured and tried, and the mock answered instead; `warning` then carries the reason. The interface shows the same label on each card, so a judge can always see which answers came from the model. Model output can never mutate world state directly: severities must match the domain enum, incident IDs are checked against the scenario, confidence is clamped, and unknown IDs are dropped.

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
- **Read-only scenario API:** the event model shows the intended evolution without prematurely building mutation/conflict logic.
- **Deterministic mocks first:** integration credentials can be added one adapter at a time while keeping local development and judging reliable.
- **No provider SDK:** the IFM endpoint is OpenAI-shaped, so one `fetch` call with a bearer token keeps the dependency tree and the failure surface small.
- **No real map SDK yet:** the stylized operating picture communicates hierarchy while avoiding keys, quotas, and a misleading claim of live routing.

## Next sensible slice

Report parsing and the five chief roles now run on IFM K2 behind `ReasoningAdapter`. The next slice is human approval: turning a parsed draft into an incident and an accepted recommendation into a world-state event. A later OR-Tools adapter can optimize against the same resource, incident, and route records while retaining deterministic fixtures for tests.
