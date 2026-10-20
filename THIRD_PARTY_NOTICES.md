# Third-party dependencies

This source distribution includes dependency declarations and the original pnpm lockfile, not copies of installed third-party packages. Dependencies are not relicensed by this repository's MIT license. Installations and compiled bundles must retain their upstream notices.

The dependency versions below come from the source workspace manifests. Versions were not upgraded. Upstream code was not fetched, installed, audited or executed during preparation. This is a dependency inventory, not a certification that every transitive license has been verified.

| Package | Declared version |
| --- | --- |
| `@eslint/js` | `9.31.0` |
| `@fastify/cors` | `11.0.1` |
| `@fastify/websocket` | `11.0.1` |
| `@playwright/test` | `1.54.1` |
| `@types/node` | `22.16.5` |
| `@types/react` | `19.1.8` |
| `@types/react-dom` | `19.1.6` |
| `@types/ws` | `8.18.1` |
| `electron` | `44.3.0` |
| `electron-builder` | `26.15.3` |
| `esbuild` | `0.25.12` |
| `eslint` | `9.31.0` |
| `fastify` | `5.4.0` |
| `ioredis` | `5.6.1` |
| `next` | `16.2.12` |
| `postgres` | `3.4.7` |
| `react` | `19.1.0` |
| `react-dom` | `19.1.0` |
| `tsx` | `4.20.3` |
| `typescript` | `5.8.3` |
| `typescript-eslint` | `8.38.0` |
| `vitest` | `3.2.4` |
| `ws` | `8.18.3` |
| `zod` | `3.25.76` |

Electron's Chromium/Node components, Next.js, React, Fastify, PostgreSQL/Redis clients, Zod, esbuild and build/test tooling may carry additional component notices. Inspect the actually installed packages before binary distribution. The backend bundle built by `scripts/desktop/build.mjs` and the extension bundles built by `apps/extension/scripts/build.mjs` use esbuild's `legalComments: "eof"` to retain recognized legal comments at the end of each bundle. The desktop build also filters all `.env*` files and application presets. These source settings do not establish that all required license files or notices are present in a finished installer; complete installer-specific license and secret-content verification remains unperformed.
