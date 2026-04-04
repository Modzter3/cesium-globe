import { NextResponse } from "next/server";
import { WebSocket } from "ws";

// AIS vessel positions via aisstream.io (free, requires API key).
// We open a WebSocket, collect positions for up to 5 seconds, then close and return.
// This turns the WebSocket stream into a REST endpoint Cesium can poll.

const AISSTREAM_KEY = process.env.AISSTREAM_API_KEY ?? "";
const COLLECT_MS = 5000; // collect for 5s per request
const MAX_VESSELS = 2000;

// Bounding boxes covering major shipping lanes globally
const BOUNDING_BOXES = [
  [[-90, -180], [90, 180]], // whole world
];

export async function GET() {
  if (!AISSTREAM_KEY) {
    return NextResponse.json(
      { error: "AISSTREAM_API_KEY not set. Add it to Vercel environment variables." },
      { status: 503 }
    );
  }

  try {
    const vessels = await collectVessels();
    return NextResponse.json({ vessels, total: vessels.length });
  } catch (err) {
    console.error("[vessels] error:", err);
    return NextResponse.json({ error: "Failed to fetch vessel data" }, { status: 502 });
  }
}

interface VesselPosition {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  sog: number;       // speed over ground (knots)
  cog: number;       // course over ground (degrees)
  heading: number;
  shipType: number;
  destination: string;
  draught: number;
  length: number;
  width: number;
  callsign: string;
}

function collectVessels(): Promise<VesselPosition[]> {
  return new Promise((resolve, reject) => {
    const seen = new Map<string, VesselPosition>();
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(Array.from(seen.values()));
    };

    const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    const timer = setTimeout(done, COLLECT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        APIKey: AISSTREAM_KEY,
        BoundingBoxes: BOUNDING_BOXES,
        FilterMessageTypes: ["PositionReport", "ShipStaticData", "StandardClassBPositionReport"],
      }));
    });

    ws.on("message", (raw: Buffer) => {
      if (settled) return;
      try {
        const msg = JSON.parse(raw.toString());
        const meta = msg.MetaData ?? {};
        const mmsi = String(meta.MMSI ?? "");
        if (!mmsi) return;

        const pr = msg.Message?.PositionReport ?? msg.Message?.StandardClassBPositionReport;
        const sd = msg.Message?.ShipStaticData;

        if (pr) {
          const lat = pr.Latitude ?? meta.latitude_deg;
          const lon = pr.Longitude ?? meta.longitude_deg;
          if (lat == null || lon == null) return;
          if (lat === 0 && lon === 0) return;

          const existing = seen.get(mmsi) ?? {} as Partial<VesselPosition>;
          seen.set(mmsi, {
            mmsi,
            name: (meta.ShipName ?? existing.name ?? "").trim(),
            lat,
            lon,
            sog: pr.Sog ?? existing.sog ?? 0,
            cog: pr.Cog ?? existing.cog ?? 0,
            heading: pr.TrueHeading ?? pr.Cog ?? existing.heading ?? 0,
            shipType: existing.shipType ?? 0,
            destination: existing.destination ?? "",
            draught: existing.draught ?? 0,
            length: existing.length ?? 0,
            width: existing.width ?? 0,
            callsign: existing.callsign ?? "",
          });
        }

        if (sd) {
          const existing = seen.get(mmsi);
          if (existing) {
            existing.name = (sd.Name ?? existing.name ?? "").trim() || existing.name;
            existing.shipType = sd.Type ?? existing.shipType;
            existing.destination = (sd.Destination ?? existing.destination ?? "").trim();
            existing.draught = sd.Draught ?? existing.draught;
            existing.length = sd.Dimension?.A + sd.Dimension?.B || existing.length;
            existing.width = sd.Dimension?.C + sd.Dimension?.D || existing.width;
            existing.callsign = (sd.CallSign ?? existing.callsign ?? "").trim();
          }
        }

        if (seen.size >= MAX_VESSELS) done();
      } catch {}
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });

    ws.on("close", () => {
      clearTimeout(timer);
      done();
    });
  });
}
