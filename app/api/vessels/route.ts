// Edge runtime — no cold start, native WebSocket, 25s limit on free plan
export const runtime = "edge";

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const COLLECT_MS = 6000;
const MAX_VESSELS = 1500;

export async function GET() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) {
    return Response.json(
      { error: "AISSTREAM_API_KEY not configured in environment variables." },
      { status: 503 }
    );
  }

  try {
    const vessels = await collectVessels(key);
    return Response.json({ vessels, total: vessels.length });
  } catch (err: any) {
    console.error("[vessels]", err?.message ?? err);
    return Response.json({ error: "Failed to collect vessel data" }, { status: 502 });
  }
}

interface Vessel {
  mmsi: string;
  name: string;
  callsign: string;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  heading: number;
  shipType: number;
  destination: string;
  draught: number;
  length: number;
  width: number;
}

function collectVessels(apiKey: string): Promise<Vessel[]> {
  return new Promise((resolve, reject) => {
    const seen = new Map<string, Vessel>();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(Array.from(seen.values()));
    };

    const timer = setTimeout(finish, COLLECT_MS);

    const ws = new WebSocket(AISSTREAM_URL);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"],
      }));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (settled) return;
      try {
        const msg = JSON.parse(event.data as string);
        const meta = msg.MetaData ?? {};
        const mmsi = String(meta.MMSI ?? "");
        if (!mmsi) return;

        const pr = msg.Message?.PositionReport ?? msg.Message?.StandardClassBPositionReport;
        const sd = msg.Message?.ShipStaticData;

        if (pr) {
          const lat = pr.Latitude ?? meta.latitude_deg;
          const lon = pr.Longitude ?? meta.longitude_deg;
          if (lat == null || lon == null || (lat === 0 && lon === 0)) return;

          const existing = seen.get(mmsi) ?? {} as Partial<Vessel>;
          seen.set(mmsi, {
            mmsi,
            name: (meta.ShipName ?? existing.name ?? "").trim(),
            callsign: existing.callsign ?? "",
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
          });
        }

        if (sd) {
          const existing = seen.get(mmsi);
          if (existing) {
            existing.name = (sd.Name ?? existing.name ?? "").trim() || existing.name;
            existing.shipType = sd.Type ?? existing.shipType;
            existing.destination = (sd.Destination ?? existing.destination ?? "").trim();
            existing.draught = sd.Draught ?? existing.draught;
            existing.callsign = (sd.CallSign ?? existing.callsign ?? "").trim();
            const dim = sd.Dimension ?? {};
            existing.length = ((dim.A ?? 0) + (dim.B ?? 0)) || existing.length;
            existing.width = ((dim.C ?? 0) + (dim.D ?? 0)) || existing.width;
          }
        }

        if (seen.size >= MAX_VESSELS) {
          clearTimeout(timer);
          finish();
        }
      } catch {}
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      if (!settled) finish(); // return whatever we have
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
