export const runtime = "edge";

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const COLLECT_MS = 8000;
const MAX_VESSELS = 1500;

export async function GET() {
  const key = process.env.AISSTREAM_API_KEY ?? "";
  if (!key) {
    return Response.json({ error: "AISSTREAM_API_KEY not set" }, { status: 503 });
  }

  try {
    const result = await collectVessels(key);
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "unknown error", vessels: [], total: 0 }, { status: 502 });
  }
}

interface Vessel {
  mmsi: string; name: string; callsign: string;
  lat: number; lon: number; sog: number; cog: number; heading: number;
  shipType: number; destination: string; draught: number; length: number; width: number;
}

function collectVessels(apiKey: string): Promise<{ vessels: Vessel[]; total: number; debug: any }> {
  return new Promise((resolve) => {
    const seen = new Map<string, Vessel>();
    let settled = false;
    let openedAt: number | null = null;
    let firstMsgAt: number | null = null;
    let msgCount = 0;
    let wsError: string | null = null;

    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({
        vessels: Array.from(seen.values()),
        total: seen.size,
        debug: {
          reason,
          opened: openedAt != null,
          firstMsgMs: firstMsgAt != null && openedAt != null ? firstMsgAt - openedAt : null,
          msgCount,
          vesselCount: seen.size,
          wsError,
        }
      });
    };

    const timer = setTimeout(() => finish("timeout"), COLLECT_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket(AISSTREAM_URL);
    } catch (e: any) {
      clearTimeout(timer);
      resolve({ vessels: [], total: 0, debug: { reason: "ws_init_failed", error: e?.message } });
      return;
    }

    ws.addEventListener("open", () => {
      openedAt = Date.now();
      ws.send(JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"],
      }));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (settled) return;
      if (firstMsgAt === null) firstMsgAt = Date.now();
      msgCount++;

      try {
        const msg = JSON.parse(event.data as string);

        // Check for API errors
        if (msg.error) {
          wsError = msg.error;
          clearTimeout(timer);
          finish("api_error");
          return;
        }

        const meta = msg.MetaData ?? {};
        const mmsi = String(meta.MMSI ?? "");
        if (!mmsi) return;

        const pr = msg.Message?.PositionReport ?? msg.Message?.StandardClassBPositionReport;
        const sd = msg.Message?.ShipStaticData;

        if (pr) {
          const lat = pr.Latitude ?? meta.latitude_deg;
          const lon = pr.Longitude ?? meta.longitude_deg;
          if (lat == null || lon == null || (lat === 0 && lon === 0)) return;
          if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;

          const existing = seen.get(mmsi) ?? {} as Partial<Vessel>;
          seen.set(mmsi, {
            mmsi,
            name: (meta.ShipName ?? existing.name ?? "").trim(),
            callsign: existing.callsign ?? "",
            lat, lon,
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
            existing.destination = (sd.Destination ?? "").trim();
            existing.draught = sd.Draught ?? existing.draught;
            existing.callsign = (sd.CallSign ?? "").trim();
            const dim = sd.Dimension ?? {};
            existing.length = ((dim.A ?? 0) + (dim.B ?? 0)) || existing.length;
            existing.width = ((dim.C ?? 0) + (dim.D ?? 0)) || existing.width;
          }
        }

        if (seen.size >= MAX_VESSELS) {
          clearTimeout(timer);
          finish("max_reached");
        }
      } catch {}
    });

    ws.addEventListener("error", (e: any) => {
      wsError = e?.message ?? "ws error";
      clearTimeout(timer);
      finish("ws_error");
    });

    ws.addEventListener("close", (e: any) => {
      clearTimeout(timer);
      finish(`closed_${e?.code ?? "?"}`);
    });
  });
}
