import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnvConfig } from "@next/env";

let envLoaded = false;

function normalizeKeyValue(v: string): string | undefined {
  let s = v.replace(/^\uFEFF/, "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s.length > 0 ? s : undefined;
}

/** Parse a single KEY=value from .env-style file (no multiline values). */
export function readKeyFromEnvFile(filePath: string, keyName: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    if (k !== keyName) continue;
    let v = trimmed.slice(eq + 1).trim();
    if (!v.startsWith('"') && !v.startsWith("'")) {
      const hi = v.search(/\s+#/);
      if (hi !== -1) v = v.slice(0, hi).trim();
    }
    return normalizeKeyValue(v);
  }
  return undefined;
}

const FLIGHTAWARE_ENV_NAMES = new Set([
  "FLIGHTAWARE_API_KEY",
  "AEROAPI_KEY",
  "FLIGHTWARE_AEROAPI_KEY",
]);

/**
 * Whether a FlightAware key line exists in the file and if the value is non-empty (no secrets).
 */
function flightAwareKeyStatusInFile(filePath: string): "no_file" | "no_line" | "empty_value" | "set" {
  if (!fs.existsSync(filePath)) return "no_file";
  const text = fs.readFileSync(filePath, "utf8");
  let sawKeyLine = false;
  let anyNonEmpty = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^\uFEFF/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    if (!FLIGHTAWARE_ENV_NAMES.has(k)) continue;
    sawKeyLine = true;
    let v = trimmed.slice(eq + 1).trim();
    if (!v.startsWith('"') && !v.startsWith("'")) {
      const hi = v.search(/\s+#/);
      if (hi !== -1) v = v.slice(0, hi).trim();
    }
    const n = normalizeKeyValue(v);
    if (n) anyNonEmpty = true;
  }
  if (anyNonEmpty) return "set";
  if (sawKeyLine) return "empty_value";
  return "no_line";
}

/** Directory containing package.json + next.config.* (project root). */
function projectRootFromFileUrl(): string | undefined {
  try {
    const u = import.meta.url;
    if (!u?.startsWith("file:")) return undefined;
    let dir = path.dirname(fileURLToPath(u));
    for (let i = 0; i < 24; i++) {
      const pkg = path.join(dir, "package.json");
      const hasNext =
        fs.existsSync(path.join(dir, "next.config.ts")) ||
        fs.existsSync(path.join(dir, "next.config.mjs")) ||
        fs.existsSync(path.join(dir, "next.config.js"));
      if (fs.existsSync(pkg) && hasNext) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* noop */
  }
  return undefined;
}

function startingDirsForEnvWalk(): string[] {
  const dirs = new Set<string>();
  const fromMeta = projectRootFromFileUrl();
  if (fromMeta) dirs.add(fromMeta);
  dirs.add(path.resolve(process.cwd()));
  if (process.env.INIT_CWD) dirs.add(path.resolve(process.env.INIT_CWD));
  return [...dirs];
}

/**
 * Walk upward from each start dir looking for .env.local / .env (Next dev cwd is often wrong).
 */
function readKeyFromDiskFiles(): string | undefined {
  const names = [".env.local", ".env.development.local", ".env"] as const;
  for (const start of startingDirsForEnvWalk()) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 24; depth++) {
      for (const name of names) {
        const filePath = path.join(dir, name);
        const v =
          readKeyFromEnvFile(filePath, "FLIGHTAWARE_API_KEY") ??
          readKeyFromEnvFile(filePath, "AEROAPI_KEY") ??
          readKeyFromEnvFile(filePath, "FLIGHTWARE_AEROAPI_KEY");
        if (v) return v;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function ensureEnvFilesLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  const dev = process.env.NODE_ENV !== "production";
  const root = projectRootFromFileUrl() ?? process.cwd();
  loadEnvConfig(root, dev, console, true);
}

/**
 * AeroAPI key for server routes only (never NEXT_PUBLIC_).
 */
export function getFlightAwareApiKey(): string | undefined {
  const pick = () =>
    process.env.FLIGHTAWARE_API_KEY ??
    process.env.AEROAPI_KEY ??
    process.env.FLIGHTWARE_AEROAPI_KEY;

  let raw = pick();
  if (raw != null && String(raw).trim() !== "") {
    return normalizeKeyValue(String(raw));
  }

  const fromDisk = readKeyFromDiskFiles();
  if (fromDisk) return fromDisk;

  ensureEnvFilesLoaded();
  raw = pick();
  if (raw == null || String(raw).trim() === "") return undefined;
  return normalizeKeyValue(String(raw));
}

/** Dev-only diagnostics (no secrets). */
export function getFlightAwareEnvDebug(): Record<string, unknown> {
  const cwd = process.cwd();
  const fromMeta = projectRootFromFileUrl();
  const starts = startingDirsForEnvWalk();
  const tried: {
    start: string;
    envLocalPath: string;
    exists: boolean;
    keyParsed: boolean;
    flightAwareKeyStatus: ReturnType<typeof flightAwareKeyStatusInFile>;
  }[] = [];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 24; depth++) {
      const el = path.join(dir, ".env.local");
      const exists = fs.existsSync(el);
      if (exists) {
        const flightAwareKeyStatus = flightAwareKeyStatusInFile(el);
        const keyParsed =
          readKeyFromEnvFile(el, "FLIGHTAWARE_API_KEY") != null ||
          readKeyFromEnvFile(el, "AEROAPI_KEY") != null ||
          readKeyFromEnvFile(el, "FLIGHTWARE_AEROAPI_KEY") != null;
        tried.push({
          start,
          envLocalPath: el,
          exists: true,
          keyParsed,
          flightAwareKeyStatus,
        });
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {
    cwd,
    INIT_CWD: process.env.INIT_CWD ?? null,
    projectRootFromImportMeta: fromMeta ?? null,
    startsChecked: starts,
    envLocalScans: tried,
    hasProcessEnvFlightAware: Boolean(process.env.FLIGHTAWARE_API_KEY?.trim()),
  };
}
