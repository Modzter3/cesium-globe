import type { FlightAwareAirport, FlightAwareFlightDetail } from "@/types/flightAware";

function val(o: Record<string, unknown>, snake: string, camel: string): unknown {
  const a = o[snake];
  if (a !== undefined && a !== null) return a;
  return o[camel];
}

function readStr(o: Record<string, unknown>, snake: string, camel: string): string | null {
  const v = val(o, snake, camel);
  if (v == null) return null;
  const s = typeof v === "string" ? v.trim() : String(v).trim();
  return s || null;
}

function readNum(o: Record<string, unknown>, snake: string, camel: string): number | null {
  const v = val(o, snake, camel);
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function readBool(o: Record<string, unknown>, snake: string, camel: string): boolean {
  return val(o, snake, camel) === true;
}

function mapAirport(a: unknown): FlightAwareAirport | null {
  if (!a || typeof a !== "object") return null;
  const r = a as Record<string, unknown>;
  const code =
    readStr(r, "code_icao", "codeIcao") ??
    readStr(r, "code_iata", "codeIata") ??
    readStr(r, "code", "code");
  if (!code) return null;
  return {
    code,
    name: readStr(r, "name", "name"),
    city: readStr(r, "city", "city"),
    country: readStr(r, "country_name", "countryName") ?? readStr(r, "country", "country"),
    timezone: readStr(r, "timezone", "timezone"),
  };
}

export function mapRawFlightToDetail(raw: Record<string, unknown>): FlightAwareFlightDetail {
  return {
    faFlightId: readStr(raw, "fa_flight_id", "faFlightId"),
    ident: readStr(raw, "ident", "ident"),
    identIcao: readStr(raw, "ident_icao", "identIcao"),
    identIata: readStr(raw, "ident_iata", "identIata"),
    registration: readStr(raw, "registration", "registration"),
    aircraftType: readStr(raw, "aircraft_type", "aircraftType"),
    operator: readStr(raw, "operator_icao", "operatorIcao") ?? readStr(raw, "operator", "operator"),
    flightNumber: readStr(raw, "flight_number", "flightNumber"),
    origin: mapAirport(raw.origin),
    destination: mapAirport(raw.destination),
    status: readStr(raw, "status", "status"),
    progressPercent: readNum(raw, "progress_percent", "progressPercent"),
    route: readStr(raw, "route", "route"),
    filedAltitude: readNum(raw, "filed_altitude", "filedAltitude"),
    filedAirspeed: readNum(raw, "filed_airspeed", "filedAirspeed"),
    routeDistance: readNum(raw, "route_distance", "routeDistance"),
    scheduledOut: readStr(raw, "scheduled_out", "scheduledOut"),
    estimatedOut: readStr(raw, "estimated_out", "estimatedOut"),
    actualOut: readStr(raw, "actual_out", "actualOut"),
    scheduledOff: readStr(raw, "scheduled_off", "scheduledOff"),
    estimatedOff: readStr(raw, "estimated_off", "estimatedOff"),
    actualOff: readStr(raw, "actual_off", "actualOff"),
    scheduledOn: readStr(raw, "scheduled_on", "scheduledOn"),
    estimatedOn: readStr(raw, "estimated_on", "estimatedOn"),
    actualOn: readStr(raw, "actual_on", "actualOn"),
    scheduledIn: readStr(raw, "scheduled_in", "scheduledIn"),
    estimatedIn: readStr(raw, "estimated_in", "estimatedIn"),
    actualIn: readStr(raw, "actual_in", "actualIn"),
    gateOrigin: readStr(raw, "gate_origin", "gateOrigin"),
    gateDestination: readStr(raw, "gate_destination", "gateDestination"),
    terminalOrigin: readStr(raw, "terminal_origin", "terminalOrigin"),
    terminalDestination: readStr(raw, "terminal_destination", "terminalDestination"),
    baggageClaim: readStr(raw, "baggage_claim", "baggageClaim"),
    departureDelaySec: readNum(raw, "departure_delay", "departureDelay"),
    arrivalDelaySec: readNum(raw, "arrival_delay", "arrivalDelay"),
    diverted: readBool(raw, "diverted", "diverted"),
    cancelled: readBool(raw, "cancelled", "cancelled"),
    positionOnly: readBool(raw, "position_only", "positionOnly"),
    blocked: readBool(raw, "blocked", "blocked"),
  };
}

/** Score candidates so we prefer the leg that matches ADS-B callsign / tail and is airborne. */
export function scoreFlightCandidate(
  raw: Record<string, unknown>,
  callsignNorm: string,
  registrationNorm: string
): number {
  let s = 0;
  const ident = (readStr(raw, "ident", "ident") ?? "").toUpperCase().replace(/\s+/g, "");
  if (callsignNorm && ident === callsignNorm) s += 120;
  const reg = (readStr(raw, "registration", "registration") ?? "").toUpperCase();
  if (registrationNorm && reg === registrationNorm) s += 100;
  const actualOff = readStr(raw, "actual_off", "actualOff");
  const actualOn = readStr(raw, "actual_on", "actualOn");
  if (actualOff && !actualOn) s += 60;
  if (raw.destination && typeof raw.destination === "object") s += 20;
  if (!readBool(raw, "cancelled", "cancelled") && !readBool(raw, "blocked", "blocked")) s += 10;
  return s;
}

export function pickBestFlight(
  flights: Record<string, unknown>[],
  callsignNorm: string,
  registrationNorm: string
): Record<string, unknown> | null {
  if (!flights.length) return null;
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const f of flights) {
    const sc = scoreFlightCandidate(f, callsignNorm, registrationNorm);
    if (sc > bestScore) {
      bestScore = sc;
      best = f;
    }
  }
  return best;
}
