import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORY_CAPTURE_SHEET_NAME,
  HISTORY_LIVE_REGISTER_WIKI_URL,
  liveRegisterSheetNames,
  type HistoricalHistoryFetchResult,
  type HistoricalHistoryFetcher,
  type HistoricalHistorySheetPayload
} from "@live-growth/source-adapters";

const LARK_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
} as const;

export function findRepoRoot(start = fileURLToPath(new URL(".", import.meta.url))): string {
  let dir = start;
  for (let index = 0; index < 8; index += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export function defaultHistoricalHistoryCacheDir(): string {
  return process.env.HISTORY_CACHE_DIR ?? join(findRepoRoot(), ".cache/historical-hours");
}

export function columnLetter(index0: number): string {
  let n = index0 + 1;
  let text = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    text = String.fromCharCode(65 + rem) + text;
    n = Math.floor((n - 1) / 26);
  }
  return text;
}

export function parseCsvRecords(csv: string): string[][] {
  const rows: string[][] = [[]];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    const next = csv[index + 1];
    if (inQuotes) {
      if (char === "\"" && next === "\"") { current += "\""; index += 1; continue; }
      if (char === "\"") { inQuotes = false; continue; }
      current += char;
      continue;
    }
    if (char === "\"") { inQuotes = true; continue; }
    if (char === ",") {
      rows[rows.length - 1]!.push(current);
      current = "";
      continue;
    }
    if (char === "\n" || (char === "\r" && next === "\n")) {
      if (char === "\r") index += 1;
      rows[rows.length - 1]!.push(current);
      current = "";
      rows.push([]);
      continue;
    }
    if (char !== "\r") current += char;
  }
  rows[rows.length - 1]!.push(current);
  if (rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === "") rows.pop();
  return rows;
}

export function parseAnnotatedCsv(annotated: string): { rowNumber: number; cells: string[] }[] {
  return parseCsvRecords(annotated).flatMap((cells) => {
    if (cells.length === 0) return [];
    const first = cells[0] ?? "";
    const match = first.match(/^\[row=(\d+)\](?: ([\s\S]*))?$/);
    if (!match) return [{ rowNumber: 0, cells }];
    const restFirst = match[2] ?? "";
    return [{ rowNumber: Number(match[1]), cells: [restFirst, ...cells.slice(1)] }];
  }).filter((item) => item.rowNumber > 0);
}

export function rowsFromAnnotatedRecords(records: { rowNumber: number; cells: string[] }[]): string[][] {
  const maxRow = records.reduce((max, item) => Math.max(max, item.rowNumber), 0);
  const rows: string[][] = Array.from({ length: maxRow }, () => []);
  for (const item of records) rows[item.rowNumber - 1] = item.cells;
  return rows;
}

function unwrapLarkData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === "object") return root.data as Record<string, unknown>;
  return root;
}

function regionLastRow(region: string | undefined, fallback: number): number {
  if (!region) return fallback;
  const match = region.match(/:[A-Z]+(\d+)$/i);
  return match ? Number(match[1]) : fallback;
}

export async function runLarkCli(args: string[], outputPath?: string): Promise<unknown> {
  if (args.some((arg) => /\+(csv-put|cells-set|table-put|batch-update|sheet-delete|cells-clear)/.test(arg))) {
    throw new Error("历史同步只允许飞书只读命令");
  }
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  await mkdir(dirname(outputPath ?? join(defaultHistoricalHistoryCacheDir(), "lark-stdout.json")), { recursive: true });
  const child = spawn("lark-cli", args, {
    env: { ...process.env, ...LARK_ENV },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (outputPath) await writeFile(outputPath, stdout, "utf8");
  if (exitCode !== 0) {
    throw new Error(sanitizeLarkError(`lark-cli 失败（exit ${exitCode}）${stderr ? `：${stderr.slice(0, 180)}` : ""}`));
  }
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("lark-cli 返回不是 JSON");
  }
}

export function sanitizeLarkError(message: string): string {
  return message
    .replace(/(?:https?:\/\/)[^\s"'`]+/gi, "[已隐藏地址]")
    .replace(/\b(token|authorization|secret|password)(\s*[=:]\s*)[^\s,}]+/gi, "$1$2[已隐藏]")
    .replace(/(?:\/(?:Users|private|home|tmp|var|opt|Volumes)\/[^\s"'`:,;]+)/gi, "[已隐藏路径]");
}

type WorkbookSheet = { title?: string; sheet_name?: string; sheet_id?: string; row_count?: number; column_count?: number; current_region?: string };

export async function fetchHistoricalHistorySheets(options: {
  asOfLocalDate: string;
  sheetNames: string[];
  wikiUrl?: string;
  cacheDir?: string;
  run?: typeof runLarkCli;
}): Promise<HistoricalHistoryFetchResult> {
  const wikiUrl = options.wikiUrl ?? HISTORY_LIVE_REGISTER_WIKI_URL;
  if (!wikiUrl) throw new Error("HISTORY_REGISTER_URL_NOT_CONFIGURED");
  const cacheDir = options.cacheDir ?? defaultHistoricalHistoryCacheDir();
  const run = options.run ?? runLarkCli;
  await mkdir(join(cacheDir, "raw"), { recursive: true });
  const workbook = unwrapLarkData(await run([
    "sheets", "+workbook-info", "--url", wikiUrl, "--as", "user", "--format", "json"
  ], join(cacheDir, "raw", "workbook-info.json")));
  const sheets = (Array.isArray(workbook.sheets) ? workbook.sheets : []) as WorkbookSheet[];
  const wantedRegister = liveRegisterSheetNames(options.asOfLocalDate);
  const registerSheets: HistoricalHistorySheetPayload[] = [];
  let capture: HistoricalHistorySheetPayload | undefined;
  for (const sheetName of options.sheetNames) {
    const meta = sheets.find((sheet) => sheet.sheet_name === sheetName || sheet.title === sheetName);
    if (!meta) {
      if (sheetName === HISTORY_CAPTURE_SHEET_NAME || wantedRegister.includes(sheetName)) {
        throw new Error(`直播登记缺少子表：${sheetName}`);
      }
      continue;
    }
    const payload = await fetchSheetMatrix({
      wikiUrl, sheetName, meta, cacheDir, run
    });
    if (sheetName === HISTORY_CAPTURE_SHEET_NAME) capture = payload;
    else registerSheets.push(payload);
  }
  return { registerSheets, ...(capture ? { capture } : {}) };
}

async function fetchSheetMatrix(input: {
  wikiUrl: string;
  sheetName: string;
  meta: WorkbookSheet;
  cacheDir: string;
  run: typeof runLarkCli;
}): Promise<HistoricalHistorySheetPayload> {
  const columnCount = Math.max(1, Number(input.meta.column_count ?? 50));
  const physicalRows = Math.max(1, Number(input.meta.row_count ?? 200));
  const regionEnd = regionLastRow(input.meta.current_region, physicalRows);
  const lastCol = columnLetter(columnCount - 1);
  const batchSize = 200;
  const records: { rowNumber: number; cells: string[] }[] = [];
  let emptyBatches = 0;
  let seenDates = false;
  let revision: number | undefined;
  for (let start = 1; start <= Math.min(physicalRows, Math.max(regionEnd, 400)); start += batchSize) {
    const end = Math.min(start + batchSize - 1, physicalRows);
    const range = `A${start}:${lastCol}${end}`;
    const file = join(input.cacheDir, "raw", `${safeSheetFile(input.sheetName)}-${start}.json`);
    const payload = unwrapLarkData(await input.run([
      "sheets", "+csv-get", "--url", input.wikiUrl, "--sheet-name", input.sheetName,
      "--range", range, "--as", "user", "--format", "json"
    ], file));
    if (typeof payload.revision === "number") revision = payload.revision;
    const annotated = typeof payload.annotated_csv === "string" ? payload.annotated_csv : "";
    const batch = parseAnnotatedCsv(annotated);
    const dated = batch.filter((item) => item.cells.some((cell) => /^\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(cell.trim())));
    if (dated.length > 0) { seenDates = true; emptyBatches = 0; }
    else if (seenDates) emptyBatches += 1;
    records.push(...batch);
    if (payload.has_more === false && end >= regionEnd && seenDates) break;
    if (emptyBatches >= 1) break;
  }
  return {
    sheetName: input.sheetName,
    rows: rowsFromAnnotatedRecords(records),
    ...(revision !== undefined ? { revision } : {})
  };
}

function safeSheetFile(sheetName: string): string {
  return sheetName.replace(/[^\w\u4e00-\u9fff-]+/g, "-").slice(0, 40);
}

export function createLarkHistoricalHistoryFetcher(options: { cacheDir?: string; wikiUrl?: string; run?: typeof runLarkCli } = {}): HistoricalHistoryFetcher {
  return (input) => fetchHistoricalHistorySheets({ ...input, ...options });
}
