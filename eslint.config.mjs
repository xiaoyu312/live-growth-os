import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/.next-e2e/**", "**/.next-desktop/**", "**/.next-operator-e2e/**", "**/.next-qianchuan-e2e/**", "**/dist/**", "**/playwright-report/**", "**/test-results/**", "**/.tmp-m1-coverage/**", "**/.cache/**", "packaging/windows/extension/**"] },
  { ...eslint.configs.recommended, files: ["**/*.{js,mjs}"] },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["**/*.{ts,tsx}"] })),
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: {
        AbortController: "readonly", AbortSignal: "readonly", console: "readonly", fetch: "readonly",
        process: "readonly", setTimeout: "readonly", clearTimeout: "readonly", structuredClone: "readonly",
        URL: "readonly", WebSocket: "readonly", Headers: "readonly", RequestInit: "readonly", Intl: "readonly", Buffer: "readonly"
      }
    }
  }
);
