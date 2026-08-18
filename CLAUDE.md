Don't interact with the git repository
Don't watermark text or files

## Code standards

These are the conventions the codebase already follows. Match them.

### Modules and imports

- ES modules only.
- Internal imports use the `@/` alias, without a file extension: `import { MapView } from "@/components/map/MapView"`. Relative imports are reserved for the few files outside the alias root (`main.tsx` importing `./App.tsx`).
- Order import blocks external-first, then `@/`. Within a block, no alphabetization is enforced — group by what the imports belong to.
- Use `import type` for type-only imports. `verbatimModuleSyntax` is on, so this is required, not stylistic.

### Functions

- Declare functions with the `function` keyword. Arrow functions are for inline callbacks, derived accessors (`const open = () => ...`) and the bodies of `createMemo`/`createEffect` only.
- Every **exported** function carries an explicit return type annotation. Module-local helpers may rely on inference.
- When a hook returns more than a handful of members, declare a named result interface (`UseMapLayersResult`) rather than annotating an inline object type.

### SolidJS

- **Never destructure props.** Solid props are getters; destructuring reads each one once, outside any tracking scope, and the component then silently never updates again. Read `props.x` at the point of use, or use `splitProps`/`mergeProps`. `solid/reactivity` is an ESLint **error** and is the automated guard for this — treat a report as a bug, and when it is a genuine false positive (an imperative MapLibre listener, a deliberate one-time seed) suppress it with a `-- why` on the line.
- Props get a named `interface XProps` declared above the component. Never an inline object type in the parameter list.
- Components return `JSX.Element` from `solid-js` (or `JSX.Element | null` when they can render nothing).
- Hooks take and return **accessors** (`Accessor<T>`), not snapshots — a caller must be able to pass state that does not exist yet (a map that has not mounted) without the hook re-running.
- Conditionals are `<Show>`, lists are `<For>` (`<Index>` when item identity is positional). There is no `key` prop: to force a fresh mount, mount the component inside a `<Show>` whose condition changes, or use `<Show keyed>`.
- Style objects are `JSX.CSSProperties`, which extends csstype's **hyphenated** properties: `{ "background-color": c }`, and lengths are strings (`` `${size}px` ``).
- `class`, not `className`; `onInput`, not `onChange`; `e.currentTarget.value`, not `e.target.value`.
- Binding a prop directly to a native element's event (`onClick={props.onClose}`) compiles to a static handler and will not see a later prop change — wrap it: `onClick={() => props.onClose?.()}`.
- There is no memoization tax to pay: no `useCallback`, no `React.memo`, no dependency arrays. Don't reintroduce them by hand.

### Control flow

- No nested ternaries. Use an `if`/`else` chain, a `switch`, or lift the branch into a named helper above the component. A single non-nested ternary inline in JSX is fine.
- Prefer an early `continue`/`return` over deepening a block.

### Error handling

- Reach for `try`/`catch` only where the platform API genuinely throws: `sessionStorage`/`localStorage` (private mode, quota), `JSON.parse`, network and worker calls.
- When a `catch` swallows the failure, add a comment saying why that is safe. See `src/lib/collab-identity.ts` for the pattern.
- Don't wrap code in `try`/`catch` defensively when nothing in it throws.

### Comments

- Comments explain *why*, not *what*. Don't restate what the line already says.
- Delete commented-out code rather than leaving it in place.

### Naming and language

- Identifiers, comments, and documentation in English.
- User-facing strings in Dutch — the UI is Dutch throughout (e.g. `"Naar linker kaart"` in `src/components/ui/legend.tsx`).

### Balance

Prefer explicit, readable code over compact code. Don't collapse a clear `if`/`else` into a dense expression, don't merge unrelated concerns into one function, and don't remove an abstraction that is genuinely organizing the code — fewer lines is not the goal.
