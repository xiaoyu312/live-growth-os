# Live Growth OS

[中文](README.md)

Author projects and updates: [X](https://x.com/liu_xiaoyu27334) · [FateClear](https://fateclear.com), a free birthday charting and interpretation website.

A local operations workspace connecting livestream metrics, transcripts, product context and human actions. Recommendations retain evidence, validity windows, missing-data states and manual confirmation.

This source edition retains the original **Next.js web app, Fastify server, Chrome extension, Electron desktop app and shared contracts/rules**. Internal real-session playback and its dedicated evaluation flow are explicitly unavailable; private records, transcripts, application presets and installers are omitted.

Status: **Experimental public source edition**. Source closure and bounded offline checks are complete. Clean installation, full semantic typechecking, the complete unit suite, application builds and startup remain unverified.

## Source scope

The workspace includes event validation/deduplication, live state and time-window calculations, operator rules, source-health recovery, product settings, review interfaces, the browser capture flow, official API integration boundaries and desktop process/navigation isolation. Memory storage is the development default; PostgreSQL interfaces and desktop SQLite storage remain in source.

Historical rule coefficients and reference speech were removed wholesale. Public rule defaults and time profiles are independently synthetic; they are not business benchmarks. The original algorithms remain. `analyzeRules` accepts optional caller-provided rule configuration. Domain-specific ASR vocabulary is empty by default, and the reference script contains generic synthetic points.

## Local synthetic demo

Requires Node.js 24+ and pnpm 10.33.0. These are the delivered usage commands; installation and application startup were not performed during preparation.

```sh
pnpm install --frozen-lockfile
pnpm demo:generate
pnpm dev
```

Open `http://127.0.0.1:3000/lab` or `/mvp` and explicitly start a synthetic scenario. The server uses `http://127.0.0.1:4100` and memory storage. Data is not durable. Legacy real-session APIs report that the internal data is not included; synthetic records never impersonate those recordings.

```sh
pnpm check:public
node --test apps/desktop/tests/*.test.cjs
pnpm typecheck
pnpm test
pnpm build
```

The first two checks ran successfully. The last three require the full dependency tree and were not run. Original scenario-trigger tests need particular attention after replacing internal thresholds with independent public examples.

## Optional connected operation

The extension can capture metrics and optional audio from platform pages the user explicitly connects and is authorized to access. It is not always offline. Official Qianchuan authorization, ASR, LLM services and workbook import require the user's own settings and permissions. No credentials or account authorizations are bundled, and advice does not automatically operate an ad account.

`.env.example` contains blank integration values. The memory demo does not require it. Persistent operation requires the user's database and Redis configuration followed by `pnpm db:migrate`. Workbook import needs `HISTORY_REGISTER_URL` and a separately installed `lark-cli` on `PATH`, authenticated and authorized by the user for their account and target workbook. This CLI is not included in the repository. Daily synchronization additionally requires `HISTORY_DAILY_SYNC=1`. Keep configuration, runtime data and recordings private.

Build the extension with `pnpm --filter @live-growth/extension build`, then load its `dist` using the browser's developer mode. Build desktop runtime with `pnpm desktop:build`, then run `pnpm --filter @live-growth/desktop start`. `desktop:pack:mac` and `desktop:pack:win` are packaging entrypoints, not verified installer deliverables. Review bundled dependency notices before distributing binaries.

## Validation and licensing

Passed: 13 offline behavior/desktop mock tests; syntax and literal relative-import checks for 176 TypeScript files; extension manifest validation. Not verified: complete Vitest tests, semantic typechecking, clean install/build/startup, browser rendering, actual platform calls, packaging or business results. Static scans are bounded evidence, not a guarantee.

No databases, orders, customer records, private workbook URLs, historical metrics, source recordings/transcripts, original calibration data, account presets, Git history or installed dependencies are included. [Synthetic example provenance](examples/README.md) is separate from the application source classification.

Self-authored code is [MIT](LICENSE); dependencies retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE-STATUS.md](LICENSE-STATUS.md). Publishing this source does not certify installers or production deployment.

If this project is useful to you, follow the author’s project updates on [X](https://x.com/liu_xiaoyu27334), or explore [FateClear](https://fateclear.com).
