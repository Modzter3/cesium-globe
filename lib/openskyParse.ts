import type { AircraftData } from "@/types/aircraft";

/** OpenSky state vector indices (see https://openskynetwork.github.io/opensky-api/rest.html). */
const I_ICAO24 = 0;
const I_CALLSIGN = 1;
const I_LON = 5;
const I_LAT = 6;
const I_BARO_ALT = 7;
const I_ON_GROUND = 8;
const I_VELOCITY = 9;
const I_TRUE_TRACK = 10;

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Maps one OpenSky `states` row into {@link AircraftData}, or null if invalid / not drawable.
 */
export function parseOpenSkyStateRow(row: unknown): AircraftData | null {
  if (!Array.isArray(row) || row.length < 11) return null;

  const icaoRaw = row[I_ICAO24];
  const icao = typeof icaoRaw === "string" ? icaoRaw : String(icaoRaw ?? "").trim();
  if (!icao) return null;

  const lon = toFiniteNumber(row[I_LON]);
  const lat = toFiniteNumber(row[I_LAT]);
  if (lon === null || lat === null) return null;

  const onGround = row[I_ON_GROUND] === true;
  if (onGround) return null;

  const baroM = toFiniteNumber(row[I_BARO_ALT]);
  const altM = baroM !== null ? baroM : 914.4; // default ~3000 ft if missing
  const altFt = altM / 0.3048;

  const velMs = toFiniteNumber(row[I_VELOCITY]);
  const speedKts = velMs !== null ? Math.round(velMs * 1.943844492) : 0;

  const track = toFiniteNumber(row[I_TRUE_TRACK]);
  const heading = track !== null ? Math.round(track) : 0;

  const callsignRaw = row[I_CALLSIGN];
  const callsign =
    typeof callsignRaw === "string" ? callsignRaw.trim() || icao : String(callsignRaw ?? "").trim() || icao;

  return {
    icao,
    callsign,
    registration: "",
    type: "",
    typeDesc: "",
    operator: "",
    altFt,
    altM,
    speedKts,
    heading,
    verticalRate: 0,
    squawk: "",
    lat,
    lon,
    emergency: "",
  };
}
