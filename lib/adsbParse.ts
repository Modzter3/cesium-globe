import type { AircraftData } from "@/types/aircraft";

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one aircraft from adsb.lol-style JSON (see `/api/flights` → `data.ac[]`).
 */
export function parseAdsbAircraft(ac: Record<string, unknown>): AircraftData | null {
  const hexRaw = ac.hex ?? ac.icao24;
  const icao = typeof hexRaw === "string" ? hexRaw.trim().toLowerCase() : String(hexRaw ?? "").trim().toLowerCase();
  if (!icao) return null;

  const lat = toFiniteNumber(ac.lat);
  const lon = toFiniteNumber(ac.lon);
  if (lat === null || lon === null) return null;

  const rawAlt = ac.alt_baro;
  const onGround =
    ac.on_ground === true ||
    rawAlt === "ground" ||
    (typeof rawAlt === "string" && rawAlt.toLowerCase() === "ground");
  if (onGround) return null;

  const altFt = typeof rawAlt === "number" && Number.isFinite(rawAlt) ? rawAlt : 3000;
  const altM = altFt * 0.3048;

  const gs = toFiniteNumber(ac.gs);
  const speedKts = gs !== null ? Math.round(gs) : 0;

  const track = toFiniteNumber(ac.track);
  const heading = track !== null ? Math.round(track) : 0;

  const flightRaw = ac.flight;
  const callsign =
    typeof flightRaw === "string"
      ? flightRaw.trim() || icao
      : String(flightRaw ?? "")
          .trim() || icao;

  const baroRate = toFiniteNumber(ac.baro_rate) ?? toFiniteNumber(ac.geom_rate) ?? 0;

  return {
    icao,
    callsign,
    registration: typeof ac.r === "string" ? ac.r : "",
    type: typeof ac.t === "string" ? ac.t : "",
    typeDesc: typeof ac.desc === "string" ? ac.desc : "",
    operator: typeof ac.ownOp === "string" ? ac.ownOp : "",
    altFt,
    altM,
    speedKts,
    heading,
    verticalRate: Math.round(baroRate),
    squawk: typeof ac.squawk === "string" ? ac.squawk : "",
    lat,
    lon,
    emergency:
      typeof ac.emergency === "string" && ac.emergency !== "none" && ac.emergency !== ""
        ? ac.emergency
        : "",
  };
}
