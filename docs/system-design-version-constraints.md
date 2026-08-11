# De Ronde kaart — Version constraints

**Audience:** developers and maintainers. Companion to
[system-design.md](system-design.md) §3, whose "Version constraints worth
knowing" subsection this file replaces in full.

**Read this before upgrading `maplibre-gl` or `typescript`.** Both are held back
deliberately, and both fail in ways that are easy to misread: the MapLibre one
produces a blank map with no console error, and the TypeScript one looks like a
version guard you could switch off. Neither is a matter of taste.

---

## `maplibre-gl` is on v6

Two details are load-bearing and easy to undo by accident.

### `setWorkerUrl` + the `?worker&url` import must stay

Both are in [MapView.tsx](../src/components/map/MapView.tsx).

MapLibre parses tiles in a Web Worker. In v6 that worker is a separate ESM file,
located relative to the module URL. Vite's dependency optimizer rewrites the
entry into `.vite/deps/`, where the worker file does not exist — so it 404s and
no tile is ever parsed. `setWorkerUrl` tells it where the file actually is.

The import suffix matters as much as the call. The worker itself imports
`./maplibre-gl-shared.mjs`, so a bare `?url` copies one file and leaves that
import dangling. That works in dev and ships a **production build whose worker
boots and dies instantly**. `?worker&url` makes Vite bundle the worker with its
dependencies.

Both failure modes are a blank map with **no error in the console**, and one of
them only appears in a production build. Test with `npm run build` +
`vite preview`, not just dev.

### `zoomLevelsToOverscale={undefined}` must stay

See [system-design.md](system-design.md) §6.3 for the measurement and the
reasoning.

---

## TypeScript is held at 5.x

Blocked by `typescript-eslint`. Worth stating precisely, because it is not a
conservative version guard that could be configured away.

**What actually breaks.** TS 7's npm package exports exactly **two** symbols
(`version`, `versionMajorMinor`). The compiler is a Go binary, and the JS API —
`createSourceFile`, `SyntaxKind`, `forEachChild`, `createProgram` — is simply
absent until **TS 7.1**. `@typescript-eslint/parser` calls dozens of those, so it
throws unconditionally on load (`"typescript-eslint does not support TS 7.0"`).

**The version-range check is a red herring.** The separate TS-*version-range*
check (`>=4.8.4 <6.1.0`) defaults to `warn`, not `error`, and is overridable via
`onUnsupportedTypeScriptVersion`. It is **not** what blocks the upgrade, so
don't lose time on it.

**Dropping `typescript-eslint` is not the trade it looks like.** It is not 20 TS
rules in exchange for TS 7: it is the only TypeScript **parser**, so ESLint
could not read `.ts`/`.tsx` at all and *every* rule would stop running —
including `eslint-plugin-react-hooks`, which has caught real bugs here (the
"cannot update ref during render" class). Measured: TS 7 cuts `tsc -b` from
~3.0s to ~0.2s, which is ~20% of a 14.2s build whose slowest step is ~9s of
brotli/font work. Not worth every lint rule in the project.

**Nothing here reaches the shipped bundle.** `tsconfig.app.json` sets `noEmit`,
esbuild does all transpilation, and `typescript` is a devDependency. The
constraint costs developers a faster typecheck and costs users nothing.
