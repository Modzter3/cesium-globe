import { NextRequest, NextResponse } from "next/server";

/** Per https://operations.osmfoundation.org/policies/nominatim/ */
const NOMINATIM_UA = "cesium-globe/1.0 (local sidebar place names; contact via repo maintainer)";

type NominatimAddress = Record<string, string | undefined>;

function formatFromNominatim(data: Record<string, unknown>): string {
  const addr = data.address as NominatimAddress | undefined;
  if (addr) {
    const locality =
      addr.city ||
      addr.town ||
      addr.village ||
      addr.hamlet ||
      addr.municipality ||
      addr.county;
    const region = addr.state || addr.province || addr.region;
    const country = addr.country;
    const parts: string[] = [];
    if (locality) parts.push(locality);
    if (region && region !== locality) parts.push(region);
    if (country) parts.push(country);
    if (parts.length) return parts.join(", ");
  }
  const display = typeof data.display_name === "string" ? data.display_name : "";
  if (display) {
    return display
      .split(",")
      .map((s) => s.trim())
      .slice(0, 3)
      .join(", ");
  }
  return "Unknown area";
}

function parseCoord(sp: URLSearchParams, latKey: string, lonKey: string): { lat: number; lon: number } | null {
  const lat = Number(sp.get(latKey));
  const lon = Number(sp.get(lonKey));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

async function reverse(lat: number, lon: number): Promise<string> {
  const url =
    "https://nominatim.openstreetmap.org/reverse?" +
    new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: "json",
    }).toString();

  const res = await fetch(url, {
    headers: {
      "User-Agent": NOMINATIM_UA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`nominatim HTTP ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return formatFromNominatim(data);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const origin = parseCoord(sp, "olat", "olon");
  const dest = parseCoord(sp, "dlat", "dlon");

  if (!origin && !dest) {
    return NextResponse.json({ error: "no_coordinates" }, { status: 400 });
  }

  try {
    const out: { origin?: string; destination?: string } = {};

    if (origin) {
      out.origin = await reverse(origin.lat, origin.lon);
      if (dest) await new Promise((r) => setTimeout(r, 1100));
    }

    if (dest) {
      out.destination = await reverse(dest.lat, dest.lon);
    }

    return NextResponse.json(out);
  } catch (err) {
    console.error("[geocode/places]", err);
    return NextResponse.json(
      { origin: "Place lookup failed", destination: "Place lookup failed" },
      { status: 200 }
    );
  }
}
