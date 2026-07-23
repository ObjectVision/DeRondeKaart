# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Prerequisites

- Node.js 20+ and npm

Install dependencies:

```bash
npm install 
```

## Running locally

Start the Vite dev server with HMR:

```bash
npm run dev
```

The app is served at http://localhost:5173 by default.

## Production build

Type-check and bundle the app into `dist/`:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## URL parameters

The map is driven by URL hash parameters (everything after `#`). Hash params are processed on load and whenever the hash changes — embeds can mutate the iframe's `src` to push new commands without reloading. The hash is cleared after processing.

The same commands can also be sent via `postMessage` to the iframe (see `test-embed.html`); the parameter names match the URL form.

### Layer commands

Layer commands come as three index-aligned, repeating parameters:

| Param | Required for | Values |
|---|---|---|
| `cmd` | all | `add`, `remove`, `hide`, `refresh` |
| `map` | add/remove/hide | `a` or `b` (defaults to `a` if omitted) |
| `layer` | add/remove/hide | a layer `id` from `public/layers.json` |

The Nth `cmd` pairs with the Nth `map` and Nth `layer`. Commands are applied in order.

**Examples**

Add the Wijken layer to map A on load:

```
http://localhost:5173/#cmd=add&map=a&layer=gemeente
```

Add a layer to each side — comparison mode activates automatically:

```
http://localhost:5173/#cmd=add&map=a&layer=gemeente&cmd=add&map=b&layer=wijken-limburg-parquet
```

Remove a layer:

```
http://localhost:5173/#cmd=remove&map=a&layer=gemeente
```

Hide a layer (keeps it loaded but invisible — toggle from the legend to re-show):

```
http://localhost:5173/#cmd=hide&map=a&layer=gemeente
```

Force a full page reload (no `map`/`layer` needed):

```
http://localhost:5173/#cmd=refresh
```

### View commands

`zoom` and `center` set the camera. They can be combined with each other and with layer commands.

| Param | Format | Range |
|---|---|---|
| `zoom` | number | `0`–`22` |
| `center` | `lng,lat` | lng `-180`–`180`, lat `-85.05`–`85.05` |

**Examples**

Zoom to 10:

```
http://localhost:5173/#zoom=10
```

Center on Maastricht:

```
http://localhost:5173/#center=5.69,50.85
```

Add a layer and frame Limburg in one URL:

```
http://localhost:5173/#cmd=add&map=a&layer=gemeente&zoom=9&center=5.7,51.0
```

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
