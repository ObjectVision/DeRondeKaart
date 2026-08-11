# De Ronde kaart — Version constraints

**Audience:** developers and maintainers. Companion to
[system-design.md](system-design.md) §3, whose "Version constraints worth
knowing" subsection this file replaces in full.

**Read this before upgrading `maplibre-gl` or `typescript`.** Both constraints
below are load-bearing, and both fail in ways that are easy to misread: the
MapLibre one produces a blank map with no console error, and the TypeScript one
looks like a conservative version guard that could be configured away. Neither
is a matter of taste.

---

## `maplibre-gl` is on v6

Two things about it are load-bearing and easy to undo by accident:

- **`setWorkerUrl` + the `?worker&url` import must stay**
  ([MapView.tsx](../src/components/map/MapView.tsx)). v6 splits the worker
  into its own ESM file located relative to the module URL; Vite's
  dependency optimizer rewrites the entry into `.vite/deps/`, where that
  sibling does not exist, so the worker 404s and no tile is ever parsed.
  The import suffix matters as much as the call: the worker itself imports
  `./maplibre-gl-shared.mjs`, so a bare `?url` copies one file and leaves
  that import dangling — which works in dev but ships a **production build
  whose worker boots and dies instantly**. `?worker&url` makes Vite bundle
  the worker with its dependencies. Both failure modes are blank maps with
  **no error in the console**, so test `npm run build` + `vite preview`, not
  just dev.
- **`zoomLevelsToOverscale={undefined}` must stay** — see
  [system-design.md](system-design.md) §6.3.

---

## TypeScript is held at 5.x

Blocked by `typescript-eslint`. The mechanism is worth stating precisely,
because it is not a conservative version guard that could be configured away:

- TS 7's npm package exports exactly **two** symbols (`version`,
  `versionMajorMinor`). The compiler is a Go binary, and the JS API —
  `createSourceFile`, `SyntaxKind`, `forEachChild`, `createProgram` — is
  simply absent until **TS 7.1**. `@typescript-eslint/parser` calls dozens of
  those, so it throws unconditionally on load
  (`"typescript-eslint does not support TS 7.0"`).
- The separate TS-*version-range* check (`>=4.8.4 <6.1.0`) defaults to
  `warn`, not `error`, and is overridable via
  `onUnsupportedTypeScriptVersion`. It is **not** what blocks the upgrade.
- Dropping `typescript-eslint` does **not** trade 20 TS rules for TS 7: it
  removes the only TypeScript **parser**, so ESLint cannot read `.ts`/`.tsx`
  at all and *every* rule stops running — including
  `eslint-plugin-react-hooks`, which has caught real bugs here (the
  "cannot update ref during render" class). Measured: TS 7 cuts `tsc -b`
  from ~3.0s to ~0.2s, which is ~20% of a 14.2s build whose slowest step is
  ~9s of brotli/font work. Not a trade worth making.
- There is no runtime or bundle-size dimension to this: `tsconfig.app.json`
  sets `noEmit`, esbuild does all transpilation, and `typescript` is a
  devDependency absent from every shipped bundle.
