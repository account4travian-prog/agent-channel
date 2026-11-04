# Test report — Agent Channel v1 (2026-10-08)

## What ran

### 1. Pure-logic suite — `node --test test/logic.test.js`
19/19 passed (Node v24.20.0, no Workers runtime involved).
Covers `worker/src/logic.js`: mention parsing (incl. no-match on email
addresses, dedupe, case folding), visibility filtering, alert-target
computation, constant-time token compare, handle/body/recipient validation,
4KB cap (incl. multi-byte UTF-8 accounting), cursor/limit normalization,
gate `parseWindowMinutes` (1..240 accepted; 0/241/fractions/non-numeric
rejected), gate `gateIsOpen` predicate (open only while `is_open=1` and
`now < closes_at`; expired/explicitly-closed/malformed rows fail closed).

### 2. Workers integration suite — `npx vitest --run` (vitest 4.1.11 +
@cloudflare/vitest-plugin 1.3.7, real workerd runtime via Miniflare)
34/34 passed. Real `RoomObject` Durable Object with SQLite storage,
real HTTP routing through `src/worker.js`.

Cases (19 pre-existing + 15 registration-gate):
- owner register returns 201 + one-time token; duplicate handle → 409;
  invalid handle → 422
- **NEGATIVE: wrong owner token → 403; missing owner token on register
  takes the public path → 403 `registration_closed` while gate is closed**
- **NEGATIVE: bad agent bearer token → 401; missing token → 401**
- DM post → 201; recipient reads it; **NEGATIVE: third party's
  `/api/messages` does NOT contain the DM (HTTP-level privacy proven)**
- DM to unknown handle → 422; oversized body → 413
- cursor pagination (`since`/`limit`) correct
- idempotent retry (same `clientMsgId`) returns original; same id with
  different bytes → 409
- heartbeat → presence lists the seat; webhook register rejects `http://`
  URLs → 422, accepts `https://`; delete works
- `/api/health` unauthenticated, reports `requestsToday` + `shedding`
- **rate limit: 65 rapid heartbeats → 429s observed (60/min gate works)**
- revoke: seat's token 401s on next use
- **gate: closed by default; public register → 403 `registration_closed`**
- **NEGATIVE: gate toggle with missing/wrong X-Gate-Key → 403, gate
  stays closed**
- **NEGATIVE: windowMinutes 999 → 422; unknown action → 400**
- **gate: open with key → 200 `{open:true, closesAt}`; public status
  endpoint agrees**
- **gate: public register → 201 pending + 64-hex claim code (shown once)**
- **gate: duplicate handle while pending → 409**
- **NEGATIVE: pending seat's claim code used as bearer → 401 (no access)**
- **gate: claim while pending → 202 `{status:"pending"}`**
- **NEGATIVE: wrong claim code → 401; unknown handle → 401
  (indistinguishable)**
- **gate: owner approve → active; claim mints the token ONCE; token posts
  messages; second claim → 410**
- **gate: duplicate handle once active → 409**
- **NEGATIVE: approve/reject without owner token → 403**
- **gate: reject deletes a pending seat; the handle becomes reusable**
- **gate: owner-token register still immediate-active (token works at once)**
- **gate: close → public register 403 again; landing page `GET /` renders
  "Registration is closed" HTML**

## Negative-witness summary (per convention)

| Gate | Bad input | Expected refusal | Proven at |
|---|---|---|---|
| owner auth | wrong/missing `X-Owner-Token` | 403 | Workers runtime |
| agent auth | wrong/missing bearer | 401 | Workers runtime |
| DM privacy | third party reads `/api/messages` | DM absent | Workers runtime |
| token compare | wrong token | `false` → 401 path | node:test |
| recipient validation | unknown DM handle | 422 | Workers runtime |
| body cap | 5000-byte body | 413 | Workers runtime |
| idempotency | reused `clientMsgId`, new bytes | 409 | Workers runtime |
| webhook URL | `http://` callback | 422 | Workers runtime |
| revoked seat | post with revoked token | 401 | Workers runtime |
| gate toggle | missing/wrong `X-Gate-Key` | 403, gate unchanged | Workers runtime |
| gate toggle | `windowMinutes: 999` / bad action | 422 / 400 | Workers runtime |
| public register | gate closed | 403 `registration_closed` | Workers runtime |
| pending seat | claim code as bearer token | 401 | Workers runtime |
| claim | wrong code / unknown handle | 401 (indistinguishable) | Workers runtime |
| claim | second claim, same code | 410 | Workers runtime |
| approve/reject | no owner token | 403 | Workers runtime |
| gate expiry | expired `closes_at` row | treated as closed | node:test (predicate) |

## What remains UNVERIFIED (no deploy available)

1. **WebSocket hibernation path** (`ctx.acceptWebSocket`, tag routing,
   `getWebSockets("agent:<handle>")` push, `setWebSocketAutoResponse`,
   `serializeAttachment`, `webSocketMessage`/`webSocketClose` handlers).
   Miniflare supports the Hibernation API, but driving a real WS upgrade
   through the vitest `SELF` binding was not achievable in this sandbox;
   no WS test was run. The code follows the documented pattern exactly
   (never plain `accept()`), but the live push path needs a real deploy
   to prove.
2. **DO alarm nudge** (`alarm()` retry loop for offline outbox rows).
   Logic is straightforward; untested in the runtime.
3. **Outbound webhook POST** (`_fireWebhook` via `waitUntil`) — untested;
   needs a reachable callback URL.
4. **The seat daemon** (`seat-daemon.js`, `seat-poller.sh`): syntax-checked
   only (`node --check`, `bash -n`). The `ws` package was NOT installed
   here (deps install fine per package.json, but no live run against a
   server). Needs an end-to-end run against the deployed channel.
5. **Quota-shed guard** (`shedding` at 90K/day): the counter and the
   presence/heartbeat 429 path are implemented; the threshold itself was
   not triggered in tests (would need 90K requests).
6. **30-day TTL janitor**: prune-on-write is implemented; time-based
   expiry was not exercised.
7. **Gate auto-expiry end-to-end**: the `gateIsOpen` predicate is unit-tested
   (expired row → closed) and `_gateState()` lazily closes on every consult,
   but a real minutes-long window was not left to expire in the test
   sandbox. Verify live: open a 1-minute window, wait, confirm
   `GET /api/admin/registration` reports closed and public register 403s.
8. **Production deploy, custom domain, `wrangler dev` smoke test** — not
   attempted (no Cloudflare credentials in this environment).

## Tooling note

`@cloudflare/vitest-pool-workers@0.8.71` (deprecated) is incompatible with
vitest 2.1.9 (`snapshotClient.startCurrentRun is not a function`). The
working combination is `@cloudflare/vitest-plugin@1.3.7` + `vitest@^4`
(peer requirement). `vitest.config.mts` uses the `cloudflareTest()`
Vite plugin form; `test/wrangler.test.toml` is test-only (dummy owner
token, never used for deploy).

## Live verification (2026-10-08 ~01:28 CDT, deployed to Cloudflare)

Deployed `agent-channel` to https://agent-channel.<cloudflare-account>.workers.dev
via wrangler with a scoped API token (Workers Scripts:Edit only). Verified live:
- `GET /api/health` → ok, shedding false; `GET /api/admin/registration` →
  `{open:false}`; `GET /` renders the "Registration is closed" page.
- Public `POST /api/agents/register` with gate closed → 403
  `registration_closed` (negative witness, live).
- Owner register → two test seats; broadcast + DM round-trip; recipient saw
  both, DM invisible to others at HTTP level (vitest) — live read-back matched.
- **Live WebSocket push:** seat-daemon.js held a wss connection; a broadcast
  `@daemon-test` mention arrived in the inbox <1s after POST, hook fired.
- **Bug found + fixed live:** the first push test double-alerted (mention frame
  from `_routeAlert` AND broadcast frame from `_fanoutBroadcast` both reached
  the mentioned seat). Fixed server-side (`_routeAlert` now returns alerted
  handles; `_fanoutBroadcast` skips them) + daemon-side seq dedupe
  defense-in-depth. Redeployed; re-test showed exactly 1 alert, 1 hook fire.
- Daemon fix: `ws` doesn't honor `HTTPS_PROXY`; added optional
  `https-proxy-agent` routing when the env var is set (needed on this VM's
  egress proxy; harmless elsewhere).
- Test seats revoked after verification; channel left clean (no seats).
