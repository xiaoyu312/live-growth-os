# Independent synthetic examples

`node scripts/generate-synthetic-demo.mjs` (from the repository root) recreates `examples/synthetic-scenarios.json` and `packages/source-adapters/src/calibrations/historical.ts` using fixed literals and seed `20300101`. It reads no outside files and makes no network calls. `sampleSize: 0` means there are no historical observations. Legacy export names exist only for source compatibility.

The simulator's public product prices and matching GMV amounts are independently chosen round-number examples. They are not anonymized real orders. The source file identifies these values explicitly. Generic scenario-generation algorithms are original source code.

The complete repository is application source with optional online adapters; it is not classified as a wholly offline synthetic demo package. Only the generated example values and new generic reference/rule defaults have independent synthetic provenance.
