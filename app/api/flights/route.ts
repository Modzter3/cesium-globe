import { NextResponse } from "next/server";

// Proxy flight data to avoid CORS.
// Uses the public readsb feed from adsb.fi — completely free, no API key required,
// works from server-side / Vercel, returns live ADS-B positions globally.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Bounding box params (optional) — default to continental US
  const lat = searchParams.get("lat") ?? "39.5";
  const lon = searchParams.get("lon") ?? "-98.5";
  const dist = searchParams.get("dist") ?? "1500"; // nautical miles radius

  // adsb.fi is a free, public, no-auth ADS-B aggregator with good uptime
  const url = `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}`;

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
        { error: `adsb.fi returned ${res.status}` },
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
