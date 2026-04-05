/**
 * FlightAware AeroAPI — server-only. Do not import from client components.
 * Uses FLIGHTAWARE_API_KEY (and aliases) via getFlightAwareApiKey(); the key is never
 * sent to or read from the browser.
 */
import { getFlightAwareApiKey } from "@/lib/flightAwareEnv";
import { mapRawFlightToDetail, pickBestFlight } from "@/lib/mapFlightAwareFlight";
import type { FlightAwareFlightDetail, FlightAwareFlightResponse } from "@/types/flightAware";

const AEROAPI_BASE = "https://aeroapi.flightaware.com/aeroapi";

function inferIdentType(ident: string): "designator" | "registration" {
  const u = ident.toUpperCase();
  if (/^N[1-9][0-9A-Z]{1,4}$/.test(u)) return "registration";
  return "designator";
}

async function fetchFlightsFromAero(
  apiKey: string,
  ident: string,
  identType: "designator" | "registration"
): Promise<{ ok: boolean; status: number; flights: Record<string, unknown>[] }> {
  const url = `${AEROAPI_BASE}/flights/${encodeURIComponent(ident)}?ident_type=${identType}&max_pages=2`;
  const res = await fetch(url, {
    headers: {
      "x-apikey": apiKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) {
    return { ok: false, status: res.status, flights: [] };
  }
  const body = (await res.json()) as { flights?: Record<string, unknown>[] };
  return { ok: true, status: res.status, flights: body.flights ?? [] };
}

export type FlightAwareAircraftHttpResult = {
  body: FlightAwareFlightResponse;
  status: number;
};

/**
 * Resolve FlightAware itinerary for live aircraft (callsign and/or tail). Returns
 * cleaned {@link FlightAwareFlightDetail} only — raw AeroAPI payloads stay on the server.
 */
export async function fetchFlightAwareAircraftDetail(
  callsign: string,
  registration: string
): Promise<FlightAwareAircraftHttpResult> {
  const key = getFlightAwareApiKey();
  if (!key) {
    console.error("[flightaware] No FlightAware API key (set FLIGHTAWARE_API_KEY server-side)");
    return {
      body: { flight: null, matchedBy: null, error: "missing_api_key" },
      status: 503,
    };
  }

  const callsignNorm = callsign.toUpperCase().replace(/\s+/g, "");
  const registrationNorm = registration.toUpperCase().replace(/\s+/g, "");

  const err = (msg: string, status = 200): FlightAwareAircraftHttpResult => ({
    body: { flight: null, matchedBy: null, error: msg },
    status,
  });

  if (callsign.length < 2 && registration.length < 2) {
    return err("callsign_or_registration_required");
  }

  try {
    let chosen: Record<string, unknown> | null = null;
    let matchedBy: "callsign" | "registration" | null = null;

    if (callsign.length >= 3) {
      const identType = inferIdentType(callsign);
      const r = await fetchFlightsFromAero(key, callsign, identType);
      if (r.status === 401 || r.status === 403) {
        console.error("[flightaware] auth failed", r.status);
        return err("flightaware_auth", 502);
      }
      if (r.ok && r.flights.length) {
        chosen = pickBestFlight(r.flights, callsignNorm, registrationNorm);
        matchedBy = "callsign";
      }
    }

    if (!chosen && registrationNorm.length >= 2) {
      const r = await fetchFlightsFromAero(key, registration, "registration");
      if (r.status === 401 || r.status === 403) {
        return err("flightaware_auth", 502);
      }
      if (r.ok && r.flights.length) {
        chosen = pickBestFlight(r.flights, callsignNorm, registrationNorm);
        matchedBy = "registration";
      }
    }

    if (!chosen) {
      return {
        body: { flight: null, matchedBy: null, error: "no_matching_flight" },
        status: 200,
      };
    }

    const flight: FlightAwareFlightDetail = mapRawFlightToDetail(chosen);
    return {
      body: { flight, matchedBy, error: null },
      status: 200,
    };
  } catch (e) {
    console.error("[flightaware]", e);
    return err("flightaware_fetch_failed");
  }
}
