// Single-file build for the MCP App resource. The host (e.g. Claude.ai)
// fetches the resulting HTML once via `resources/read` and renders it
// inside its sandboxed proxy iframe. We externalise heavy deps (React,
// Excalidraw, ext-apps SDK) to esm.sh so the bundle stays small (~10–20 KB
// of glue + an importmap), and the host's CSP only needs to allow our
// canvas origin + esm.sh.
//
// Output: ../dist/mcp-app/index.html (single file, no chunks).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Pinned versions — update in lockstep with mcp-app/package.json so the
// type signatures and runtime modules agree.
const ESM_REACT = 'https://esm.sh/react@19.0.0';
const ESM_REACT_DOM = 'https://esm.sh/react-dom@19.0.0?deps=react@19.0.0';
const ESM_REACT_DOM_CLIENT = 'https://esm.sh/react-dom@19.0.0/client?deps=react@19.0.0';
const ESM_REACT_JSX_RUNTIME = 'https://esm.sh/react@19.0.0/jsx-runtime';
const ESM_EXCALIDRAW = 'https://esm.sh/@excalidraw/excalidraw@0.18.0?deps=react@19.0.0,react-dom@19.0.0';
// ext-apps's peerDeps include zod ^3.25 || ^4. We pin to 3.25.76 because:
//  - The MCP SDK (transitive peerDep of ext-apps) does `import * as z from
//    'zod/v4'` and then calls `z.custom(...)`. The /v4 preview module in
//    zod 3.25 still exports `custom`, but the real zod 4.4 export removed it
//    (`z.custom` is undefined → "TypeError: t.custom is not a function").
//  - 3.25.x is in the SDK's accepted range and ships the /v4 preview that
//    the SDK was actually built against.
// We list zod AND the SDK in deps so esm.sh's transitive resolver pins both.
// Without the SDK in deps, esm.sh auto-resolved it with the latest zod (4.4.3)
// even though we'd pinned zod for ext-apps directly.
const ESM_EXT_APPS_REACT = 'https://esm.sh/@modelcontextprotocol/ext-apps@1.7.1/react?deps=react@19.0.0,react-dom@19.0.0,zod@3.25.76,@modelcontextprotocol/sdk@1.29.0';
const ESM_ZOD = 'https://esm.sh/zod@3.25.76';
const ESM_ZOD_V4 = 'https://esm.sh/zod@3.25.76/v4';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: path.resolve(here, '../dist/mcp-app'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: path.resolve(here, 'index.html'),
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        '@excalidraw/excalidraw',
        '@modelcontextprotocol/ext-apps/react',
        'zod',
        'zod/v4'
      ],
      output: {
        // Rewrite bare imports in the bundled JS to esm.sh URLs so the
        // browser can resolve them at runtime via the importmap below.
        paths: {
          'react': ESM_REACT,
          'react-dom': ESM_REACT_DOM,
          'react-dom/client': ESM_REACT_DOM_CLIENT,
          'react/jsx-runtime': ESM_REACT_JSX_RUNTIME,
          '@excalidraw/excalidraw': ESM_EXCALIDRAW,
          '@modelcontextprotocol/ext-apps/react': ESM_EXT_APPS_REACT,
          'zod': ESM_ZOD,
          'zod/v4': ESM_ZOD_V4
        }
      }
    }
  }
});
