import { handleFlightAwareAircraftGET } from "@/lib/server/flightAwareAircraftHandler";

export const runtime = "nodejs";

/** @deprecated Use GET /api/aircraft/flightaware — same handler. */
export const GET = handleFlightAwareAircraftGET;
