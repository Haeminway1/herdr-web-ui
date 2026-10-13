# The system-pinned manager

The sidebar's resident agents (`docs/development.md`, Settings → Appearance) keep folders the user
chose on top or under the Resident tab. One resident is not the user's: the PC's own native
manager, which the server verifies and pins itself. This page is the contract for that pin.

## Identity contract

`server/residents.ts` owns the verdict. A snapshot proves the native manager when:

- an agent registered under the manager's own registration name (`hm-…`, derived from the
  control launch's label) points at a pane whose workspace and terminal ids still match the
  agent's binding, **or**
- a workspace carries the `hm_manager` token herdr itself sets,

and in both cases the pane's `cwd` is the server's ownership root — the canonicalized folder the
manager is trusted to live in. Exactly one workspace and exactly one pane may qualify; two
claimants is ambiguity, and ambiguity is never a pin. The pin the server answers is the
`system_pin` record `{ folder, workspace_id, pane_id, terminal_id }` (`shared/residents.ts`).

A `system_pin` read from the file or from a request body is metadata, never authority: the store
re-verifies against a fresh snapshot on every GET and PUT. A pin whose folder is not the
ownership root is dropped. On every response the manager's folder is normalized to `top[0]` and
removed from `residents`.

What the client owes to that binding (`isSystemResidentPane`): the sidebar's protected row is
found by all of workspace id, pane id, terminal id **and** folder at once — a matching label, or
the folder alone, never qualifies. The row leads every grouping (classic repo/directory/workspace)
and every Agents layout (flat, cards, activity, pins on or off), carries the lock labeled
"System pinned", and offers no pin, rename, close or toggle. An impostor — same folder, same
display name, different ids — stays an ordinary row with its own controls.

## Recovery vs. undeployed protection

Two different things are protected, and they must not be confused:

- **Recovery protection**: while herdr is unreachable, or the manager is absent or ambiguous in
  the latest snapshot, the *last validated binding* stands. An outage cannot unpin the manager,
  and a reconnect re-verifies the same pane. The client keeps showing the lock from the saved
  pin, and a demoting PUT still fails 409 `system_pin_protected`.
- **Undeployed protection**: a `system_pin` record the server itself never verified — stored
  before the feature existed, forged in a request body, or pointing at a folder outside the
  ownership root — is dropped, not honored. Protection follows the verified binding only; nothing
  persists an unverified one.

Corollary for the UI: when the manager's pane is gone from the snapshot but the pin stands, the
sidebar draws a locked ghost at the protected folder — selectable nowhere and never a "click to
start" row. Launching a session in the pinned folder is always refused by construction: the
ghost's select button is disabled and no code path calls `workspace/create` for it.

## Regression

The proof is synthetic end to end: `scripts/manager-pin-regression.ts` builds the demo's
unmodified client, injects one fixture script that points the app's own fetch/EventSource/
WebSocket traffic at fixtures carrying a synthetic manager plus a same-name/same-folder impostor,
and serves `/api/residents` through the real `ResidentStore`/`handleResidentsRequest` on a
loopback `Bun.serve` bound to a temp state file. No herdr, no user socket, no real state dir.

```
bun install --frozen-lockfile
bun scripts/manager-pin-regression.ts
```

`CHROME_PATH` picks the browser (the lane uses the lockfile's Playwright Chromium; the default is
`/opt/google/chrome/chrome`). The suite runs the classic sidebar's three groupings and the Agents
layout's flat/cards/activity modes on both a 1280x900 desktop and a 390x844 touch context, plus
the API contract, settings, outage/recovery, second-device and Korean-localized drawer cases.
Counters land in `evidence/manager-browser.json` (`executed`, `failures`, `errors`, `skipped` —
nothing else), the per-scenario detail in `evidence/manager-pin/browser-details.json`, and the
screenshots in `evidence/manager-pin/*.png`. The run exits nonzero on any failure, any error, or
zero attempted scenarios. The browser lane runs it as `run_script scripts/manager-pin-regression.ts`
in `scripts/ci-browser.sh`.

## Deployment

Nothing is deployed or restarted for the pin itself; it is a behavior of the running server and
client that ship together:

1. Land the server and client on a build that carries `system_pin` support. The route pair
   (`GET`/`PUT /api/residents`) is one handler; the client treats a missing `system_pin` as no
   pin, so an older client beside a newer server simply never sees the lock, and a newer client
   beside an older server gets `null`.
2. The first read or write against `residents.json` with a live, verified manager persists the
   binding; a file from before the feature heals on read. No migration step exists — do not run
   one, and do not restart a server to "pick up" a pin: the store reads the file and a fresh
   snapshot on every request.
3. Browsers adopt the pin on the next residents refresh (load, visibility return, `online`), not
   on any server event. A device that never reloads keeps showing its last answer — correct by
   design, since the answer carries the last validated binding.

To retire or move the pin: the server drops a binding whose folder is not the ownership root and
heals the file on the next read. Never edit `residents.json` to create a pin — an unverified one
is ignored — and never push a `system_pin` in a PUT body expecting it to stick.
