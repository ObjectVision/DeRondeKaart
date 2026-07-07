# Power BI embedding: `frame-ancestors` / null-origin blocker

## Symptom

Embedding the app in the custom visual fails with either:

```
Framing 'https://map.woonzorglimburg.nl/' violates the following Content Security
Policy directive: "frame-ancestors https://map... https://app.powerbi.com ...".
```

or, after trying the wildcard:

```
... violates the following Content Security Policy directive: "frame-ancestors *".
Note that '*' matches only URLs with network schemes ('http','https','ws','wss'),
or URLs whose scheme matches self's scheme. The scheme 'https:' must be added
explicitly.
```

## Root cause (definitive)

Power BI hosts every custom visual in a sandbox iframe:

```
<iframe src="https://app.powerbi.com/.../cvSandboxPack.html"
        sandbox="allow-scripts">   <!-- NO allow-same-origin -->
```

`sandbox="allow-scripts"` **without `allow-same-origin`** forces the sandbox
document to an **opaque (null) origin**, even though it loads from an
`app.powerbi.com` URL. Our visual's nested `<iframe src="…map.woonzorglimburg.nl">`
therefore has an **opaque-origin immediate ancestor**.

`Content-Security-Policy: frame-ancestors` matches by origin. An opaque origin has
no host and no network scheme, so **no `frame-ancestors` value can admit it —
including `*`** (the wildcard only covers `http/https/ws/wss`, per the browser's
own note). This is why every `frame-ancestors` variant is blocked.

**This is architectural, not a tunable header.** The app's server is currently
*sending* a `frame-ancestors` directive; any such directive blocks the null-origin
sandbox.

## The only iframe-side fix

The app host must send **no framing restriction at all** for the app URL:

- Remove the `Content-Security-Policy: frame-ancestors …` directive entirely
  (an *absent* `frame-ancestors` = no ancestor restriction, which permits the
  opaque-origin framer).
- Also ensure **no** `X-Frame-Options` header (that header has no wildcard and
  always blocks a cross/opaque-origin framer).

i.e. serve `map.woonzorglimburg.nl/app/` with neither `frame-ancestors` nor
`X-Frame-Options`. This is how the "HTML Content" family of visuals embed
external sites — they only work for hosts that impose no framing restriction.

If a CSP is required for other reasons, keep the other directives but **drop
`frame-ancestors`** specifically (do not try to list an origin or `*` — both fail
for the opaque sandbox).

## Trade-off / alternative

Dropping `frame-ancestors` means the app can be framed by *anyone*, not just
Power BI. If that clickjacking exposure is unacceptable, the iframe-wrapper
approach is not viable and the alternative is to bundle the map app *into* the
`.pbiviz` itself (self-contained visual, no nested iframe) — a much larger effort
(port the Vite app into the pbiviz webpack toolchain).

---

# Gate 3: asset CORS from the null-origin document

## Symptom

After framing succeeds, the app's own bundle requests fail:

```
Access to script at '.../assets/index-*.js' from origin 'null' has been blocked
by CORS policy: No 'Access-Control-Allow-Origin' header is present.
Access to CSS stylesheet at '.../assets/index-*.css' from origin 'null' ... (same)
```

## Root cause

Inside the sandbox the document runs at an **opaque (null) origin**, so a request
for a *same-host* asset (`map.woonzorglimburg.nl` → `map.woonzorglimburg.nl/assets/…`)
is now **cross-origin** (`null` ≠ `https://map…`). Two things then require CORS:

- **ES module scripts** (`<script type="module">`) are **always** fetched in CORS
  mode *by spec*, regardless of the `crossorigin` attribute. So the JS bundle
  demands `Access-Control-Allow-Origin` no matter what.
- Vite additionally emits `crossorigin` on the `<script>` and `<link
  rel="stylesheet">` tags, which puts the **CSS** into CORS mode too.

Because a build-only change can drop `crossorigin` from the CSS but **cannot**
stop the module system from CORS-fetching the JS, this **must** be fixed on the
server. There is no repo-only fix while the app loads as ES modules under a null
origin.

## Fix (server-side, required)

Serve the app's static assets with:

```
Access-Control-Allow-Origin: *
```

on `/assets/*` (or the whole app path). This satisfies the CORS check for both the
module JS and the CSS. Unlike dropping `frame-ancestors`, `ACAO: *` on read-only
static JS/CSS/font/tile assets is benign — those bytes are already publicly
fetchable by URL.

### nginx gotcha: `add_header` does NOT merge across blocks

A `server`-level `add_header Access-Control-Allow-Origin "*" always;` is **silently
discarded** on any response whose `location` block has its *own* `add_header`
(nginx replaces, never merges: inner `add_header` set wins entirely). A Vite
`/assets/` block that sets cache headers (`expires 1y; add_header Cache-Control
"public, immutable";`) therefore drops the server-level CORS header — the HTML at
`/app/` gets the header but `/assets/*.js|.css` do not.

Tell-tale: the asset response shows **two `Cache-Control` headers** (one from the
block, one inherited) but **no** `Access-Control-Allow-Origin`, while `/app/` has
it. Verify with:

```
curl -sSI https://map.woonzorglimburg.nl/assets/index-*.css | grep -i access-control
```

**Fix:** add the CORS header *inside the asset `location` block itself* (the one
with `immutable`/`expires`):

```nginx
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    add_header Access-Control-Allow-Origin "*" always;   # must be repeated here
}
```

Then `nginx -t && systemctl reload nginx` and hard-refresh (assets are
`immutable`-cached; append `?v=2` to bust if a stale no-CORS copy is cached).

## Summary of all three gates

The app URL served to the Power BI custom visual must, for its whole path:
1. be listed in the visual's `WebAccess` privilege (capabilities.json) — CSP host,
2. send **no** `X-Frame-Options` and **no** `frame-ancestors` — framing,
3. send `Access-Control-Allow-Origin: *` on assets — CORS from null origin.