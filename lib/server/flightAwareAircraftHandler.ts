import { NextRequest, NextResponse } from "next/server";
import { fetchFlightAwareAircraftDetail } from "@/lib/server/flightAwareAero";

/** Shared App Router handler — used by /api/aircraft/flightaware (and legacy path). */
export async function handleFlightAwareAircraftGET(req: NextRequest): Promise<NextResponse> {
  const callsign = req.nextUrl.searchParams.get("callsign")?.trim() ?? "";
  const registration = req.nextUrl.searchParams.get("registration")?.trim() ?? "";
  const { body, status } = await fetchFlightAwareAircraftDetail(callsign, registration);
  return NextResponse.json(body, { status });
}
