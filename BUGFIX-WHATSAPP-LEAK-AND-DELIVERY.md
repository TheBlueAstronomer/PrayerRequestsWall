# Bugfix Implementation Plan — WhatsApp Chromium Leak & Silent Delivery Failure

**Date:** 2026-08-08
**Author:** Diagnosis from the 2026-08-07 production outage on `tribeprayer.org`
**Status:** Proposed — awaiting review. Nothing in here has been implemented.

---

## 1. Summary

Two unrelated production bugs, both currently live. They were found together because the
outage investigation ran into the second one while verifying the first.

| # | Bug | Severity | Effect |
|---|---|---|---|
| **A** | Chromium relaunch loop leaks browser instances until swap is exhausted | **P0** | Site went fully down for ~4h on 2026-08-07; recurs every ~2 weeks |
| **B-i** | Programmatic sends are never accepted by WhatsApp's servers (`ack: 0`) | **P0** | **No WhatsApp message has been delivered since 2026-07-14.** No fix available yet |
| **B-ii** | `MsgKey._serialized` renamed to `$1` by WhatsApp Web | **P0** | Every send *reports* failure; ack verification is a silent no-op. Masked B-i |

Bug A is a defect in our code. B-i and B-ii are both upstream drift from a July 2026
WhatsApp Web update; our code tolerates neither.

> **Read this before planning work.** B-i has **no known fix** — it is an open, unresolved
> upstream issue ([#201849](https://github.com/wwebjs/whatsapp-web.js/issues/201849)) with
> two competing unmerged PRs. Upgrading the library cannot fix it: the latest release
> predates the breakage. Problem A is fully actionable; Problem B is partly a
> decision about which risk to take. See [§5 Problem B](#problem-b--layered-and-partly-unresolved).

Ship as **separate PRs** — see [§7 Rollout](#7-rollout-plan).

---

## 2. How this was diagnosed (evidence trail)

Recorded so the reasoning can be re-checked rather than taken on trust.

**Outage timeline (2026-08-07, UTC):**

| Time | Event |
|---|---|
| ~2026-07-22 | Last deploy. Swap begins filling from ~0 |
| 2026-08-06 23:16 | Swap reaches **100%**, stays pinned |
| 2026-08-07 ~13:00 | App stops answering. Uptime checks begin failing |
| 2026-08-07 ~14:15 | Ops Agent dies — metrics stop |
| 2026-08-07 ~15:04 | `google-guest-agent-manager` enters restart loop |
| 2026-08-07 ~17:50 | Hard reset; service restored |

**What made this hard to spot:** at the hypervisor level the VM looked healthy —
CPU flat at ~12%, disk writes flat at ~135 KB/s, disk only 15 GB of 100 GB used.
nginx was alive and answered `:80` instantly. Only requests proxied to the app hung,
returning `504` after the full 62s `proxy_read_timeout`. `gcloud compute ssh` could not
obtain a shell because the box could not fork one.

The decisive signal was **`agent.googleapis.com/swap/percent_used`**, which had been at
99–100% for a full day beforehand. A swap alert has since been added (policy
`135261226182688997`, >80% for 15 min).

**Memory growth, `agent.googleapis.com/memory/percent_used` (state `used`):**

```
Jul 31  71.4%      Aug 4  74.8%      Aug 7  82.6%
Aug 2   72.5%      Aug 5  75.2%      swap: 78% -> 100% over the same window
Aug 3   73.4%      Aug 6  78.4%      net growth ~= 135-190 MB/day
```

**Observed live during the investigation:** 28 `chrome` processes with only 5 renderers
(≈4 orphaned browser instances), 19 zombies accumulating at ~2 per 5s, and RSS climbing
1,120 MB → 1,451 MB in ten minutes. After a clean container restart: 9 processes,
5 renderers, 0 zombies.

---

## 3. Problem A — Chromium relaunch loop exhausts memory

### A1. `GET /api/admin/qr` mutates state, and is polled every 5 seconds

[`src/app/admin/page.tsx:98`](src/app/admin/page.tsx#L98) polls the QR endpoint on a fixed
5-second interval for as long as an authenticated admin page is open:

```ts
const qrInterval = setInterval(fetchQrCode, 5000);
```

[`src/app/api/admin/qr/route.ts:13`](src/app/api/admin/qr/route.ts#L13) makes that read
side-effectful:

```ts
if (!qr) {
    Promise.resolve(whatsappService?.initialize()).catch(...)
}
```

The comment above it asserts:

> `initialize()` is a no-op while the client is already connected or initializing, so polling is safe.

That holds on the happy path and fails on the error path — which is A2.

### A2. The re-entrancy guard is defeated by its own error handler

[`src/lib/whatsapp.ts:275-291`](src/lib/whatsapp.ts#L275):

```ts
public async initialize() {
    if (this.isInitializing || this.isReady) { /* ...skip... */ return; }
    this.clearStaleLock();
    this.isInitializing = true;
    try {
        await this.client.initialize();
    } catch (err) {
        this.isInitializing = false;      // <-- re-opens the guard
        console.error('[WA:init] Client initialization failed:', err);
    }
}
```

When `client.initialize()` throws, `isInitializing` returns to `false` while `isReady`
stays `false`. The guard is therefore open again for the next poll, 5 seconds later.

**There is no backoff, no failure counter, and no ceiling.** While the client is not
ready and an admin page is open, the app attempts a *fresh Chromium launch every 5 seconds
indefinitely*.

Captured in production at 18:22:39 → 18:22:59, one attempt per 5s, each failing with:

```
[WA:init] Client initialization failed: Error: The browser is already running for
/app/.wwebjs_auth/session. Use a different `userDataDir` or stop the running browser first.
```

That error message is the leak stating itself out loud: a Chromium from a previous attempt
is still alive and still holding the profile lock, and the service no longer holds a
reference to it.

### A3. `replaceClient()` abandons the old browser without destroying it

[`src/lib/whatsapp.ts:211-214`](src/lib/whatsapp.ts#L211):

```ts
private replaceClient() {
    this.client.removeAllListeners();
    this.client = this.createClient();
}
```

Listeners are correctly detached — that fixed a real earlier bug and should stay. But
`destroy()` is never called, so the underlying Puppeteer browser is never closed.

Today both call sites happen to be paths where Chromium was already released (the
`max qrcode retries` branch, and `logout()` which destroys first). So this is **not**
currently the primary leak — but it is one refactor away from becoming one, and it is
the natural place to make orphan-cleanup unconditional.

### A4. Container PID 1 is `npm start`, so dead children are never reaped

[`Dockerfile:68`](Dockerfile#L68) ends the startup script with `exec npm start`, making
`npm` PID 1 inside the container. `npm` is not an init and does not reap orphaned
children. Chromium — launched with `--no-zygote`
([`src/lib/whatsapp.ts:90`](src/lib/whatsapp.ts#L90)) — re-parents helper processes,
which then accumulate as zombies.

Measured: **2 zombies per 5 seconds** while in the failure loop. Secondary to the memory
leak in bytes, but it consumes PIDs, and PID pressure is the most likely reason SSH could
not fork a login shell during the outage.

### A5. No memory bound on the container

[`docker-compose.prod.yml`](docker-compose.prod.yml) sets `shm_size: '1gb'` but no
`mem_limit`. Confirmed on the box:

```
RestartPolicy=always  Memory=0  MemSwap=0  RestartCount=0
```

Consequences:

- The app can consume all 2 GB of host RAM **and** all 2 GB of swap.
- `restart: always` never fires, because the process never exits — it just degrades.
  The container stays `Up` while being completely unresponsive.
- The blast radius is the whole VM (sshd, Ops Agent, guest agent) instead of one container.

**Baseline headroom is genuinely tight:** one *healthy* Chromium is 0.9–1.4 GB of a
1.98 GB box. There is very little room to leak into, which is why a modest leak is fatal here.

---

## 4. Problem B — WhatsApp delivery is completely broken

### B1. Symptom

Every send logs, and `sendMessage()` returns `false`:

```
[WA:send] No message id returned for <chatId>; cannot confirm delivery.
```

This is **not** specific to the test group. The main group uses the identical code path
([`resend/route.ts:35` and `:52`](src/app/api/admin/prayers/resend/route.ts#L35)).

### B2. The message is genuinely not delivered

The failed test message is present in the local chat model but stuck:

```json
{ "t": "2026-08-07T18:25:27.000Z", "fromMe": true, "ack": 0,
  "from": "8899289706750@lid",
  "body": "🙏 *New Anonymous Request:* I have a hard tim…" }
```

**Confirmed on a real phone:** the last message actually present in the "Just me" group is
from **14 July, 18:47 IST (13:17 UTC)** — which matches the last
`[WA:send] Message sent successfully` log line exactly. Nothing has arrived since.

> **Correction.** An earlier reading of this evidence concluded the send worked and only
> the reporting was broken. That was wrong. `ack: 0` meant exactly what it says, and the
> phone check is what settled it. The distinction matters enormously: this is a total
> delivery outage of ~3.5 weeks, not a cosmetic logging bug.

The account itself is healthy — it is the *programmatic* send that fails. Outgoing messages
across all chats, most recent first:

| Time (UTC) | Chat | ack | Origin |
|---|---|---|---|
| 18:25:27 | Just me | **0** | **web session (our app)** |
| 17:54:29 | Jessica Abigail D'Cruz | 2 | phone |
| 17:00:59 | +62 811-1938-0888 | 3 | phone |
| 16:09:25 | Dad | 3 | phone |
| 15:19:52 | Ajay Issac | 2 | phone |

The socket is connected and syncing in both directions. Phone-originated messages ack
normally. Only messages injected by whatsapp-web.js stick at `ack: 0`.

Four hypotheses were tested and **disproved**:

| Hypothesis | Disproved by |
|---|---|
| Bad/stale group id | Both ids resolve via `WWebJS.getChat()` to a real chat, `isReadOnly: false` |
| Not a group member | `participantCount: 1`, and that participant is us (`8899289706750@lid`, `isAdmin: true`) |
| Announce-only group (admins only) | `announce: false` on both groups |
| Broken session / dead socket | Phone messages sync in and ack 2/3 throughout |

### B2a. Root cause of B-i is upstream and unresolved

A **July 2026 WhatsApp Web update** broke message sending for whatsapp-web.js. Tracked
upstream as [issue #201849](https://github.com/wwebjs/whatsapp-web.js/issues/201849),
reported against whatsapp-web.js **1.34.7** with WhatsApp Web `2.3000.1043332421`:

> `sendMessage()` resolves and returns an id, but no ACK ever arrives — not even ACK 1.
> The message shows as "Waiting for this message" and is never delivered.

That is our symptom. Our variant is slightly worse: we do not even get an id back, because
B-ii bites first.

**Critically, the timeline rules out an upgrade as the fix:**

```
1.34.6   released 2026-01-30   <- installed
1.34.7   released 2026-04-24   <- latest published release; the AFFECTED version
~2026-07-14                    <- our last successful delivery; breakage begins after
2026-07-27                     <- only commit on main since 1.34.7 (addParticipants; unrelated)
```

There is **no released version that contains a fix**, and no merged fix on `main`.

### B3. Root cause of B-ii: `MsgKey._serialized` renamed to `$1`

`whatsapp-web.js@1.34.6` ends `window.WWebJS.sendMessage`
(`node_modules/whatsapp-web.js/src/util/Injected/Utils.js`) with:

```js
const [msgPromise, sendMsgResultPromise] = window.Store.SendMessage.addAndSendMsgToChat(chat, message);
await msgPromise;
if (options.waitUntilMsgSent) await sendMsgResultPromise;
return window.Store.Msg.get(newMsgKey._serialized);   // <-- undefined
```

Measured against the live page:

```
MsgKey own keys:  ["fromMe", "remote", "id", "participant", "$1"]
has _serialized:  false
String(msgKey):   "true_919886160464-1565807006@g.us_3EB05D1E2B467A6FDB4633_8899289706750@lid"

Store.Msg.get(msgKey._serialized)  ->  key null,  found FALSE
Store.Msg.get(String(msgKey))      ->             found TRUE
```

So `Store.Msg.get(undefined)` → `undefined` → `WWebJS.sendMessage` returns `undefined` →
`Client.sendMessage()` returns `undefined` → our `sent?.id?._serialized` check fails.

**The library sends the message, then cannot find it again to return it.**

Note the value still exists — under the minified key `$1`, and reachable via `toString()`.
`Wid` is unaffected and still has `_serialized`; only `MsgKey` lost it.

This matches the upstream diagnosis exactly: PR
[#201848](https://github.com/wwebjs/whatsapp-web.js/pull/201848) describes WhatsApp Web
having "renamed the message key property `_serialized` to `$1`". Independent confirmation
that this measurement is correct and general, not something specific to our install.

### B4. Second, independent breakage from the same upstream change

The ack-verification feature (PR #15/#16) reads the same missing property.
[`src/lib/whatsapp.ts:151`](src/lib/whatsapp.ts#L151):

```ts
client.on('message_ack', (msg: unknown, ack: number) => {
    const id = (msg as SentMessage)?.id?._serialized;
    if (!id) return;                 // <-- every ack now early-returns
```

So even after B3 is fixed, acks would still be dropped. Downstream effects:

- `waitForAck()` always times out → `sendMessage()` returns `false` even on success.
- `prayerRequests.whatsappSent` is never set to `true`
  ([`resend/route.ts:59-63`](src/app/api/admin/prayers/resend/route.ts#L59)).
- The `[WA:alert]` session-lost pipeline is unaffected (it does not use message ids).

### B5. What the Node side actually receives

This determines the app-side fix and was verified empirically — **do not guess at it**:

```jsonc
sent.id = {
  "fromMe": true,
  "remote": "919886160464-1565807006@g.us",              // string (Wid fixed up by getMessageModel)
  "id": "3EB05D1E2B467A6FDB4633",
  "participant": { "server": "lid", "user": "8899289706750",
                   "_serialized": "8899289706750@lid" }, // Wid — still has _serialized
  "$1": "true_919886160464-1565807006@g.us_3EB05D1E2B467A6FDB4633_8899289706750@lid"
}
```

Two things follow:

1. `_serialized` is absent, so `String(id)` in Node yields `"[object Object]"` — the
   browser-side `toString()` trick **does not** carry across the `page.evaluate` boundary.
2. The canonical form is `fromMe_remote_id[_participant]`, and it can be reconstructed
   from fields that are all still present.

### B6. Resolved — it did not deliver

Answered by checking the phone: the last message in "Just me" is from 14 July 18:47 IST.
Nothing since. See [§B2](#b2-the-message-is-genuinely-not-delivered).

**Consequence for scope:** B-ii alone is not enough. Fixing the id lookup would change the
failure from *"no message id returned"* to *"no delivery ack within 30000ms"* — still a
failure, just a more honest one. **B-i is the bug that actually matters**, and it is the
one without a known fix.

### B7. Blast radius

Since ~2026-07-14, silently:

- No prayer request has reached the "Tribe Bulletin" group (62 participants).
- `prayerRequests.whatsappSent` has not been set for anything in that window.
- The admin UI reported failures, which is at least honest — but there was no alert on it,
  so nobody was notified. The existing WhatsApp alerting watches *session* health
  (`/api/health/whatsapp` = connected), and the session **is** connected. It cannot see a
  send that is accepted locally and silently dropped.

That monitoring gap is worth its own fix regardless of how B is resolved — see
[B-FIX-5](#b-fix-5--alert-on-delivery-not-just-connection-strongly-recommended).

---

## 5. Proposed solutions

### Problem A

#### A-FIX-1 — Make `initialize()` self-limiting *(required)*

Add consecutive-failure tracking and a backoff window. Sketch:

```ts
private consecutiveInitFailures = 0;
private nextInitAllowedAt = 0;

private static readonly INIT_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000];

public async initialize({ force = false } = {}) {
    if (this.isInitializing || this.isReady) return;

    if (!force && Date.now() < this.nextInitAllowedAt) {
        return;   // in backoff — stay quiet, do not log per-attempt
    }

    this.clearStaleLock();
    this.isInitializing = true;

    try {
        await this.client.initialize();
        this.consecutiveInitFailures = 0;
        this.nextInitAllowedAt = 0;
    } catch (err) {
        this.isInitializing = false;
        const i = Math.min(this.consecutiveInitFailures, WhatsAppService.INIT_BACKOFF_MS.length - 1);
        this.nextInitAllowedAt = Date.now() + WhatsAppService.INIT_BACKOFF_MS[i];
        this.consecutiveInitFailures++;
        console.error(`[WA:init] Client initialization failed (attempt ${this.consecutiveInitFailures}):`, err);
        await this.discardBrowser();   // A-FIX-2
    }
}
```

`force: true` is for an explicit admin action (see A-FIX-3), so a human can always
override the backoff.

#### A-FIX-2 — Destroy the orphan before relaunching *(required)*

The `browser is already running` error means a live Chromium holds the profile. Add an
explicit teardown used by both the failure path and `replaceClient()`:

```ts
private async discardBrowser() {
    try {
        await this.client.destroy();
    } catch (err) {
        console.warn('[WA:cleanup] destroy() failed while discarding a dead client:', err);
    }
    this.client.removeAllListeners();
    this.client = this.createClient();
}
```

Then `replaceClient()` becomes a thin wrapper, or is replaced by this outright. Keep
`removeAllListeners()` — it fixes a real prior bug (duplicate QR emission).

> **Design note.** `destroy()` on an already-dead client can itself throw or hang. It must
> be wrapped, and ideally raced against a timeout so cleanup cannot become a new hang.

#### A-FIX-3 — Stop a GET from mutating state *(required)*

`GET /api/admin/qr` should read `latestQR` and nothing else. Move re-arming to an explicit
`POST /api/admin/qr/rearm` (or `POST /api/admin/whatsapp/reconnect`) that calls
`initialize({ force: true })`, driven by a visible "Reconnect" button in the admin UI.

This removes the loop's engine outright: no amount of polling can then launch a browser.

#### A-FIX-4 — Reduce polling pressure *(recommended)*

In [`page.tsx:98`](src/app/admin/page.tsx#L98): stop polling once connected, and back off
to ~15s when a QR is already displayed. A QR is valid for ~20s, so 5s polling is more
aggressive than it needs to be.

#### A-FIX-5 — `init: true` in compose *(required)*

```yaml
services:
  app:
    init: true          # docker-init (tini) as PID 1; reaps orphaned Chromium children
```

Cheapest fix in the set and it removes the zombie class entirely.

#### A-FIX-6 — Bound the container *(required)*

```yaml
services:
  app:
    mem_limit: 1400m           # leaves ~500 MB for host + nginx on a 1.98 GB box
    memswap_limit: 1400m       # forbid swap growth; without this the cgroup can still swap
```

Turns "the whole VM degrades over two weeks" into "the container is OOM-killed and
`restart: always` recovers it in seconds".

> **Verify before merging:** confirm a healthy steady state fits under 1400m. Measured
> baseline was 1,120–1,451 MB *including* the leak in progress; a clean single Chromium
> was ~920 MB. If a legitimate peak exceeds the cap the app will crash-loop, which is worse
> than the bug. Consider starting at 1600m and tightening once observed.
>
> `mem_limit` under Compose v3 requires either `docker compose` v2 or moving the key under
> `deploy.resources.limits`. Check which is on the VM before assuming it takes effect —
> a silently ignored limit gives false confidence.

#### A-FIX-7 — Health check so a wedged app self-heals *(recommended)*

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 60s
  timeout: 10s
  retries: 3
  start_period: 180s
```

Note Docker does **not** restart on health-check failure by itself. Either add an
autoheal-style sidecar, or accept this as observability only. `start_period` must be
generous — the app takes 60–90s to load the WhatsApp session, and a short period would
cause a boot loop.

### Problem B — layered, and partly unresolved

You asked for all three original suggestions. One of them has since been **disproved by
evidence** and is kept below only so the reasoning is on record — please read B-FIX-1
before assigning it.

The honest state: **B-ii is solvable today. B-i is not.** B-FIX-2/3/5 are worth doing
regardless, but none of them will get a message delivered on their own.

#### B-FIX-1 — ~~Upgrade to 1.34.7~~ (rejected: cannot work)

Originally proposed as the cheap first try. **Do not spend time on it.**

- 1.34.7 was released **2026-04-24**; our breakage began after **2026-07-14**.
- Upstream issue [#201849](https://github.com/wwebjs/whatsapp-web.js/issues/201849) is
  reported *against* 1.34.7 — it is the affected version, not the fixed one.
- The only commit on `main` since is 2026-07-27 (`addParticipants`), unrelated.

Kept for the record. If you want it attempted anyway it costs one build, but the expected
outcome is no change.

#### B-FIX-2 — `patch-package`, based on the upstream PRs *(addresses B-ii)*

Add `patch-package` as a devDependency with a `postinstall` hook. Two open upstream PRs
already implement this properly — **prefer porting one of them over hand-rolling a
one-liner**, because there are more affected call sites than the one we hit:

| PR | Approach | Notes |
|---|---|---|
| [#201848](https://github.com/wwebjs/whatsapp-web.js/pull/201848) | `WWebJS.getMsgKeyId(key)` — prefers `_serialized`, falls back to `$1`. Applied to `getChatModel`, `sendMessage`, `editMessage`; also restores `_serialized` in `getMessageModel` | Open. Reviewers note uncovered paths: poll-vote parent keys, `protocolMessageKey`, `latestEditMsgKey` |
| [#201871](https://github.com/wwebjs/whatsapp-web.js/pull/201871) | `Base._normalizeId(id)` — non-mutating fallback, updates `Message.js` + `Utils.js` | Open. Claims it *may* also help the ACK problem — **worth testing against B-i** |

The minimal version of the fix, verified working on our own session:

```diff
- return window.Store.Msg.get(newMsgKey._serialized);
+ return window.Store.Msg.get(newMsgKey._serialized ?? String(newMsgKey));
```

(`Store.Msg.get(String(msgKey))` returns the message — measured. In the browser context
`newMsgKey` is a live `MsgKey` whose `toString()` yields the canonical form.)

Requires a Dockerfile change, since `npm ci` must run `postinstall` and patches must be
present before install:

```dockerfile
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci
```

> **Test #201871 first.** It is the only candidate with any claim on B-i. If it restores
> delivery, it collapses B-i and B-ii into one fix and this whole section gets much simpler.
> Note that #201849 reports #201848 as *not* resolving the missing-ACK problem, so
> expectations should be low but the test is cheap.

#### B-FIX-3 — Tolerate the missing field in our own code *(required regardless)*

Independent of what upstream does. Add one helper and route every id read through it:

```ts
/**
 * WhatsApp Web renamed MsgKey's `_serialized` to the minified `$1` (July 2026). The
 * canonical value is still reconstructable from the parts. Try, in order: the documented
 * field, reconstruction, then any own property that looks like a serialized key.
 *
 * NOTE: `String(id)` works in the browser context but NOT here — across the
 * page.evaluate() boundary the key arrives as a plain object and stringifies to
 * "[object Object]". Reconstruction is the only portable route.
 */
function serializeMsgId(id: unknown): string | null {
    if (!id || typeof id !== 'object') return null;
    const k = id as Record<string, unknown>;

    if (typeof k._serialized === 'string' && k._serialized) return k._serialized;

    const wid = (v: unknown): string | null =>
        typeof v === 'string' ? v
        : v && typeof v === 'object' && typeof (v as { _serialized?: unknown })._serialized === 'string'
            ? (v as { _serialized: string })._serialized
            : null;

    const remote = wid(k.remote);
    const raw = typeof k.id === 'string' ? k.id : null;
    if (typeof k.fromMe === 'boolean' && remote && raw) {
        const participant = wid(k.participant);
        return [String(k.fromMe), remote, raw, ...(participant ? [participant] : [])].join('_');
    }

    // Last resort: whichever own property currently holds the serialized form.
    for (const v of Object.values(k)) {
        if (typeof v === 'string' && /^(true|false)_.+_[A-Za-z0-9]+/.test(v)) return v;
    }
    return null;
}
```

Verified shape this must handle (measured on production, see [§B5](#b5-what-the-node-side-actually-receives)):

```jsonc
{ "fromMe": true, "remote": "919886160464-1565807006@g.us",
  "id": "3EB05D1E2B467A6FDB4633",
  "participant": { "server": "lid", "user": "8899289706750", "_serialized": "8899289706750@lid" },
  "$1": "true_919886160464-1565807006@g.us_3EB05D1E2B467A6FDB4633_8899289706750@lid" }
```

Call sites:

| File | Line | Change |
|---|---|---|
| `src/lib/whatsapp.ts` | ~151 | `const id = serializeMsgId((msg as SentMessage)?.id);` |
| `src/lib/whatsapp.ts` | ~339 | `const messageId = serializeMsgId(sent?.id);` |

Also widen the `SentMessage` type — `id` is no longer `{ _serialized?: string }`.

**Additionally**, decide the policy for an unconfirmable send. Today an unknown id is
reported as outright failure. Recommended: distinguish the two.

```ts
type SendOutcome = 'delivered' | 'unconfirmed' | 'failed';
```

`unconfirmed` should surface in the admin UI as a warning, not a red failure, and must
**not** mark `whatsappSent = true`. This keeps a future upstream rename from silently
flipping every send into a reported failure again.

> Note this does **not** apply to the current outage: today's sends are genuinely failing,
> so `failed` is the correct report. The distinction matters for the *next* rename.

#### B-FIX-4 — Decide what to do about B-i *(the actual blocker)*

No fix exists. This is a judgement call about risk, not an implementation task. Options,
roughly in increasing order of effort:

| Option | Pros | Cons |
|---|---|---|
| **Wait for upstream** | Zero effort; the fix will be correct | Open-ended. Delivery stays broken meanwhile. Two competing unmerged PRs, no maintainer commitment |
| **Test/port #201871** | Cheap; only candidate touching ACK | May not work. Carrying an unmerged patch in prod |
| **Pin the WhatsApp Web build** | Would sidestep the July change entirely | whatsapp-web.js pins via `webVersionCache`; WhatsApp aggressively deprecates old builds. Fragile and probably short-lived |
| **Switch library** (e.g. Baileys) | Different architecture — no Chromium, which also **deletes Problem A entirely** | Substantial rewrite of `src/lib/whatsapp.ts`. Different auth model. Same ToS grey area |
| **WhatsApp Business Cloud API** | Officially supported, no browser, no ToS risk, no leak | Paid; requires a Business account and template approval for some message classes. Largest change |

> **Recommendation.** Do not block Problem A on this. Fix the leak now — it is entirely
> ours and fully solvable. In parallel, test #201871 as a spike. If it fails, the
> conversation becomes "Baileys or Cloud API", and that deserves its own ADR rather than
> being smuggled into a bugfix PR.
>
> Worth stating plainly: an unofficial browser-automation integration breaking on a
> vendor update is the expected failure mode of this design, not bad luck. It has now
> caused a 3.5-week silent outage. That is the real argument for the last two rows.

#### B-FIX-5 — Alert on delivery, not just connection *(strongly recommended)*

This outage was silent for 3.5 weeks because every existing alert was green. The uptime
check on `/api/health/whatsapp` only asks "is the session connected?" — and it was.

Add either:

- a log-based metric + alert on `[WA:send]` failures (the log line already exists and is
  stable), firing on any failure in a rolling window; or
- a scheduled canary that sends to the "Just me" test group and alerts if it does not
  reach `ack >= 1`.

The canary is stronger — it proves the whole path end-to-end rather than the session
handshake. Both are cheap. **Do this even if B-i is never fixed**, so the next silent
delivery failure is loud.

---

## 6. Acceptance criteria

### Problem A

- [ ] **A-AC-1** With the client in a permanently failing state (e.g. point `WA_DATA_PATH`
      at an unwritable dir) and an admin page open for 10 minutes, `[WA:init] Starting
      client initialization...` appears **no more than 6 times**, with visibly increasing
      gaps. Before the fix: ~120 times.
- [ ] **A-AC-2** Across that same 10 minutes, `pgrep -c chrome` does not grow monotonically,
      and no more than one main browser process exists at any time.
- [ ] **A-AC-3** `GET /api/admin/qr` never launches a browser. Verified by polling it 50×
      against a not-ready client and confirming zero new `chrome` processes.
- [ ] **A-AC-4** An explicit reconnect (`POST` route / admin button) **does** launch a
      browser even while in backoff (`force: true` path).
- [ ] **A-AC-5** After 30 minutes of normal operation with an admin page open,
      `ps -eo stat | grep -c Z` returns `0`.
- [ ] **A-AC-6** `docker inspect prayer-wall-app-prod` shows a non-zero `Memory` limit
      **and** `HostConfig.Init` is `true`.
- [ ] **A-AC-7** A synthetic memory hog inside the container is OOM-killed at the cap, and
      the container returns to `Up` via `restart: always` — the **host** never enters swap.
- [ ] **A-AC-8** Steady-state RSS with a healthy connection is recorded and sits at least
      15% below `mem_limit`.
- [ ] **A-AC-9** `agent.googleapis.com/swap/percent_used` stays **below 20%** for 7
      consecutive days post-deploy. *(This is the real proof; the rest are proxies.)*
- [ ] **A-AC-10** Existing WhatsApp unit tests still pass, including the `replaceClient`
      duplicate-listener regression tests in `src/__tests__/lib/whatsapp.test.ts`.

### Problem B-i — delivery *(the one that matters)*

**B-AC-1 is the only criterion that proves the bug is fixed. Everything else is
supporting.** Do not mark Problem B done on the strength of B-ii criteria alone — that is
precisely the mistake that let this run silently for 3.5 weeks.

- [ ] **B-AC-1** A test send reaches `ack >= 1`, **and** the message is visible in the
      target group on a real phone. Not a local model, not a log line — the phone.
- [ ] **B-AC-2** The same holds for the **main** group ("Tribe Bulletin"), not just the
      test group.
- [ ] **B-AC-3** A prayer submitted through the normal user flow arrives in the group, and
      `whatsappSent` is set to `true`.
- [ ] **B-AC-4** Record which option from [B-FIX-4](#b-fix-4--decide-what-to-do-about-b-i-the-actual-blocker)
      resolved it, and against which WhatsApp Web build. The next break starts from fact
      instead of repeating this investigation.

### Problem B-ii — id handling and reporting

- [ ] **B-AC-5** `client.sendMessage()` returns a Message object with a resolvable id
      rather than `undefined`.
- [ ] **B-AC-6** The `message_ack` handler no longer early-returns: a log line or metric
      confirms acks are matched to pending sends.
- [ ] **B-AC-7** Unit tests cover `serializeMsgId()` for: the legacy `_serialized` shape,
      the current `fromMe/remote/id/participant` shape, the 1-to-1 (no participant) shape,
      the minified `$1` fallback, and `null`/garbage input.
- [ ] **B-AC-8** With `serializeMsgId()` forced to return `null`, a send reports
      `unconfirmed` — **not** `failed` — and does not set `whatsappSent`.
- [ ] **B-AC-9** If B-FIX-2 is used: `patches/` is committed, `npm ci` applies it inside
      the Docker build, and a built image is confirmed to contain the patched line.

### Problem B — monitoring

- [ ] **B-AC-10** With sending deliberately broken, an alert fires within 15 minutes.
      Verified by a real test, not by reading the config.
- [ ] **B-AC-11** The alert is distinguishable from the existing session-lost alert, so
      "connected but not delivering" is not mistaken for a logout.

---

## 7. Rollout plan

**Ship as separate PRs, merged one at a time.** Merging two at once will hit the known
Cloud Build race, where concurrent builds fight over the `:latest` tag and the running
container can end up on the *older* image while both builds report SUCCESS.

Revised ordering — **Problem A now goes first**, because it is the only one that is fully
solvable today:

1. **PR 1 — Problem A (leak).** Entirely our own code, no external dependency, clear
   acceptance criteria. Stops the recurring outage. Needs the 7-day swap observation.
2. **PR 2 — B-FIX-5 (delivery alerting).** Small and independent. Worth landing early so
   that whatever happens with B-i, the next silent failure is loud. Does not depend on
   PR 3.
3. **PR 3 — B-ii (id handling: B-FIX-2 + B-FIX-3).** Makes failures honest and unblocks
   ack tracking. **Will not restore delivery on its own** — expect sends to fail with an
   ack timeout rather than a missing id. Land it anyway; it is a prerequisite for
   verifying any B-i fix.
4. **Spike (not a PR) — test #201871 against B-i.** Timebox it. Outcome decides whether
   Problem B ends in a patch or in an ADR about leaving whatsapp-web.js.

After **each** merge, verify the running image actually matches `:latest`:

```bash
docker inspect -f '{{.Image}}' prayer-wall-app-prod
```

Compare against the digest in Artifact Registry. If they differ, re-run
`gcloud builds triggers run prayer-wall-main-push --branch=master` once, with no competing
build in flight.

**Rollback:** both PRs are revert-safe. Compose changes (A-FIX-5/6) apply on container
recreate, so reverting requires a `docker-compose up -d`, not just an image rollback.

**Pre-flight:** a snapshot exists only from 2026-07-14. Take a fresh one before the
Problem A deploy, since it changes container runtime configuration.

---

## 8. Out of scope

Real, already-known, deliberately not bundled here:

- `startup-script` metadata still installs Docker with no log rotation, so a rebuilt VM
  regresses the 2026-07-14 hardening.
- Admin login has no rate limiting, and the password is a dictionary word.
- `portfolio-vm` (the other VM in the project) has ~1,074 zombie processes and is unrelated
  to this work.
- Ops Agent and `google-guest-agent-manager` both crashed *as a consequence* of memory
  exhaustion. Expected to resolve with Problem A; worth re-checking after, not fixing now.

---

## 9. Appendix — read-only production debugging

This recipe produced most of the Problem B evidence and is worth keeping. It attaches to
the **live** Chromium without disturbing the session and without sending anything.

```bash
# Chromium's DevTools port (first line of the file)
sudo head -1 /var/intercessor/data/wwebjs_auth/session/DevToolsActivePort
```

```js
const b = await require('/app/node_modules/puppeteer')
    .connect({ browserURL: 'http://127.0.0.1:<port>' });
const page = (await b.pages()).find(p => p.url().includes('web.whatsapp.com'));
const out = await page.evaluate(() => /* inspect window.Store / window.WWebJS */);
b.disconnect();   // NEVER b.close() — that kills the live WhatsApp session
```

Ship the script in with `docker cp`; base64-encoding it through SSH avoids quoting problems.
Useful entry points: `WWebJS.getChat(id, { getAsModel: false })`, `chat.msgs.getModelsArray()`,
`Store.Msg.get(key)`, `Store.User.getMaybeMePnUser()`.
