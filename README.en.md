[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

# Live Growth OS

**Bring livestream metrics, transcripts and product context into one workspace, with evidence and validity windows attached to recommendations.**

Live Growth OS is a local workspace for livestream operations teams and developers. Rules and state machines combine incoming metrics, transcripts and product context with time windows and missing-data states to produce recommendations for human confirmation. Start with the repository's synthetic scenarios to explore the flow.

This source edition retains the original **Next.js web app, Fastify server, Chrome extension, Electron desktop app and shared contracts/rules**. Internal real-session playback and its dedicated evaluation flow are explicitly unavailable; business records, original speech/transcripts, account presets and installers are omitted. Status: **Experimental public source edition**. Source closure and bounded offline checks were completed during source preparation. Clean installation, full semantic typechecking, the complete test suite, application builds and startup remain unverified.

More from the author: [FateClear](https://fateclear.com) · [Project updates on X](https://x.com/liu_xiaoyu27334)

## Preview the existing synthetic scenarios

The repository includes [scenario data](examples/synthetic-scenarios.json) and its [generator](scripts/generate-synthetic-demo.mjs). This excerpt of the existing JSON shows the provenance marker and fixed seed; it is not an operational result:

```json
{
  "classification": "independently_synthetic",
  "seed": 20300101,
  "startAt": "2030-01-01T00:00:00.000Z"
}
```

`sampleSize: 0` in the scenarios means there are no historical observations. The generator uses fixed literals and a seed, reads no outside files and makes no network calls. It recreates `examples/synthetic-scenarios.json` and `packages/source-adapters/src/calibrations/historical.ts`; legacy export names exist only for source compatibility. Example prices and GMV are independently chosen fictional round numbers, not anonymized real orders. See the [synthetic example provenance](examples/README.md).

## Quickest entry: local synthetic demo

Requires Node.js 24+ and pnpm 10.33.0. Run these commands from the repository root. They are usage instructions; **no dependencies were installed and no application was started during this documentation pass**:

```sh
pnpm install --frozen-lockfile
pnpm demo:generate
pnpm dev
```

The frontend defaults to `http://127.0.0.1:3000` and the server to `http://127.0.0.1:4100`. `dev` explicitly uses memory storage. Open `http://127.0.0.1:3000/lab` or `/mvp`, select a synthetic scenario and start it. Memory data is not guaranteed to survive a refresh or exit. Legacy real-session options do not load automatically; their APIs report that the internal data is not included, rather than presenting synthetic records as real recordings.

## Included capabilities

- Next.js workspace: livestream state, source health, operator rules, synthetic scenarios, product settings and review interfaces.
- Fastify server: event validation/deduplication, memory demos and PostgreSQL persistence interfaces; desktop uses SQLite.
- Deterministic rules, state machines, time-window aggregation, missing-value and evidence checks, human confirmation and rate-limited recovery.
- Chrome extension: metrics capture and optional audio flows on authorized 罗盘 / 千川 pages that the user explicitly connects.
- Electron startup, child-process isolation, navigation restrictions and source packaging scripts; no prebuilt binaries.
- Configurable adapters for official APIs, ASR, LLM services and workbook history import. Unconfigured services are not requested automatically.

Historical business-rule coefficients and original reference speech were removed wholesale. Public rule defaults and legacy time-profile exports are independently synthetic; they are not historical statistics, industry benchmarks or validated operating strategies. The original algorithms remain, and `analyzeRules` accepts caller-provided rule configuration. The reference script contains generic synthetic points, and domain-specific ASR vocabulary is empty by default.

## Optional connected operation and desktop

Real capture requires the user to explicitly connect platform pages they are authorized to access. The extension can process real metrics or optional audio after authorization; **it is not always offline**. Official Qianchuan authorization, ASR, LLM services and workbook import require the user's own settings and permissions. No credentials or account authorizations are bundled, and recommendations do not automatically operate an ad account or carry out actions.

`.env.example` contains blank integration values. The memory demo does not require it. Persistent operation requires the user's database and Redis configuration followed by `pnpm db:migrate`. Keep environment files, recordings and runtime directories out of Git. Workbook import needs an explicit `HISTORY_REGISTER_URL` and a separately installed `lark-cli` on `PATH`, authenticated and authorized by the user for their account and target workbook. This CLI is not included. Daily synchronization additionally requires `HISTORY_DAILY_SYNC=1`.

Build the extension with `pnpm --filter @live-growth/extension build`, then load its `dist` using the browser's developer mode. Build desktop runtime with `pnpm desktop:build`, then run `pnpm --filter @live-growth/desktop start`. `desktop:pack:mac` and `desktop:pack:win` are packaging entrypoints; runtime behavior, signing, installation and platform connectivity have not been verified. Review bundled dependency notices before distributing binaries.

## Validation and maturity

These are the existing check commands. This pass reviewed documentation only and did not run application tests or builds:

```sh
pnpm check:public
node --test apps/desktop/tests/*.test.cjs
pnpm typecheck
pnpm test
pnpm build
```

The first two checks ran on the isolated candidate during source preparation. The last three require the full dependency tree and were not run then. Original scenario-trigger tests need particular attention after replacing internal thresholds with independent public examples.

Existing records: 13 offline behavior/desktop mock tests passed; syntax and literal relative-import checks covered 176 TypeScript files; extension manifest validation passed. Not verified: full semantic typechecking, the original Vitest suite, clean install/build/startup, browser rendering, actual platform calls, desktop packaging or business results. Static scans provide bounded evidence, not a guarantee that no unknown sensitive values remain.

## Details and data boundaries

- [Synthetic example provenance](examples/README.md): fixed seed, zero historical observations and example scope.
- [Root scripts](package.json): development, demo, build, checks and desktop packaging entrypoints.
- [Public-source checks](tests/public-source.test.mjs): coverage of existing offline checks.
- [Third-party notices](THIRD_PARTY_NOTICES.md) and [license scope](LICENSE-STATUS.md): dependency and self-authored source boundaries.

No original databases, orders, customer records, private workbook URLs, business reports, source recordings/transcripts, historical calibration values, private assets, account presets, Git history or installed dependencies are included. Only generated example values and new generic reference/rule defaults have independent synthetic provenance; the full repository remains application source with optional online adapters.

## License and author

Self-authored code is [MIT](LICENSE); dependencies retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE-STATUS.md](LICENSE-STATUS.md). Publishing this source does not certify installers or production deployment.

Try [FateClear](https://fateclear.com) for free birthday charting and interpretation, or follow the author's new projects and updates on [X](https://x.com/liu_xiaoyu27334).
