import { NextResponse } from "next/server";

// Proxy OpenSky Network API to avoid CORS issues in the browser.
// Uses a bounding box to limit data to a manageable region.
// Anonymous limit: 400 credits/day. Each request costs 1-4 credits
// depending on area size. We default to a ~US-wide box (≈ 4 credits each).

const OPENSKY_URL = "https://opensky-network.org/api/states/all";

// Default bounding box: continental US + surrounding area
const DEFAULT_BOX = {
  lamin: 24,
  lomin: -130,
  lamax: 50,
  lomax: -60,
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const lamin = searchParams.get("lamin") ?? DEFAULT_BOX.lamin;
  const lomin = searchParams.get("lomin") ?? DEFAULT_BOX.lomin;
  const lamax = searchParams.get("lamax") ?? DEFAULT_BOX.lamax;
  const lomax = searchParams.get("lomax") ?? DEFAULT_BOX.lomax;

  const url = `${OPENSKY_URL}?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;

  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      // Don't cache — we want fresh data every poll
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `OpenSky returned ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[flights] fetch error:", err);
    return NextResponse.json({ error: "Failed to reach OpenSky" }, { status: 502 });
  }
}
