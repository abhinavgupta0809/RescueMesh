# RescueMesh frontend — Gemini deliberation

Frontend branch: `codex/rescuemesh-frontend`. Backend dependency:
`1a848f99976e1733dc7b244c150d8cbff9e3b2b3` (`claude/deliberation`).
The isolated frontend branch was fast-forwarded to that committed handoff before implementation.
This change edits only `apps/web`; no new dependencies, shared types, engine, backend,
root configuration, main branch, or other active checkout were changed.

## Run safely

```sh
npm ci
npm run dev -w @rescuemesh/web -- --host 127.0.0.1 --port 5175 --strictPort
```

Local mock is the default. It runs the existing TypeScript engine in the browser with
recorded deliberation statements, all labeled **Scripted fallback**. No cloud calls occur.
The command-center design, schematic map, five zones, ten facilities (3 hospitals,
3 fire houses, 2 police hubs, 2 rescue centers), resource panels and offline workflow remain.

To connect the committed backend, select API in Data source, or set
`VITE_API_MODE=api`; `VITE_API_URL` defaults to `http://localhost:4000`.
Gemini configuration and credentials belong only on the server. No provider key, SDK,
provider URL or environment secret is read by browser code.
Do not select Simulate or Refresh chief advice against a Gemini-configured server without
approval for model calls. Loading the frontend and polling world/session status do not ask
for advice automatically.

## Committed API contract

All calls go through `api-client.ts` and the typed `FrontendClient`.

| Route                                         | Use                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/scenario`                           | Authoritative engine snapshot                                            |
| `GET /api/world-state?since=<revision>`       | World polling every 3 seconds                                            |
| `POST /api/simulations`                       | One `{step: "initial_flooding", requestId}` per Simulate                 |
| `GET /api/simulations/:sessionId`             | Session status only; no model calls                                      |
| `POST /api/simulations/:sessionId/final-plan` | Empty object body; engine candidate after ready/degraded                 |
| `POST /api/commands`                          | Existing deterministic controls, reports, reset and `plan.approve`       |
| `GET /api/recommendations`                    | Existing, manually requested independent chief advice                    |
| `POST /api/recommendations/approve`           | Existing independent recommendation approval; proposes, never dispatches |

Session envelopes use the shared `DeliberationSession`, positions, reviews, final brief and
status enums from Claude's commit. The browser validates shape and provenance, rejects
malformed wire data and does not silently switch to mock on API errors.

Important contract detail: the implementation of the deliberation final-plan route calls
`plan.propose` with an empty payload. It does **not** translate the Commander's prose into
assignments. The UI states this explicitly. The existing operator **Approve Plan** action
sends `plan.approve` with `planId` and `expectedRevision`; only its validated engine
acknowledgement confirms execution. The contract's general reference to the recommendation
approval route is not interpreted as a new session-approval endpoint.

## Deliberation and recovery

- Simulate first requests the committed deterministic `initial_flooding` step, then displays
  its acknowledged revision. It never claims the disaster happened before acknowledgement.
- The six-stage visible timeline accompanies five role cards, initial public positions,
  agreements, objections, revised recommendations and Commander synthesis.
- Each returned section identifies Gemini or Scripted fallback, model, frozen scenario
  revision, confidence, stale status and degraded warnings where applicable.
- Mixed sessions use `substituted` for each initial/review contribution. A synthesis-stage
  error identifies a substituted final brief; its recorded model is labeled separately
  from the attempted Gemini model.
- The committed backend publishes positions/reviews at round boundaries, not streamed
  per-chief tokens. The UI renders whatever partial arrays the contract returns; it never
  fabricates live progress.
- Session polling is single-flight every second and stops on terminal state, reset, stale
  world state, transport failure, mode switch, timeout or unmount. Pending reads are aborted
  and obsolete responses ignored using request generations.
- At 15 seconds, slow reasoning is explained. At 120 seconds, status polling stops with an
  explicit timeout. Individual HTTP requests time out after 8 seconds.
- **Resume existing session** uses status GET, or the identical requestId after an uncertain
  trigger acknowledgement. It cannot trigger a second disaster/session accidentally.
  Simulate remains disabled on a transport error until recovery or explicit reset.
- World changes disable approval immediately on the next confirmed snapshot and display:
  “Scenario changed while the chiefs were deliberating. Run a new simulation to generate a current plan.”
  The candidate plan's own revision increment and acknowledged approval are recognized.
- Plan approval remains disabled until a ready/degraded session has a confirmed matching
  current engine candidate. Pending, failed, stale or unacknowledged work is never execution.
- Deterministic controls do not wait for cloud reasoning. The existing Simulate Alternate
  Plan remains a deterministic-only action; it retires the old transcript and requests
  a separate proposal for operator review.

## Temporary mock details

`deliberation-fixture.ts` is a frontend copy of the public recorded fixture from backend
commit `1a848f9`, with model `recorded-deliberation-v1`. It is static exercise content,
not live analysis of the current scenario. `mock-deliberation.ts` plays it through the same
session interface with zero model calls. Only the UI's `initial_flooding` step is supported
locally; unsupported steps fail explicitly. Its typed developments mirror Claude's recorded
initial step and execute through the existing engine. Candidate planning and approval also
use that engine, not a second simulator.

For backend connection, no frontend mock deletion is required: select API mode and run the
dependent commit. Keep the fixture for reliable demos and automated tests. All capacities,
incidents, forecasts and travel estimates remain synthetic.

## Offline workflow and demo checklist

Reports use stable client IDs and mode-specific localStorage write-ahead queues. Offline
zones/devices retain reports locally; reconnect precedes sync. Only applied/duplicate
acknowledgements remove queued reports; rejected or uncertain reports remain inspectable.
Reset requires confirmation, resets the engine and clears the current mode's local queue
and deliberation. Gemini never works offline.

1. Trigger Flash Flood, close Birmingham Bridge, disconnect East / Swissvale.
2. Enter a field report, Queue report, and inspect Sync queue.
3. Reconnect Network; verify the acknowledged report leaves the queue.
4. Select Simulate: one recorded flood step, five chiefs, Debate, Commander synthesis.
5. Check provenance and the **separate** engine resource plan, assignments and shortfalls.
6. Approve Plan; confirm assigned resources and the engine's approval event.
7. Run another Simulate and change the scenario: approval must be blocked as stale.
8. Reset during deliberation; confirm seed state, empty queue and no late transcript.

## Verification

```sh
npx prettier --check apps/web
npx eslint apps/web
npm run typecheck -w @rescuemesh/web
npm test
npm run build -w @rescuemesh/web
```

182 repository tests pass, including 55 frontend tests. Coverage includes progress states,
five cards, partial results, debate/synthesis, mixed and full fallback provenance, malformed
responses, one missing chief, provider failure, timeout, stale results, duplicate triggers,
pending requests, cleanup, offline reports, reconnect, candidate approval and reset.
Seven new real-local-HTTP tests use the committed backend and engine with injected Gemini
responses or no provider. Polling and candidate retries are asserted not to add model calls.

The isolated Playwright smoke script `tests/browser-smoke.mjs` passes the full mock flow at
1440×1000 and 390×844, including approval disabled while pending, reset mid-deliberation,
stale blocking, no runtime errors and no page-width overflow. It blocks requests to any
origin other than the isolated frontend. Screenshots were inspected on desktop and mobile;
the existing map/layout remains intact.

Run with an independently installed Playwright module (no project dependency changes):

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
BROWSER_CHANNEL=chrome \
node apps/web/tests/browser-smoke.mjs
```

Optional `FRONTEND_URL` and `QA_OUTPUT` override the local server and screenshot directory.
The default screenshots are in `/private/tmp/rescuemesh-qa`.

**No actual live-Gemini verification or paid model call was performed.** Gemini-labeled test
results use injected responses. The result stays on a reviewable branch; nothing is merged
into main automatically.
