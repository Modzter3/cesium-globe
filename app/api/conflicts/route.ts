/**
 * /api/conflicts
 *
 * Primary source: GDELT 2.0 event export files — completely free, no key needed.
 * Upgrade path:   If ACLED_EMAIL + ACLED_PASSWORD are set in .env.local, ACLED is
 *                 used instead (higher quality data with fatality counts).
 *
 * GDELT files are published every 15 minutes.  We fetch the N most recent to
 * satisfy the requested time-window, decompress with fflate, parse the
 * tab-separated CSV, and filter for violent/conflict CAMEO event codes.
 */

import type { NextRequest } from "next/server";
import { unzipSync } from "fflate";
import type { AcledRawEvent, ConflictEvent } from "@/types/conflict";

export const runtime = "nodejs";

// ── GDELT constants ───────────────────────────────────────────────────
const GDELT_LASTUPDATE =
  "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";

/** GDELT 2.0 export CSV column indices (0-based, tab-separated, 61 cols). */
const G = {
  ID:      0,  DATE:    1,
  A1NAME:  6,  A2NAME:  16,
  EVCODE:  26, GOLDSTEIN: 30, MENTIONS: 31,
  GEO_FULL: 52, GEO_CC: 53,
  LAT:     56, LON:     57,
  URL:     60,
} as const;

/** CAMEO codes we render as conflict events. */
function isConflictCode(code: string): boolean {
  const n = parseInt(code, 10);
  return (n >= 140 && n <= 146) ||  // Protest / riot
         (n >= 170 && n <= 176) ||  // Coerce
         (n >= 180 && n <= 204);    // Assault / Fight / Military force
}

function cameoToEventType(code: string): ConflictEvent["eventType"] {
  const n = parseInt(code, 10);
  if (n >= 200) return "Explosions/Remote violence";
  if (n >= 190) return "Battles";
  if (n >= 180) return "Violence against civilians";
  if (n >= 170) return "Strategic developments";
  if (n >= 145) return "Riots";
  return "Protests";
}

function yyyymmddToIso(raw: string): string {
  if (raw.length < 8) return raw;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** Fetch + unzip one GDELT export file; return cleaned ConflictEvents. */
async function fetchGdeltFile(zipUrl: string): Promise<ConflictEvent[]> {
  const res = await fetch(zipUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status} for ${zipUrl}`);

  const buf   = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const files = unzipSync(bytes);
  const allKeys = Object.keys(files);
  console.log("[gdelt] ZIP contents:", allKeys);
  const csvKey = allKeys.find(k => k.endsWith(".CSV") || k.endsWith(".csv") || k.includes("export"));
  if (!csvKey) throw new Error("No CSV found in GDELT ZIP");

  const text  = new TextDecoder("latin1").decode(files[csvKey]);
  const lines = text.split("\n");

  const events: ConflictEvent[] = [];
  for (const line of lines) {
    const c = line.split("\t");
    if (c.length < 61) continue;

    const code = c[G.EVCODE]!;
    if (!isConflictCode(code)) continue;

    const lat = parseFloat(c[G.LAT]!);
    const lon = parseFloat(c[G.LON]!);
    if (isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) continue;

    events.push({
      id:           `gdelt_${c[G.ID]}`,
      date:         yyyymmddToIso(c[G.DATE]!),
      eventType:    cameoToEventType(code),
      subEventType: `CAMEO ${code}`,
      actor1:       c[G.A1NAME]  ?? "",
      actor2:       c[G.A2NAME]  ?? "",
      country:      c[G.GEO_CC]  ?? "",
      region:       c[G.GEO_FULL] ?? "",
      lat,
      lon,
      fatalities:   0,           // GDELT doesn't include fatality counts
      notes:        c[G.URL]     ?? "",
      source:       c[G.URL]     ?? "",
    });
  }
  return events;
}

/** Parse lastupdate.txt and return the export .CSV.zip URL. */
async function getLatestExportUrl(): Promise<string> {
  const res  = await fetch(GDELT_LASTUPDATE, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`lastupdate.txt HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split("\n").find(l => l.includes(".export.CSV.zip"));
  if (!line) throw new Error("Export URL not found in lastupdate.txt");
  const parts = line.trim().split(/\s+/);
  // lastupdate.txt format: "<md5> <size> <url>" — url is always the last field
  return parts[parts.length - 1]!;
}

/**
 * Derive the export URL for N 15-minute steps before a given timestamp URL.
 * e.g. "20260405120000" − 1 step → "20260405111500"
 */
function prevExportUrl(url: string, steps: number): string {
  const m = url.match(/(\d{14})\.export/);
  if (!m) return url;
  const ts   = m[1]!;
  const year = parseInt(ts.slice(0, 4),  10);
  const mon  = parseInt(ts.slice(4, 6),  10) - 1;
  const day  = parseInt(ts.slice(6, 8),  10);
  const hr   = parseInt(ts.slice(8, 10), 10);
  const min  = parseInt(ts.slice(10, 12), 10);
  const d    = new Date(Date.UTC(year, mon, day, hr, min, 0));
  d.setUTCMinutes(d.getUTCMinutes() - steps * 15);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const newTs = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00`;
  return url.replace(ts, newTs);
}

// ── GDELT data cache ──────────────────────────────────────────────────
const GDELT_CACHE_TTL = 15 * 60 * 1000;
interface CacheEntry { data: ConflictEvent[]; ts: number; }
const _gdeltCache = new Map<number, CacheEntry>();
/** Cache one snapshot per "# files" request; refreshes every 15 min. */

async function fetchGdelt(numFiles: number): Promise<ConflictEvent[]> {
  const cached = _gdeltCache.get(numFiles);
  if (cached && Date.now() - cached.ts < GDELT_CACHE_TTL) return cached.data;

  const latestUrl = await getLatestExportUrl();
  const urls: string[] = [latestUrl];
  for (let i = 1; i < numFiles; i++) urls.push(prevExportUrl(latestUrl, i));

  console.log("[gdelt] Fetching", urls.length, "file(s):", urls[0]);
  const results = await Promise.allSettled(urls.map(fetchGdeltFile));
  const all: ConflictEvent[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.warn("[gdelt] file fetch failed:", r.reason);
  }

  // Deduplicate by id
  const seen = new Set<string>();
  const deduped = all.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });

  _gdeltCache.set(numFiles, { data: deduped, ts: Date.now() });
  return deduped;
}

// ── ACLED OAuth (upgrade path) ────────────────────────────────────────
const ACLED_TOKEN_URL = "https://acleddata.com/oauth/token";
const ACLED_READ_URL  = "https://acleddata.com/api/acled/read";
const ACLED_FIELDS    = [
  "event_id_cnty","event_date","event_type","sub_event_type",
  "actor1","actor2","country","admin1","location",
  "latitude","longitude","fatalities","notes","source",
].join("|");

let _acledToken: { token: string; expiresAt: number } | null = null;

async function getAcledToken(email: string, password: string): Promise<string> {
  if (_acledToken && Date.now() < _acledToken.expiresAt - 60_000) return _acledToken.token;
  const body = new URLSearchParams({ username: email, password, grant_type: "password", client_id: "acled" });
  const res  = await fetch(ACLED_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ACLED auth HTTP ${res.status}`);
  const d = await res.json() as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("ACLED: no access_token");
  _acledToken = { token: d.access_token, expiresAt: Date.now() + (d.expires_in ?? 86400) * 1000 };
  return _acledToken.token;
}

function cleanAcled(raw: AcledRawEvent): ConflictEvent | null {
  const lat = parseFloat(String(raw.latitude));
  const lon = parseFloat(String(raw.longitude));
  if (isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) return null;
  return {
    id: raw.event_id_cnty ?? `${lat}_${lon}`,
    date: raw.event_date ?? "",
    eventType: raw.event_type ?? "Unknown",
    subEventType: raw.sub_event_type ?? "",
    actor1: raw.actor1 ?? "",
    actor2: raw.actor2 ?? "",
    country: raw.country ?? "",
    region: [raw.admin1, raw.location].filter(Boolean).join(" · "),
    lat, lon,
    fatalities: parseInt(String(raw.fatalities), 10) || 0,
    notes: raw.notes ?? "",
    source: raw.source ?? "",
  };
}

const ACLED_CACHE_TTL = 2 * 60 * 60 * 1000;
const _acledCache = new Map<number, CacheEntry>();

async function fetchAcled(days: number, email: string, password: string): Promise<ConflictEvent[]> {
  const cached = _acledCache.get(days);
  if (cached && Date.now() - cached.ts < ACLED_CACHE_TTL) return cached.data;

  const token = await getAcledToken(email, password);
  const end   = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const iso   = (d: Date) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    _format: "json",
    event_date: `${iso(start)}|${iso(end)}`,
    event_date_where: "BETWEEN",
    limit: "1000",
    fields: ACLED_FIELDS,
  });

  const res = await fetch(`${ACLED_READ_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) {
    _acledToken = null;
    throw new Error(`ACLED data API returned ${res.status} — account may not have API access`);
  }
  if (!res.ok) throw new Error(`ACLED HTTP ${res.status}`);

  const body = await res.json() as { data?: AcledRawEvent[] };
  const events = (body.data ?? []).map(cleanAcled).filter((e): e is ConflictEvent => e !== null);
  _acledCache.set(days, { data: events, ts: Date.now() });
  return events;
}

// ── Route handler ─────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const days     = Math.min(90, Math.max(1, parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10)));
  const email    = process.env.ACLED_EMAIL?.trim();
  const password = process.env.ACLED_PASSWORD?.trim();

  // Try ACLED first if credentials are present
  if (email && password) {
    try {
      const events = await fetchAcled(days, email, password);
      return Response.json({ events, count: events.length, source: "acled", cached: false });
    } catch (err) {
      console.warn("[conflicts] ACLED failed, falling back to GDELT:", err instanceof Error ? err.message : err);
    }
  }

  // GDELT fallback (always works, no credentials)
  try {
    // Map "days" to number of 15-min files: cap at 8 (2 hours) for performance
    const numFiles = Math.min(8, Math.max(1, Math.round(days / 1)));
    const events   = await fetchGdelt(numFiles);
    return Response.json({ events, count: events.length, source: "gdelt", cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { events: [], count: 0, error: `gdelt_failed: ${message}` },
      { status: 502 },
    );
  }
}
