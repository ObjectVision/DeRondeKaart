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


Access to script at 'https://map.woonzorglimburg.nl/assets/index-DFgHUS4B.js' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.