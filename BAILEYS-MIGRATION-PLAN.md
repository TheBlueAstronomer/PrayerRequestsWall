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
| R5 | **Ack semantics differ.** Group delivery is reported per participant. | Treat **exact-key `SERVER_ACK`** on `messages.update` as the durable "WhatsApp accepted it" signal for `whatsappSent`. Do not wait on per-participant delivery in a group. |
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
- It resolves `true` only once that exact key reaches `SERVER_ACK` (the value confirmed
  in S1) through `messages.update`, and `false` on `ERROR` status or timeout.
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
