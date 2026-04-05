import { NextResponse } from "next/server";
import { getFlightAwareApiKey, getFlightAwareEnvDebug } from "@/lib/flightAwareEnv";

export const runtime = "nodejs";

/** Dev-only: confirms the server sees an API key (does not echo the key). */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const key = getFlightAwareApiKey();
  return NextResponse.json({
    configured: Boolean(key),
    keyLength: key?.length ?? 0,
    debug: getFlightAwareEnvDebug(),
  });
}
