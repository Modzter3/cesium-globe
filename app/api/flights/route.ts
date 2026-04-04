import { NextResponse } from "next/server";

// Proxy flight data to avoid CORS.
// Uses airplanes.live — free, no API key, works from Vercel.
// Format: { ac: [ { hex, flight, lat, lon, alt_baro, gs, track, ... } ] }

export async function GET() {
  // Center on continental US, 1500nm radius covers the whole country
  const url = "https://api.airplanes.live/v2/point/39.5/-98.5/1500";

  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "cesium-globe/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `airplanes.live returned ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[flights] fetch error:", err);
    return NextResponse.json({ error: "Failed to reach flight data source" }, { status: 502 });
  }
}
