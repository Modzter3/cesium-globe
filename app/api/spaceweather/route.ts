/**
 * /api/spaceweather
 *
 * Fetches real-time space weather data from NOAA:
 *   - Planetary K-index (Kp) — geomagnetic storm level
 *   - Real-time solar wind speed, Bz, and proton density
 *
 * Cached for 5 minutes. No API key required.
 */
export const runtime = "nodejs";

export interface SpaceWeather {
  kp: number;
  kpTime: string;
  solarWindSpeed: number | null;
  bz: number | null;
  density: number | null;
  stormLevel: number;   // 0 = quiet … 5 = extreme
  stormLabel: string;   // "Quiet" | "Unsettled" | "Active" | "Minor" … "Extreme"
  stormColor: string;   // hex accent color
}

function kpToStorm(kp: number): [number, string, string] {
  if (kp >= 9)  return [5, "Extreme",  "#cc0000"];
  if (kp >= 8)  return [4, "Severe",   "#ff2200"];
  if (kp >= 7)  return [3, "Strong",   "#ff5500"];
  if (kp >= 6)  return [2, "Moderate", "#ff8800"];
  if (kp >= 5)  return [1, "Minor",    "#ffaa00"];
  if (kp >= 4)  return [0, "Active",   "#ffdd00"];
  if (kp >= 3)  return [0, "Unsettled","#aacc00"];
  return               [0, "Quiet",    "#00ff88"];
}

interface CacheEntry { data: SpaceWeather; ts: number }
let _cache: CacheEntry | null = null;
const TTL = 5 * 60 * 1000;

export async function GET() {
  if (_cache && Date.now() - _cache.ts < TTL) {
    return Response.json(_cache.data);
  }

  try {
    const [kpRes, windRes] = await Promise.allSettled([
      fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
            { signal: AbortSignal.timeout(8_000) }),
      fetch("https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json",
            { signal: AbortSignal.timeout(8_000) }),
    ]);

    // ── Kp index ────────────────────────────────────────────────
    let kp = 0;
    let kpTime = "";
    if (kpRes.status === "fulfilled" && kpRes.value.ok) {
      // Format: [ ["time_tag","kp_index","observed","noaa_scale"], [...], ... ]
      const rows = await kpRes.value.json() as string[][];
      const data = rows.filter(r => r[0] !== "time_tag");
      const last = data.at(-1);
      if (last) {
        kp     = parseFloat(last[1] ?? "0") || 0;
        kpTime = last[0] ?? "";
      }
    }

    // ── Solar wind ──────────────────────────────────────────────
    let solarWindSpeed: number | null = null;
    let bz: number | null = null;
    let density: number | null = null;
    if (windRes.status === "fulfilled" && windRes.value.ok) {
      const wind = await windRes.value.json() as Array<{
        time_tag: string;
        proton_speed: number | null;
        bz_gsm: number | null;
        proton_density: number | null;
      }>;
      const last = wind.filter(w => w.proton_speed != null).at(-1);
      if (last) {
        solarWindSpeed = last.proton_speed;
        bz             = last.bz_gsm;
        density        = last.proton_density;
      }
    }

    const [stormLevel, stormLabel, stormColor] = kpToStorm(kp);
    const data: SpaceWeather = { kp, kpTime, solarWindSpeed, bz, density, stormLevel, stormLabel, stormColor };
    _cache = { data, ts: Date.now() };
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
