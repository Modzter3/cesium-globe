import { NextResponse } from "next/server";

// Global coverage via adsb.lol — free, no API key, works from Vercel.
// We fan out to 6 strategic center points in parallel and merge,
// deduplicating by ICAO hex so aircraft near region boundaries aren't doubled.

const CENTERS = [
  { lat: 40,  lon: -100, label: "North America" },
  { lat: 50,  lon:  10,  label: "Europe"        },
  { lat: 35,  lon:  105, label: "East Asia"     },
  { lat:  0,  lon:  100, label: "SE Asia"       },
  { lat: -15, lon: -55,  label: "South America" },
  { lat: -25, lon:  135, label: "Oceania"       },
];
const DIST = 1500; // nautical miles per center

async function fetchRegion(lat: number, lon: number): Promise<any[]> {
  const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${DIST}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "cesium-globe/1.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.ac ?? [];
}

export async function GET() {
  try {
    // Fetch all regions in parallel
    const results = await Promise.allSettled(
      CENTERS.map(c => fetchRegion(c.lat, c.lon))
    );

    // Merge and deduplicate by ICAO hex
    const seen = new Map<string, any>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const ac of result.value) {
        const key = ac.hex ?? ac.icao24 ?? Math.random().toString();
        if (!seen.has(key)) seen.set(key, ac);
      }
    }

    const ac = Array.from(seen.values());
    return NextResponse.json({ ac, total: ac.length });

  } catch (err) {
    console.error("[flights] global fetch error:", err);
    return NextResponse.json({ error: "Failed to fetch global flight data" }, { status: 502 });
  }
}
