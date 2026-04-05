import type { NextRequest } from "next/server";
import type { SatelliteOMM } from "@/types/satellite";

export const runtime = "nodejs";

const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/gp.php";

const GROUP_URLS: Record<string, string> = {
  visual:   `${CELESTRAK_BASE}?GROUP=VISUAL&FORMAT=JSON`,
  stations: `${CELESTRAK_BASE}?GROUP=STATIONS&FORMAT=JSON`,
  weather:  `${CELESTRAK_BASE}?GROUP=WEATHER&FORMAT=JSON`,
  starlink: `${CELESTRAK_BASE}?GROUP=STARLINK&FORMAT=JSON`,
};

interface CacheEntry {
  data: SatelliteOMM[];
  ts: number;
}
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 3_600_000; // 1 hour — TLEs change slowly

export async function GET(req: NextRequest) {
  const group = req.nextUrl.searchParams.get("group") ?? "visual";
  const url = GROUP_URLS[group] ?? GROUP_URLS.visual;

  const cached = _cache.get(group);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return Response.json({ satellites: cached.data, count: cached.data.length, cached: true });
  }

  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return Response.json(
        { satellites: [], count: 0, error: `CelesTrak returned HTTP ${res.status}` },
        { status: 502 },
      );
    }

    const raw = await res.json() as unknown;
    if (!Array.isArray(raw)) {
      return Response.json(
        { satellites: [], count: 0, error: "Unexpected CelesTrak response format" },
        { status: 502 },
      );
    }

    const satellites = (raw as SatelliteOMM[]).filter(
      s => s.OBJECT_NAME && s.MEAN_MOTION != null && s.EPOCH,
    );

    _cache.set(group, { data: satellites, ts: Date.now() });
    return Response.json({ satellites, count: satellites.length, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { satellites: [], count: 0, error: `Satellite fetch failed: ${message}` },
      { status: 502 },
    );
  }
}
