import { handleFlightAwareAircraftGET } from "@/lib/server/flightAwareAircraftHandler";

export const runtime = "nodejs";

/**
 * Server-side FlightAware lookup for a selected aircraft. The AeroAPI key stays on the server;
 * the client only receives normalized flight/itinerary fields.
 */
export const GET = handleFlightAwareAircraftGET;
