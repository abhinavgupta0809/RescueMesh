# RescueMesh command-center frontend

This frontend is isolated on `codex/rescuemesh-frontend`, branched from `6d79ea2`.
It preserves React/Vite and changes only `apps/web`. No dependency, shared schema,
root configuration, or backend changes are required by this frontend branch.

## Run the isolated preview

From the worktree root, run:

```sh
npm ci
npm run dev -w @rescuemesh/web -- --host 127.0.0.1 --port 5174 --strictPort
```

The default is **Local mock**, visibly labeled throughout the UI. The original
checkout's port 5173 and backend port 4000 are not started, stopped or mutated.
Use the Data source selector to opt into **Backend API**, or launch with
`VITE_API_MODE=api`. `VITE_API_URL` defaults to `http://localhost:4000` and may point
at a separate backend instance. Never put secrets in Vite environment variables.

## Complete demo

1. Trigger Flash Flood (synthetic incident in Oakland).
2. Close a Bridge (Birmingham Bridge and its associated modeled route).
3. Disconnect Zone (East End is selected initially; the sidebar changes selection).
4. Add Offline Report, edit the field text, and press Queue report. Inspect Sync queue.
5. Reconnect Network. The selected zone reconnects, then its queued reports synchronize.
6. Generate Plan. Review assignments, the synthetic forecast, unmet needs and the five
   chiefs' provenance. Simulate Alternate Plan regenerates with reversed incident order;
   constrained fixtures can produce the same feasible assignment. It supersedes the
   previous proposal and reserves nothing.
7. Approve Plan. Inspect units under Resource availability and the event log. In the
   baseline demo ZONE4-42 becomes assigned; four units remain available. Unmet needs
   remain explicitly visible rather than claiming full coverage.
8. Reset Simulation, then confirm. Seed state and resources return; this mode's device
   queue is removed. A repeated reset command ID cannot erase later commands.

All ten seeded facilities are rendered and keyboard selectable: exactly three hospitals,
three fire houses, two police hubs and two rescue centers. All quantities are synthetic.
The map is a schematic SVG visualization with layer toggles, numbered incidents,
closed-route labels, zone connectivity and zoom. It uses no map provider or raster UI.
The reference is `/Users/abhinav/Desktop/disaster UI.jpeg`; its static counts are not
substituted for the committed scenario data. Text navigation/markers replace decorative
reference icons to avoid adding dependencies or fabricating live operational features.

## Backend connection contract

`src/api-client.ts` is the only HTTP boundary. Both transports implement
`FrontendClient` from `src/contract.ts`. The latter temporarily extends the committed
shared types with the contract documented in the active checkout on 2026-09-12.
No unfinished backend or shared code was copied into this branch.

Required endpoints:

| Endpoint                                | Expected response                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scenario`                     | Full Scenario including revision, zones, bridges, plans, reports, resources, routes, assignments, recommendations, events |
| `GET /api/world-state?since=<revision>` | revision, upToDate, events, optional full scenario; polled every 3 seconds                                                |
| `GET /api/recommendations`              | `{ items: [{ recommendation, source: { provider, model, degraded, warning? } }] }`                                        |
| `POST /api/commands`                    | Discriminated CommandResponse with matching commandId/type, revision and data or structured error                         |

If a changed polling response supplies only events, the client fetches the full scenario.
Requests time out after 8 seconds. HTTP errors, malformed responses, obsolete scenario
shapes, failed polling and missing recommendation provenance are visibly reported.
The frontend never switches to mock mode because a real request fails.

Commands are `scenario.trigger_flood`, `route.close_bridge`, `zone.set_connectivity`,
`report.submit`, `report.sync`, `plan.propose`, `plan.approve`, `scenario.reset`.
Each has a UUID commandId and ISO issuedAt. Approval includes expectedRevision.
Payload/result definitions are in `src/contract.ts`, matching the inspected contract.
Backend CORS must allow `http://127.0.0.1:5174` (and localhost:5174 if used).
Readiness requires the interactive contract, not merely the older read-only scenario endpoint.

### Offline semantics and temporary mock limits

- The browser queue uses `rescuemesh.queue.v1.mock` and `rescuemesh.queue.v1.api` in
  localStorage, isolating transport modes. UUID clientReportId is retained on retries.
- Reports are written locally before a send; only applied/duplicate acknowledgements
  remove them. Network failures retain the report. Rejected reports remain inspectable
  with rejection reasons. Storage failure leaves the editor text intact and reports an error.
- Reconnection precedes sync. Queued reports from other zones stay local until selected
  and synced. Device network state and zone connectivity are separate labels.
- The mock world and its idempotency cache are session-memory only; reload restores the
  seed while preserving the browser queue. Mock field reports become unverified review
  incidents with **zero modeled people** rather than claiming to parse free text.
- The mock allocator uses seeded capabilities and explicit open/slow routes. It does not
  invent routes or cover impossible needs. It enforces availability, stale-plan checks,
  non-reservation by proposals, and no double assignment on approval.
- The five chief cards retain committed seed recommendations and show mock provenance.
  No remote model or voice service runs in local mock mode.
- No service worker: an already loaded app queues reports offline; a cold offline page
  load is not supported. No multi-tab queue coordination or production dispatch is claimed.
- The reset state exactly matches the frontend seed, revision zero. Its completion is a
  UI status message; a new server event is not added to seed history, consistent with the
  contract's reset-fidelity requirement.

## Integration after Cursor finishes

Do not merge while Cursor is working. After the user confirms Cursor has finished and
committed, merge its committed branch **into this isolated worktree**, resolve overlapping
`apps/web` changes deliberately, and retain both backend and UI behavior. Replace the
temporary compatibility types with committed `packages/shared` exports; reconcile zone
membership/bridge IDs and the real seed. The current UI reads zone/bridge IDs from state.
Launch a separate backend instance, opt into API mode, verify error responses/provenance,
then run the complete demo twice plus duplicate sync/stale approval/reset tests. Leave
the integrated result on a reviewable branch; never overwrite or force-push either branch.

## Validation

```sh
npx prettier --check apps/web
npx eslint apps/web
npm run typecheck -w @rescuemesh/web
npm test
npm run build -w @rescuemesh/web
```

Frontend tests cover the full command sequence, facility/resource invariants, duplicate
commands and reports, reset fidelity, stale plans, reserve constraints, failure responses,
polling refresh, malformed responses, persistent IDs and mode-isolated storage.
The repository's API tests need permission to bind temporary local sockets.
Visual/browser evidence and remaining limitations are recorded in `design-qa.md`.
