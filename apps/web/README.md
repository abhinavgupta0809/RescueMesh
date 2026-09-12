# RescueMesh frontend alignment

Frontend-only alignment on `codex/rescuemesh-frontend`, based on Claude's committed
integration `e863399`. Main and the other development checkouts are not modified.
React/Vite, the existing stylesheet, map geometry, panels and simulation controls are
preserved. No new scenario control or endpoint has been invented.

## Runtime boundaries

- The existing `@rescuemesh/engine` TypeScript engine owns every simulation transition.
  Local mock mode now wraps this same engine; the separate browser reducer is removed.
- Gemini supplies advisory chiefs through the backend. No provider SDK, provider URL,
  key or secret is read by browser code. Codex and Claude are development tools only.
- Chief prose is never submitted as executable state. The committed contract exposes
  `plan.propose` and `plan.approve`, not a chief-recommendation execution command. The
  operator reviews the deterministic proposal and approval returns to engine validation.
- Advice is marked Gemini-generated only for supported response provenance. Mock and
  degraded fallback responses are labeled scripted. Advice includes analyzedRevision;
  mismatched revisions are stale, and pending/accepted advice is never an execution receipt.
- Advice loading is separate from scenario loading and command completion. A slow or
  unavailable cloud cannot lock the deterministic controls. Superseded requests are ignored,
  including late responses after reset when revision numbers repeat.
- Cloud reasoning requires connectivity. Offline messages identify cached advice and the
  local report queue; they do not imply Gemini runs offline.

## Run

```sh
npm ci
npm run dev -w @rescuemesh/web -- --host 127.0.0.1 --port 5174 --strictPort
```

Local mock is the default. It executes the engine locally with scripted chief fixtures and
makes no provider calls. `VITE_API_MODE=api` or the Data source selector opts into the backend;
`VITE_API_URL` defaults to `http://localhost:4000`. Do not opt into a Gemini-configured server
for automated verification without approval: reading advice can invoke the provider.

There is one necessary dependency change: `apps/web/package.json` now declares the existing
workspace `@rescuemesh/engine`; the root lockfile has its corresponding one-line entry.
No external package, backend file, engine file, shared contract or root configuration changed.

## Existing HTTP contract

| Endpoint                                | Frontend behavior                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scenario`                     | Reads authoritative state and revision; marks state fresh only after confirmation                                       |
| `GET /api/world-state?since=<revision>` | Polls every 3 seconds; fetches full scenario if a changed response supplies only events                                 |
| `GET /api/recommendations`              | Requires five chief roles, supported Gemini/mock provenance and analyzedRevision                                        |
| `POST /api/commands`                    | Typed shared Command/CommandResponse; validates acknowledgements and requires approved plan status for approval success |

Commands are the agreed flood, bridge closure, connectivity, report submit/sync, plan
propose/approve and reset commands. Approval sends expectedRevision and is disabled while
state is stale, a command is pending, or the API device is offline. The engine rechecks
availability, routes and revisions. Failures remain failures; the UI never silently selects
mock transport because a real request failed.

Scenario/command requests time out after 8 seconds. Advice allows 30 seconds to accommodate
the committed backend's default 20-second Gemini timeout and visible fallback. If Claude
changes that configured budget, align the frontend request timeout accordingly.

## Offline reports and reset

Reports use stable UUID clientReportId values and mode-specific localStorage queues:
`rescuemesh.queue.v1.mock` / `rescuemesh.queue.v1.api`. Reports are written locally before
sending. Known offline reports stay local; queuedOffline acknowledgements also retain them.
Applied/duplicate acknowledgements remove reports; rejected reports remain inspectable.
Lost acknowledgements lead to Sync queue, where retry retains the original ID. Storage
failure preserves editor text. Reconnect completes before selected-zone sync.

Reset requires operator confirmation, resets the engine and removes this mode's device
queue. The engine's committed reset behavior clears its deduplication ledger too; the
frontend does not automatically replay uncertain reset requests. Refresh restores local
mock world state to the seed while preserving unsynchronized reports. Cold offline page
loading and multi-tab queue coordination remain out of scope.

## Short demo checklist

1. Trigger Flash Flood in `zone-oakland`.
2. Close Birmingham Bridge and inspect the closure event.
3. Disconnect the selected East / Swissvale zone.
4. Enter a field report, Queue report, and inspect its stable queued ID.
5. Reconnect Network and confirm the queue empties after acknowledgement.
6. Expand Five chiefs: inspect Gemini provenance, or the explicit scripted fallback.
7. Generate Plan, inspect shortfalls and current advice, then Approve Plan. Confirm
   engine approval, assigned units and events; stale advice is never shown as executed.
8. Reset Simulation and confirm seed state and the empty queue.

The committed backend has five zones. The sidebar renders all five; the existing three
schematic highlighted regions now look up Downtown, Oakland and East by authoritative ID,
not by array position. Map geometry is unchanged. All ten seeded facilities remain present.

## Verification and handoff dependencies

Run `npx prettier --check apps/web`, `npx eslint apps/web`,
`npm run typecheck -w @rescuemesh/web`, `npm test`, and
`npm run build -w @rescuemesh/web` from the worktree root.

At this alignment checkpoint, 110 tests pass across the repository, including 19 frontend
tests: loading/error/success/fallback/stale advice presentation, delayed-response races,
approval acknowledgements, offline queue persistence, reset, and three real local HTTP
integration tests against the committed backend/engine. HTTP tests inject a fake Gemini
transport (success and failure) or a mock-only adapter. They never use paid model calls.
Local sockets require sandbox permission. Lint, TypeScript and the web build also pass.

**Actual live-Gemini verification has not been performed.** Tests showing Gemini provenance
use the backend Gemini adapter with injected model responses. Native desktop interactions
were checked in the earlier implementation; new desktop/mobile screenshot verification is
not claimed. The historical visual QA limitations are retained in `design-qa.md`.

Claude's remaining ownership: remove retained IFM development tooling/types and old ownership
wording from the backend/shared/docs if required by the final architecture. No frontend runtime
imports those clients or accepts IFM chief provenance. No advance-scenario endpoint exists in
the integrated baseline; any future control waits for an explicit deterministic contract.
If direct chief-advice acceptance is desired beyond plan review, Claude must define its typed
command and revision/plan association first. Keep this result reviewable; do not merge into main
automatically.
