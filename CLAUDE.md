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

- Declare functions with the `function` keyword. Arrow functions are for inline callbacks and the bodies of `useCallback`/`useMemo` only.
- Every **exported** function carries an explicit return type annotation. Module-local helpers may rely on inference.
- When a hook returns more than a handful of members, declare a named result interface (`UseMapLayersResult`) rather than annotating an inline object type.

### React

- Props get a named `interface XProps` declared above the component. Never an inline object type in the parameter list.
- Components return `React.JSX.Element` (or `React.JSX.Element | null` when they can render nothing).

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
