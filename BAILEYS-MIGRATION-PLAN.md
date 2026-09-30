# Migrating WhatsApp from `whatsapp-web.js` to Baileys

**Status:** planned, not started
**Branch:** `feat/baileys-migration`
**Drafted:** 2026-09-30, immediately after the 32-day outage
**Goal:** remove Chromium from the production image entirely, so that a WhatsApp fault
can never again consume the box the prayer wall runs on.

---

## 1. Why we are doing this

`tribeprayer.org` was down from **2026-08-29 to 2026-09-30 (32 days)**. The proximate
cause was a Chromium relaunch leak; the root cause is structural and will keep
producing outages for as long as we drive WhatsApp through a browser:

| Failure | Date | Mechanism |
|---|---|---|
| Disk full, NIC loses its IP | 2026-06-05 (39 days) | Runaway Chromium filled the boot disk |
| Swap exhaustion, 504s | 2026-08-07 (~4 h) | 5 s Chromium relaunch loop leaked browsers |
| Swap exhaustion, total wedge | 2026-08-29 (32 days) | Same leak; the fix existed but was never deployed |

The common factor is that **one healthy Chromium is 0.9-1.4 GB on a 1.98 GB box.**
Every mitigation so far — swap, `mem_limit`, `init: true`, backoff ladders, orphan
teardown — is hardening around a process that should not be there. There is no headroom
to leak into, so any defect in browser lifecycle management becomes a site-wide outage.

Baileys speaks WhatsApp's binary WebSocket protocol directly. Its entire dependency set
is `ws`, `libsignal`, `protobufjs`, `pino` and a WASM helper. No browser, no profile
locks, no zombie reaping, no `shm_size`, no 35 Chromium system libraries in the image.
Expected steady-state memory drops from ~1.4 GB to well under 300 MB.

### Options considered and rejected

**wppconnect** — rejected. Its `package.json` depends on `puppeteer: ^24.43.1`,
`puppeteer-extra`, `puppeteer-extra-plugin-stealth` and `chrome-launcher`. It is the
same headless-Chromium architecture as `whatsapp-web.js` and preserves every failure
mode above. Its better release cadence and `@wppconnect/wa-version` tracking are real
advantages, but they address delivery breakage, not memory. Porting to it would be a
side-grade at full migration cost.

**WhatsApp Business Cloud API** — rejected as infeasible here. Meta's Groups API
documentation states **"Max group participants: 8"**, requires an Official Business
Account, and only supports groups the business number itself creates, with members
joining through generated invite links. It cannot post into the existing prayer group.
This option was initially recommended in conversation and then withdrawn once the
limits were checked.

**Staying on `whatsapp-web.js`** — rejected. The latest npm release is 1.34.7 (April
2026). Five months have passed with no release while WhatsApp Web changed underneath,
which is why sends have been failing since roughly 2026-07-14.

---

## 2. Current architecture

```
server.ts  ->  src/lib/whatsapp.ts  (singleton `whatsappService`)
                     |
                     +-- whatsapp-web.js Client
                     |      +-- Puppeteer -> Chromium (0.9-1.4 GB)
                     |             +-- /app/.wwebjs_auth  (LocalAuth session)
                     |
              consumed by 6 routes (see section 3)
```

Infrastructure facts as they stand today:

- `Dockerfile` installs ~35 Chromium system libraries, plus a start script that sweeps
  `Singleton*` / `Lockfile` Chromium locks on boot.
- `docker-compose.prod.yml` sets `shm_size: 1gb`, `mem_limit: 1600m`,
  `memswap_limit: 1600m`, `init: true`, and mounts
  `/var/intercessor/data/wwebjs_auth` to `/app/.wwebjs_auth`.
- Group IDs live in the SQLite `app_settings` table under keys `whatsapp_group_ids`
  and `whatsapp_test_group_id`, in `<number>-<number>@g.us` form.
- Session-loss alerting depends on the app emitting a log line containing the literal
  token `wa_session_lost`, matched by a Cloud Logging log-based metric feeding alert
  policy `4344627323952717444`.

---

## 3. The contract we must preserve

`src/lib/whatsapp.ts` is already a clean facade. Six consumers import `whatsappService`
and touch only this surface:

| Member | Used by |
|---|---|
| `latestQR: string \| null` | `api/admin/qr`, `api/health/whatsapp` |
| `isConnected(): boolean` | `api/admin/qr`, `api/health/whatsapp` |
| `initialize({ force }): Promise<void>` | `api/admin/whatsapp/reconnect`, `server.ts` |
| `getStatus(): WhatsAppStatus` | `api/admin/whatsapp/reconnect` |
| `sendMessage(chatId, message): Promise<boolean>` | `api/submit`, `api/admin/prayers/resend` |
| `logout(): Promise<boolean>` | `api/admin/logout` |

**This is the central design decision of the migration: keep the facade byte-identical
and swap only what sits behind it.** Consequences:

- Zero changes to the six consuming routes.
- Zero changes to the admin page's data contract.
- Rollback is a single `git revert` plus a redeploy.
- The blast radius of the migration is one file plus infrastructure.

`public client: Client` is the one member that leaks the implementation outward. It must
be removed or narrowed, since `Client` is a `whatsapp-web.js` type.

---

## 4. Target architecture

```
server.ts  ->  src/lib/whatsapp.ts  (same singleton, same public surface)
                     |
                     +-- Baileys socket (makeWASocket)
                     |      +-- WebSocket -> WhatsApp  (<300 MB total process)
                     |             +-- /app/.baileys_auth  (useMultiFileAuthState)
                     |
              consumed by the same 6 routes, unchanged
```

Key API mappings, verified against the Baileys README and documentation:

| Concern | `whatsapp-web.js` | Baileys |
|---|---|---|
| Create client | `new Client({ authStrategy: LocalAuth })` | `makeWASocket({ auth: state })` |
| Auth persistence | `LocalAuth` directory | `useMultiFileAuthState(dir)` plus `sock.ev.on('creds.update', saveCreds)` |
| QR | `client.on('qr', ...)` | `connection.update` event, `qr` field |
| Connected | `client.on('ready')` | `connection.update` with `connection === 'open'` |
| Disconnected | `client.on('disconnected', reason)` | `connection.update` with `connection === 'close'`; reason via `(lastDisconnect.error as Boom)?.output?.statusCode` |
| Logged out vs transient | string matching on the reason | `DisconnectReason.loggedOut` |
| Send to group | `client.sendMessage(id, text)` | `sock.sendMessage('...@g.us', { text })` |
| Delivery signal | `message_ack` plus `MsgKey._serialized` (**broken since July**) | `messages.update` with `status` reaching `SERVER_ACK`; groups additionally emit per-participant `message-receipt.update` |
| Teardown | `client.destroy()` (kills a browser) | `sock.end()` / `sock.logout()` — no process to kill |

**Group JID format is identical** (`<number>-<number>@g.us`), so the group IDs already
stored in `app_settings` carry over with no data migration.

### What gets deleted

- `whatsapp-web.js` (and any `puppeteer`) from `package.json`
- ~35 Chromium apt packages from the `Dockerfile`
- The Chromium lock-sweep block in the container start script
- `shm_size: 1gb` from `docker-compose.prod.yml`
- Every piece of browser-lifecycle defence that exists only because Chromium exists:
  `discardBrowser()`, `destroyClient()`, `browserWatch` / `disarmBrowserWatch()`,
  `clearStaleLock()`, `withTeardownTimeout()`, and the `initInFlight` /
  `isInitializing` double-latch whose only purpose was preventing a second browser
  launch against the same profile

The backoff ladder should be **kept** in spirit — a reconnect storm against WhatsApp's
servers is still undesirable — but it no longer guards against memory exhaustion, so it
can be simpler.

---

## 5. Risks and how each is handled

| # | Risk | Handling |
|---|---|---|
| R1 | **Baileys may not deliver to the group either.** Sends have been broken since July and the cause could be account-side rather than library-side. | **Story 1 is a throwaway spike** proving delivery to the real group, confirmed on a physical phone, before any refactor begins. If it fails we stop, having spent an hour rather than a week. |
| R2 | **Version choice.** npm `latest` is `7.0.0-rc14`, a release candidate; `legacy` is `6.7.24`. Both were published 2026-07-29. | **Resolved 2026-09-30: use `7.0.0-rc14`.** It opened a live socket and issued a QR on the first try, and `fetchLatestBaileysVersion()` reports `isLatest: true`, so it tracks the current protocol. It is also what the `latest` dist-tag points at; `6.7.24` is tagged `legacy`. Being an RC remains a live risk — revisit if pairing or delivery misbehaves. |
| R3 | **Re-pairing is mandatory.** The `wwebjs_auth` session is meaningless to Baileys. | Accepted and desired; the requested end state is "scan the QR once". The old volume is deliberately left on disk so a rollback can still find it. |
| R4 | **Alert regression.** The `wa_session_lost` log-based metric matches a literal string. | Story 4 keeps the emitted string identical and verifies with a synthetic log entry, per the established runbook. |
| R5 | **Ack semantics differ.** Group delivery is reported per participant. | **This row was WRONG and is corrected — see section 7b.** It said to treat exact-key `SERVER_ACK` on `messages.update` as the acceptance signal. For a **group** that event never carries a status, so implemented literally every send would have reported failure forever: the exact shape of the July bug. The real signal is WhatsApp's own `<ack class="message">` stanza. |
| R6 | **Baileys is unofficial**; protocol drift and ban risk remain. | Unchanged from today's exposure — `whatsapp-web.js` is equally unofficial. Not a regression. |
| R7 | **Native dependency in the image.** Baileys 7.x pulls `whatsapp-rust-bridge`. | **Resolved 2026-09-30:** a clean `npm install` pulled 70 packages with 0 vulnerabilities and no Rust toolchain. Note npm 11 defers `preinstall`/`postinstall` scripts (`engine-requirements.js`, protobufjs postinstall); the Docker image runs npm 10 where they execute normally. Confirm in S5 that the image build runs them. |
| R8 | **Never trust the library's own success signal.** The July bug reported failure while sending nothing, and an earlier analysis wrongly concluded sends were working. | Every delivery claim in this migration must be confirmed on a real phone. |

---

## 6. Acceptance criteria for the migration as a whole

1. No `chromium`/`chrome` process exists in the running container.
2. Container steady-state RSS is **under 300 MB** (baseline ~1.4 GB).
3. `mem_limit` reduced from `1600m`; `shm_size` removed entirely.
4. Production image is measurably smaller with the Chromium libraries gone.
5. `/admin` shows a scannable QR, and scanning it reaches the connected state.
6. A prayer submitted through the site arrives in the real group, **confirmed on a phone**.
7. `whatsappSent` is set only on a real `SERVER_ACK`, never optimistically.
8. Session-loss alerting still fires, verified with a synthetic log entry.
9. `/api/health` and `/api/health/whatsapp` behave exactly as before.
10. The six consuming routes are unmodified.
11. Full suite green, with real unit tests for the WhatsApp service.

---

## 7. User stories

Stories 2 to 5 run through `/feature-pipeline` (planner, coder, tester, reviewer).
Stories 1 and 6 are operator tasks — exploratory and production-touching respectively,
neither suited to an autonomous coding pipeline.

---

### S1 — Spike: prove Baileys can deliver to the prayer group
*Operator task. Throwaway code, never merged.*

> As the maintainer, I want proof that Baileys actually delivers a message to our real
> group before I rewrite anything, so a failed migration costs an hour instead of a week.

**Acceptance criteria**

- A standalone script outside `src/` pairs a Baileys socket by QR.
- It sends one clearly marked test message to the **test** group from `app_settings`.
- Delivery is **confirmed on a physical phone** — never inferred from a return value.
- The `messages.update` status progression is logged, establishing which status value
  to treat as durable acceptance.
- Both `7.0.0-rc14` and `6.7.24` are tried if the first fails; the working version is
  recorded in section 5, R2 of this document.
- Peak RSS of the spike process is recorded, for comparison against the ~1.4 GB baseline.
- `npm ci` in a clean container confirms `whatsapp-rust-bridge` needs no Rust toolchain (R7).

**Done when:** a human has seen the message on their phone, and the chosen version is
written into this file.

---

### S1 results (recorded 2026-09-30)

The non-pairing half of this spike ran and passed. The delivery half is deferred to S6
so that the single QR scan happens on the deployed app, as requested, rather than
burning a linked-device slot on a throwaway script.

| Check | Result |
|---|---|
| Install without a Rust toolchain | Pass — 70 packages, 0 vulnerabilities |
| `makeWASocket`, `DisconnectReason`, `useMultiFileAuthState` exported | Pass |
| WhatsApp Web version negotiated | `[2,3000,1043857760]`, `isLatest: true` |
| Live socket to WhatsApp | Pass |
| QR issued | Pass — 277 chars, `https://wa.me/settings/linked_de...` |
| RSS after import | 80.5 MB |
| **Peak RSS with an open socket** | **102.4 MB** (vs ~1.4 GB for Chromium, ~14x less) |

Two findings that affect implementation:

1. **Baileys 7 requires an explicit `logger`.** Passing `undefined` throws
   `TypeError: Cannot read properties of undefined (reading 'child')` inside
   `makeNoiseHandler`. Pass a real `pino` instance; use level `silent` so Baileys'
   very chatty debug output never reaches the container log (which ships to Cloud
   Logging and is billed).
2. **The QR payload is now a URL**, not the opaque token `whatsapp-web.js` produced.
   `qrcode.react` renders any string, so the admin page needs no change — but any test
   asserting on QR shape must not assume the old format.

**Carried into S3 as an open question:** the spike never paired, so the exact
`messages.update` status value for durable acceptance is still unverified against a
real group. S3 must treat this as its one open question and confirm it at S6.

---

### S2 — Connection and pairing lifecycle on Baileys
*Pipeline story.*

> As an admin, I want to open `/admin`, scan a QR code, and have the app stay paired
> across restarts, so I can bring WhatsApp online without touching the server.

**Scope:** `src/lib/whatsapp.ts` — connection, QR, auth persistence, reconnect, logout.
Sending is explicitly **out of scope** and stays stubbed until S3.

**Acceptance criteria**

- `initialize({ force })` opens a Baileys socket using `useMultiFileAuthState` rooted at
  a configurable path (default `/app/.baileys_auth`, overridable by env var).
- `creds.update` is persisted, so a container restart resumes without a new scan.
- `connection.update.qr` populates `latestQR`; it is cleared on `open` and on logout.
- `isConnected()` returns true only when `connection === 'open'`.
- A `close` that is **not** `DisconnectReason.loggedOut` reconnects automatically under
  a backoff ladder.
- A `close` that **is** `loggedOut` clears credentials, does not auto-reconnect, and
  leaves the service re-armable through `initialize({ force: true })`.
- `logout()` ends the session, wipes the auth directory, and still distinguishes an
  intentional admin logout from an involuntary one (preserving `intentionalLogout`).
- `getStatus()` returns the same `WhatsAppStatus` shape as today.
- All Chromium-only machinery listed in section 4 is deleted outright, not left dead.

---

### S3 — Sending and delivery confirmation
*Pipeline story.*

> As someone submitting a prayer request, I want my request to actually reach the
> WhatsApp group, and I want the app to record it as sent only if it truly was.

**Scope:** `sendMessage()` and ack tracking in `src/lib/whatsapp.ts`.

**Acceptance criteria**

- `sendMessage(chatId, message)` keeps its exact signature and `Promise<boolean>` return.
- It sends through `sock.sendMessage(jid, { text })` and captures the returned message key.
- It resolves `true` only once WhatsApp acknowledges that exact message id — see
  section 7b for which event that actually is — and `false` on a rejection or timeout.
- The ack wait is bounded by a timeout, and a disconnect mid-send settles all waiters
  rather than leaking them, preserving today's `settleAllPendingAcks` behaviour.
- Sending while disconnected returns `false` and triggers a bounded re-arm, never a
  relaunch storm.
- `whatsappSent` in the database is set **only** on a `true` return.
- Nothing anywhere relies on `_serialized`, the field whose disappearance caused the
  July breakage.

---

### S4 — Observability parity
*Pipeline story.*

> As the operator, I want the alerts that already exist to keep working after the
> migration, so I do not silently lose the detectors built across three outages.

**Acceptance criteria**

- The involuntary-session-loss path still emits a log line containing the exact token
  `wa_session_lost`, in the same JSON shape the log-based metric matches.
- Admin-initiated logout still suppresses that alert.
- `/api/health` is unchanged; `/api/health/whatsapp` still returns 200 when connected
  and 503 when not, with the same `needsScan` semantics.
- A socket death that is not a clean logout is observable — the Baileys equivalent of
  the `pupBrowser` disconnect watcher — so a dead session cannot present as healthy.
- The Docker healthcheck still targets `/api/health`, and its `start_period` is reduced,
  since Baileys connects in seconds rather than the 60-90 s a browser needed.

---

### S5 — Strip Chromium from the image and right-size the container
*Pipeline story.*

> As the operator, I want the deployed image to contain no browser at all, so the class
> of failure that caused three outages cannot recur.

**Acceptance criteria**

- `whatsapp-web.js` (and any `puppeteer`) removed from `package.json`;
  `@whiskeysockets/baileys` added at the version chosen in S1.
- All Chromium system libraries removed from the `Dockerfile`.
- The Chromium lock-sweep removed from the start script.
- `shm_size` removed from `docker-compose.prod.yml`.
- `mem_limit` / `memswap_limit` reduced to a value justified by the S1 measurement, with
  the reasoning recorded in a comment as the current file does.
- A new volume `/var/intercessor/data/baileys_auth` to `/app/.baileys_auth` is mounted;
  the old `wwebjs_auth` mount is removed but the host directory is left on disk.
- `init: true` is retained — cheap, and correct for any child process.
- The image builds and the suite passes with no `whatsapp-web.js` import anywhere.

---

### S6 — Deploy and pair in production
*Operator task.*

> As the maintainer, I want to arrive at a deployed app where the only thing left to do
> is scan a QR code on the admin page.

**Acceptance criteria**

- Merged to `master`; Cloud Build succeeds; the **running image digest matches `:latest`**
  (the deploy-race check that has bitten this project before).
- `docker inspect` confirms the new memory limits and the absence of `shm_size`.
- No Chromium process in the container.
- `/admin` presents a scannable QR.
- After the scan: `isConnected()` true and `/api/health/whatsapp` returns 200.
- A real prayer submission is delivered to the group and **confirmed on a phone**.
- Steady-state container RSS recorded and compared against the ~1.4 GB baseline.
- Memory files updated with the new architecture and the retired failure mode.

---

## 7a. Progress and revisions (updated 2026-09-30)

| Story | State |
|---|---|
| S1 spike | Done. Results in section 7. |
| S2 connection lifecycle | **Done** — `feat/baileys-migration`, commits `6cf708c`, `67c342b`, `71b9f83`. 243 tests green. |
| S3 send + delivery | Next. |
| S4 observability parity | **Folded into S5** — see below. |
| S5 image slimming | Pending, scope grown. |
| S6 deploy + pair | Pending. |

### S2 outcome

Ran the full pipeline: planner, coder, tester, reviewer. The tester ran 54 single-change
mutations and every one turned a test red; it found one genuine defect (a logout racing an
in-flight `initialize()` leaving an orphaned socket) and left it red rather than patching it.
The reviewer returned NEEDS WORK with four findings, all since fixed. Two of those findings
were themselves unpinned by any test, and both are now covered by tests with red controls.

The lead — not the coder stage — wrote the D1 fix and the four review fixes, so that work
has had less independent review than the rest. Noted here deliberately.

### S4 is folded into S5

S2 turned out to satisfy most of S4 already: the `wa_session_lost` token and its JSON shape
are byte-identical to master, `intentionalLogout` suppression survives, the health routes
were never touched, and the connect watchdog is the Baileys equivalent of the old
`pupBrowser` death-watcher. What remained was a one-line Docker `start_period` reduction,
which belongs with the S5 compose work, plus a synthetic alert test, which is an operator
check at S6. Running a four-stage pipeline for one line of YAML would be ceremony.

### Corrections to earlier text in this document

- **Section 7, S2 AC** said "a `close` that is not `DisconnectReason.loggedOut` reconnects
  automatically". That is not what shipped, and what shipped is better: `440`
  (`connectionReplaced`) stands down, and a close on an *unpaired* socket stands down
  quietly rather than reconnecting. Both are reasoned in the spec.
- **`wa_cleanup_failed` needed no monitoring cleanup.** The review flagged a possible
  orphaned log-based metric. Verified against the API: the project has exactly **one**
  log-based metric, `wa_session_lost`, and four alert policies, none referencing
  `wa_cleanup_failed`. Nothing to delete.

### New constraint: S2 must not reach `master` on its own

`.github/workflows/build.yml` triggers on every push to `master`. It is a **dead AWS/EC2
deploy path** left over from before the GCE migration — it has failed on all seven of its
most recent runs — but the real deploy (`cloudbuild.yaml`, the `prayer-wall-main-push`
trigger) also fires on `master`, and it deploys `docker-compose.prod.yml`, which still
mounts `wwebjs_auth` and never sets `WA_AUTH_PATH`. Merging S2 alone would therefore ship a
build that writes credentials to an ephemeral in-container directory and loses the session
on every restart, while `sendMessage()` still returns `false` unconditionally.

**S3 and S5 land in the same merge as S2.** Nothing in the repo enforces this; it is a
decision recorded here.

### Scope added to S5

1. **Delete `.github/workflows/build.yml`.** It fails on every push (noise), and if the AWS
   credentials were ever restored it would deploy this app to a stale EC2 box.
2. Add `.baileys_auth` to `.gitignore` (only `.wwebjs_auth` is listed).
3. Reduce the healthcheck `start_period` from 180 s — Baileys connects in seconds.
4. Include the new auth directory in whatever disk check came out of the 2026-07-14
   hardening. `useMultiFileAuthState` writes one small JSON file per key and S2 prunes them
   only on logout or session loss. Not a threat for a send-only bot, but this box has twice
   died of a full disk and this is a new directory that only grows.
5. If any dashboard or notification template reads the alert `reason` field, update it:
   `browser_disconnected` and `auth_failure: <msg>` are replaced by `401`/`403`/`411`,
   `connection_replaced` and `connect_watchdog`. The `wa_session_lost` token itself is
   unchanged, so alert policy `4344627323952717444` keeps firing either way.

### Two checks that only the real image can answer (for S5/S6)

- **The dynamic `import()` is unverifiable by the test suite, by construction.** Under
  `ts-jest`'s CommonJS transform `await import()` compiles to `require()` — which is why the
  Jest mock intercepts it at all — whereas under `tsx` it must stay a real dynamic import
  for the fix to work. The two mechanisms are opposites, so the single change that decides
  whether the server boots is exercised by zero tests. It was verified by hand on Node
  24.18.0; production is `node:20-bookworm-slim`. **Build the real image and boot it**,
  confirming both `> Ready on http://` and `[WA:qr] New QR code received` appear, and that
  `/api/health/whatsapp` answers. Fold this into the R7 npm-scripts check.
- **QR scannability.** Baileys' QR is a ~277-char URL against `whatsapp-web.js`'s ~239-char
  token — roughly QR version 14, about 2.7 px per module at the admin page's `size={200}`.
  It should scan, and the old one did at the same size, but this project has already shipped
  an unscannable code once. Confirm on a phone at the real size; bump `size` if it fights.

### Known, accepted, not fixed

Post-`open` liveness now depends on Baileys noticing a dead socket rather than on our own
watcher. Verified that it does: `baileys/lib/Socket/socket.js` ends the socket with
`DisconnectReason.connectionLost` after `keepAliveIntervalMs + 5000` of silence and emits
`connection.update` before removing listeners, so with `keepAliveIntervalMs: 30_000` a dead
open socket surfaces as a transient close within ~35 s. Real, but it is trust moved from our
code into a release candidate's.

---

## 7b. Correction: the acceptance signal for a group send (2026-09-30)

**Section 5 R5 was wrong, and it was wrong in the most expensive possible direction.** It
instructed S3 to confirm a send by waiting for `messages.update` to report
`status >= SERVER_ACK` for the message id. Verified against the installed
`@whiskeysockets/baileys@7.0.0-rc14` source, that event **never carries a status for a
group**:

`lib/Socket/messages-recv.js:1186` — inside `handleReceipt`:

```js
if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
    if (attrs.participant) { ev.emit('message-receipt.update', ...); }
} else {
    ev.emit('messages.update', ids.map(id => ({ key: {...}, update: { status, ... } })));
}
```

Group receipts are routed to `message-receipt.update`, per participant. The
`messages.update`-with-status emit is the `else` branch — **direct chats only**. The single
exception is `handleBadAck` (`:1558`), which emits `status: ERROR`. So for the prayer
group's `...@g.us` target, `messages.update` can only ever tell us a send **failed**.

Had this shipped as written, every prayer would have been recorded as unsent while
messages actually arrived — an outcome almost indistinguishable from the July 2026 bug this
migration exists to escape, and one that an earlier analysis of that bug already got wrong
once in the opposite direction.

**The correct signal, for groups and direct chats alike, is WhatsApp's own
`<ack class="message" id="...">` stanza**, observed on the socket's raw frame emitter as
`sock.ws.on('CB:ack,class:message')`. This is a supported surface, not a private poke:
`sock.ws` is a public member of `WASocket`, Baileys dispatches `CB:<tag>,<attr>:<value>`
for every inbound binary node, and Baileys itself subscribes to this exact event
(`lib/Socket/messages-recv.js:1624`) and synthesises `{ fromMe: true, id: attrs.id }` from
it — it only inspects the *failure* case, which is why the success case is ours to observe.

S3 therefore accepts two positive signals, both matched on the exact message id, and two
negative ones:

| Signal | Source | Fires for | Meaning |
|---|---|---|---|
| `CB:ack,class:message`, no `error` attr | `sock.ws` | groups **and** direct | accepted |
| `messages.update`, `status >= 2` | `sock.ev` | direct only | accepted |
| `CB:ack,class:message` **with** `error` | `sock.ws` | groups and direct | rejected |
| `messages.update`, `status === 0` | `sock.ev` | any | rejected |

Everything else — timeout, disconnect, logout, shutdown, a missing message id, a socket
swapped mid-send — resolves `false`. **Nothing resolves `true` merely because no error was
thrown.** `sock.sendMessage()` resolving proves only that the stanza reached the TCP
socket, which is precisely the class of signal R8 forbids trusting.

### A second trap, verified at runtime

`{"ERROR":0,"PENDING":1,"SERVER_ACK":2,"DELIVERY_ACK":3,"READ":4,"PLAYED":5}`

**`ERROR` is `0`, not `-1`.** whatsapp-web.js used `-1`, so the old code could get away
with truthiness checks. Here `if (!status)` would silently swallow the one value that means
"WhatsApp rejected this message". Status comparisons must be explicit.

### What remains unverified until the QR is scanned

Baileys only ever inspects the *failure* case of the ack stanza, so its source proves the
event exists and concerns our outbound messages, but not that WhatsApp emits it on success
for a group. That cannot be settled without a paired session. S3 implements the server ack
as the primary accept signal; **S6 confirms it** by looking for
`[WA:send] Acknowledged id=... (server ack).` in the container log, then the message on a
physical phone, then `whatsappSent = true` on the row.

If no server ack appears while the phone shows the message, the send worked and only the
signal is missing. The contingency, in order: add `message-receipt.update` as a third
accept signal (one listener, matched on `key.id`, any participant); or raise
`WA_ACK_TIMEOUT_MS` if receipts are merely slow. **Never** fall back to "resolved without
throwing" — that is the July bug, and acceptance criterion 7 forbids it.

---

## 7c. S3 and S5 outcomes, and the boot verification (2026-09-30)

| Story | State |
|---|---|
| S1 spike | Done |
| S2 connection lifecycle | Done, reviewed, four findings fixed |
| S3 send + delivery | **Done. Review verdict SHIP**, no defect in the code; two of seven deployment risks fixed |
| S4 | Folded into S5 |
| S5 image slimming | **Done**, plus the deploy-pipeline fix below |
| S6 deploy + pair | Next - this is the QR scan |

### S3 outcome

380 tests pass. The tester wrote 136 new tests covering all 16 spec edge cases and ran 60
mutations, 59 of which turned the suite red; the single survivor came with a correct
equivalence proof rather than an excuse. The reviewer verified the group-ack premise against
the library itself rather than trusting the handoffs, and returned SHIP.

Two review risks were fixed in commit `104e1d2`:

- **nginx had no `proxy_read_timeout`**, so its 60s default applied, not the 62s the code
  comment assumed - that number came from a 504 latency observed during the 2026-08-07
  outage, not from anything configured. Verified against production: `whatsapp_group_ids`
  holds exactly **one** group and the VM env file sets no `WA_ACK_TIMEOUT_MS`, so today's
  worst case is 30s and fits comfortably. The fix is about the cliff, not the present: two
  groups would be 60s, three would always fail, and nothing caps the count. Now 90s.
- **A negative env timeout was truthy**, surviving the `|| DEFAULT` and yielding a timer that
  fires immediately - every send reporting a timeout while messages arrived fine, which is
  the July shape, reachable from one typo. Both timeouts are now floored at 1s.

One test of mine had to be rewritten because it could not fail: a `mockResolvedValue` relay
wins the `Promise.race` as a microtask regardless of how small the timer is, so the
relay-floor test passed even with the floor removed. It now parks the relay, and a red
control confirms removing only that floor fails only that test.

### The boot verification passed, closing plan 7a's open check

The dynamic `import()` of Baileys is the one line no test can cover: under `ts-jest`
`await import()` compiles to `require()`, which is how the Jest mock intercepts it at all,
while under `tsx` in production it must stay a genuine dynamic import. Opposite mechanisms.

The local Docker daemon was unavailable, so this ran as a throwaway Cloud Build
(`1bad7def-4fab-4bc2-a650-2934a6e7634c`) that built the real image and booted it - a closer
match to production than the Windows/Node 24 check the coder had managed. It deployed nothing
and did not scan the QR. Result: SUCCESS.

| Check | Result |
|---|---|
| Server boots on `node:20-bookworm-slim` under `tsx` | `> Ready on http://localhost:3000` |
| Baileys loads and connects | `[WA:qr] New QR code received (length: 277)` |
| Memory under the real 768m cap | **265.4 MB** (baseline ~1.4 GB) |
| Browser on PATH, puppeteer cache, puppeteer module | none of the three |
| `wget` present | yes, and the healthcheck depends on it |
| npm lifecycle scripts ran (R7) | `engine-requirements.js`, `protobufjs postinstall` |
| Chrome downloaded during the build | **zero** |

265 MB measured idle gives the 768m cap roughly 3x headroom, so tightening to 512m later is
safe but not urgent - the point was getting off 1600m.

### The deploy pipeline never shipped the nginx config

Found while checking whether the `proxy_read_timeout` fix would actually reach production. It
would not have. `cloudbuild.yaml` copied **only** `docker-compose.prod.yml` to the VM, even
though that file bind-mounts `./nginx/conf.d` into the nginx container. So the VM's nginx
config was hand-maintained and the repo was never really its source of truth. The two
happened to be byte-identical as of today, verified by diff ignoring line endings, so nothing
was broken - but any nginx change committed here would have silently gone nowhere.

Fixed in `318b1c1`: the deploy now copies the config, validates it with `nginx -t` **before**
anything is recreated, so an invalid config fails the build while the running nginx keeps
serving what it already loaded, then applies it with a graceful reload. The test is wrapped
in an `if` on the container's existence, because `if` returns its body's status - a failing
validation still stops the deploy, while a missing container on a fresh VM does not.

The VM's config was also world-writable, mode 666 inside a 777 directory, the same hygiene
problem the env file had before it was locked down. The deploy now sets it to 644.

### Host prerequisites, done

- `/var/intercessor/data/baileys_auth` created, owned 1000:1000, mode 700.
- `/var/intercessor/data/wwebjs_auth` (52 MB) deliberately left untouched for rollback.
- Disk at 18%, 78 GB free.

### Outstanding, deliberately

- **`.env.example` is not updated.** The permission system denies access to env-file paths,
  which is a sensible guardrail and was not worked around. A ready patch script sits at
  `scratchpad/handoff/s5-env-example-patch.py`; it documents `WA_AUTH_PATH`, `WA_LOG_LEVEL`,
  the corrected `WA_ACK_TIMEOUT_MS` default of 20000 and the new `WA_SEND_RELAY_TIMEOUT_MS`,
  and removes the dead `WA_QR_MAX_RETRIES`. Documentation only, no runtime effect.
- **No alert exists for "connected but every send fails."** `wa_session_lost` covers session
  loss only. Three log lines are stable and distinct - `No acknowledgement from WhatsApp`,
  `WhatsApp REJECTED the message`, `completed AFTER its` - so one Cloud Logging metric closes
  it. To be added at S6, once real log lines exist to match against.
- **Every group send performs an uncached `groupMetadata` iq**, since no `cachedGroupMetadata`
  is passed, plus device and session fetches across roughly 62 participants. On a cold session
  that can approach the 10s relay deadline and produce `false` for a message that probably
  arrived. Watch for `completed AFTER its 10000ms deadline` in the first week;
  `WA_SEND_RELAY_TIMEOUT_MS` raises it with no code change.
- **`whatsappSent` and Resend are all-or-nothing across groups.** With one group configured
  this cannot bite today, but with two, one slow group means the healthy group gets a
  duplicate on the first Resend click.

### The S6 instruction that matters most

If the log shows `No acknowledgement from WhatsApp` **while the phone shows the message
arriving**, do **not** press Resend - it double-posts. That pattern means the send worked and
only the confirmation signal is missing, which is the contingency in section 7b: add
`message-receipt.update` as a third accept signal. Note it is not a bounded-latency
substitute, because for a group it only fires once some participant's device has the message,
so `WA_ACK_TIMEOUT_MS` likely has to rise alongside it.

---

## 8. Rollback

The facade makes this cheap. If Baileys proves unworkable after deployment:

1. `git revert` the migration merge commit.
2. Redeploy; Cloud Build restores the previous image.
3. Re-add the `wwebjs_auth` volume mount — the host directory is deliberately left in
   place by S5.
4. Re-pair the old client by scanning its QR.

The one-way door is **re-pairing**: once the phone links a Baileys device, the
`whatsapp-web.js` session is gone. Since that session is already logged out as of
2026-09-30, there is nothing left to lose.

---

## 9. Out of scope

- Splitting WhatsApp into a container separate from the web app. This remains the right
  architectural fix and is independently valuable, but Baileys removes the memory
  pressure that made it urgent. Track it separately.
- Upgrading the VM to `e2-medium`. Baileys should make 2 GB comfortable again; revisit
  only if measurements say otherwise.
- The admin page's complete absence of test coverage at any layer.
