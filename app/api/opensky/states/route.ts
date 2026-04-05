import { NextResponse } from "next/server";

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";

export async function GET() {
  try {
    const res = await fetch(OPENSKY_STATES_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "cesium-globe/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      return NextResponse.json(
        { time: 0, states: [], message: "OpenSky rate limit (429)" },
        {
          status: 429,
          headers: retryAfter ? { "Retry-After": retryAfter } : {},
        }
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[opensky] API error", res.status, body.slice(0, 500));
      return NextResponse.json(
        { time: 0, states: [], message: `OpenSky HTTP ${res.status}` },
        { status: 502 }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[opensky] fetch failed", err);
    return NextResponse.json({ time: 0, states: [], message: "OpenSky unreachable" }, { status: 502 });
  }
}
