# De Ronde kaart — Collaboration subsystem

**Audience:** developers and maintainers. Companion to
[system-design.md](system-design.md) §10 and the Collaboration subsection of §3,
both of which this file replaces in full.

**This subsystem is optional.** It is gated on the `annotations` flag in
`map.json` (default `false`), and collaborative *sessions* additionally require
`share`. The collab server is a separate deployable — a `docker-compose`
service, not part of the static bundle. With the flag off, or the server absent,
the rest of the app is unaffected: annotations simply stay local to the browser.
Of the shipped configurations, only `woonzorglimburg` turns it on.

---

## Dependencies

Both packages exist for one feature, shared annotations. The rest of the stack
is [system-design.md](system-design.md) §3.

| Package | We use | Why |
|---|---|---|
| `yjs` ^13.6 | `Y.Doc` (one per session), `Y.Map` (annotations keyed by id, plain-JSON values), `Y.encodeStateAsUpdate` (server-side size guard and validation) | A CRDT merges concurrent edits without a central authority, so there is no server-side merge or operational-transform logic to maintain. It also collapses the offline case: the `Y.Doc` exists from mount, and "local mode" is the same code path with no provider attached — not a separate branch |
| `@hocuspocus/provider` ^4.4 | `HocuspocusProvider`; `provider.setAwarenessField(…)` for user identity, cursor and `activeAnnotationId`; `provider.awareness` for peer ids | The WebSocket client for the Yjs sync protocol: connection, reconnect and resync. It also carries **awareness** — ephemeral per-client state that is broadcast to peers but never written into the document, which is exactly what live cursors and presence need. The alternative is hand-rolling the sync protocol over a raw socket |

A **CRDT** is a data structure whose updates merge to the same result whatever
order they arrive in. That property is what removes the need for a server to
decide whose edit came first.

## Client

The decision that shapes everything: **annotations live in a `Y.Doc` from app
mount, not from room join**. "Local mode" is that same doc with no provider
attached. Joining a room attaches a provider to the *same* doc, so Yjs's initial
sync merges pre-existing local annotations into the room. Ids are UUIDs, so
nothing collides.

This is why there is no "upload my drawings" step and no second code path for
working alone.

[use-collab.ts](../src/hooks/use-collab.ts) owns the lifecycle. Live cursors and
"who is looking at which annotation" are **Yjs Awareness** state — broadcast to
peers, never written to the document, so nothing survives a disconnect. Two
rate limits keep it cheap: cursor updates throttle to ~25 Hz with a trailing
send so the final resting position always arrives, and awareness→React updates
are batched per animation frame, otherwise several peers would trigger hundreds
of re-renders a second.

Identity ([collab-identity.ts](../src/lib/collab-identity.ts)) is a
`localStorage`-persisted pseudonym drawn from a Dutch flora/fauna list plus a
colour. **Nothing is verified** — names are self-chosen.

Conflict semantics: `update` replaces the whole per-annotation value, so
concurrent edits to the *same* annotation are last-writer-wins. Accepted for
now, and rare in practice because the active-annotation highlight shows who is
working on what. Edits to *different* annotations always merge correctly.

## Server

[collab-server/](../collab-server/) is a Hocuspocus (Yjs) WebSocket server with
SQLite persistence — 7 TypeScript modules and the repo's only automated tests
(16, via `node:test`).

**Security model: capability URLs.** The unguessable room UUID in the share link
is the only key. `onConnect` rejects any document name that is not a UUID, so
arbitrary names cannot be probed, and **no endpoint lists rooms**. The id
travels in the URL *hash fragment*, which browsers never send to servers, so it
stays out of access logs and `Referer` headers.

Documented limitations: anyone with the link has full read+write, author names
are unverified, and the SQLite file is plaintext. Treat the link as equivalent
to the room's contents.

**Guards** run server-side because that is the only place they hold: a client
can call the Yjs API directly and bypass any browser-side throttle. Every limit
is env-tunable; defaults from [config.ts](../collab-server/src/config.ts):

| Guard | Mechanism | Default |
|---|---|---|
| P0 document size | Reject oversized doc in `onStoreDocument` | 2 MB |
| P1 content caps | Per-annotation validation | 300 annotations, 200-char title, 2000-char description, 500 polygon points, 128 KB snapshot |
| P2 flood limiter | Sliding window on bytes and message count | 10 s window, 8 MB, 2000 messages |
| P3 room TTL + GC | Activity sidecar table, periodic delete + `VACUUM` | 90 days, daily |
| P4 size monitoring | Warn past DB file threshold | 512 MB |

**A load-bearing constraint:** Hocuspocus runs `onStoreDocument` as a sequential
promise chain ordered by `priority`, and a throw aborts the rest.
`GuardExtension.priority = 1000` (default 100) so validation runs **before** the
SQLite extension writes. A server-config hook would not work — config hooks are
appended last, by which point the bad document is already on disk.

Because a CRDT update is already merged into the in-memory document by the time
any hook runs, a validation failure aborts the *persist*; it cannot undo the
edit. The guards keep the stored data sound, not the live view.

---

## See also

| For | Read |
|---|---|
| Running the server, its guards and operations | [collab-server/README.md](../collab-server/README.md) |
| The annotation tool itself (shapes, direct manipulation, session snapshots) | [system-design.md](system-design.md) §9 |
