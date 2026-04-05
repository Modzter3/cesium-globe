export const runtime = "edge";

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
/** Collect window per request — 5 s gives a solid global snapshot. */
const COLLECT_MS = 5_000;
const MAX_VESSELS = 1_000;

/** [minLat, minLon, maxLat, maxLon] → AISstream [[minLat, minLon], [maxLat, maxLon]] */
function parseBbox(param: string | null): [[number, number], [number, number]] {
  if (param) {
    const p = param.split(",").map(Number);
    if (p.length === 4 && p.every(isFinite)) {
      return [[p[0], p[1]], [p[2], p[3]]];
    }
  }
  return [[-90, -180], [90, 180]]; // global fallback
}

export async function GET(req: Request) {
  const key = (process.env.AISSTREAM_API_KEY ?? "").trim();
  if (!key) {
    return Response.json(
      { error: "AISSTREAM_API_KEY not configured — sign up free at aisstream.io", vessels: [], total: 0 },
      { status: 503 },
    );
  }

  const bbox = parseBbox(new URL(req.url).searchParams.get("bbox"));

  try {
    const result = await collectVessels(key, bbox);
    return Response.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return Response.json({ error: msg, vessels: [], total: 0 }, { status: 502 });
  }
}

interface AisVessel {
  mmsi:        string;
  name:        string;
  callsign:    string;
  lat:         number;
  lon:         number;
  sog:         number;
  cog:         number;
  heading:     number;
  shipType:    number;
  destination: string;
  draught:     number;
  length:      number;
  width:       number;
}

// ── AIS "not available" sentinels ────────────────────────────────
/** True heading 511 = not available → fall back to COG. */
function validHeading(h: number | undefined): number | null {
  if (h == null || h >= 360) return null;
  return h;
}
/** COG 3600 = not available. */
function validCog(c: number | undefined): number {
  if (c == null || c >= 360) return 0;
  return c;
}
/** SOG 1022/1023 = not available. Clamp to 0–102 kts. */
function validSog(s: number | undefined): number {
  if (s == null || s > 102) return 0;
  return s;
}
/** AIS invalid: lat 91, lon 181; also reject 0,0 (null island). */
function validPos(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 &&
         lon >= -180 && lon <= 180 &&
         !(lat === 0 && lon === 0) &&
         lat !== 91 && lon !== 181;
}

function collectVessels(
  apiKey: string,
  bbox: [[number, number], [number, number]],
): Promise<{ vessels: AisVessel[]; total: number }> {
  return new Promise((resolve) => {
    const seen = new Map<string, AisVessel>();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve({ vessels: Array.from(seen.values()), total: seen.size });
    };

    const timer = setTimeout(finish, COLLECT_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket(AISSTREAM_URL);
    } catch {
      clearTimeout(timer);
      resolve({ vessels: [], total: 0 });
      return;
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [bbox],
        FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"],
      }));
    });

    ws.addEventListener("message", async (event: MessageEvent) => {
      if (settled) return;
      try {
        // Edge runtime may deliver frames as ArrayBuffer rather than string.
        const raw = event.data;
        const text =
          typeof raw === "string" ? raw :
          raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) :
          typeof (raw as { text?: () => Promise<string> }).text === "function"
            ? await (raw as { text: () => Promise<string> }).text()
            : String(raw);

        const msg = JSON.parse(text) as Record<string, unknown>;
        if (msg.error) { clearTimeout(timer); finish(); return; }

        const meta    = (msg.MetaData ?? {}) as Record<string, unknown>;
        const mmsi    = String(meta.MMSI ?? "").trim();
        if (!mmsi || mmsi === "0") return;

        const message = (msg.Message ?? {}) as Record<string, unknown>;
        const pr = (message.PositionReport ?? message.StandardClassBPositionReport) as Record<string, unknown> | undefined;
        const sd = message.ShipStaticData as Record<string, unknown> | undefined;

        if (pr) {
          // Prefer explicit lat/lon fields; fall back to MetaData coordinates.
          const lat = (pr.Latitude  ?? meta.latitude  ?? meta.latitude_deg)  as number | undefined;
          const lon = (pr.Longitude ?? meta.longitude ?? meta.longitude_deg) as number | undefined;
          if (lat == null || lon == null || !validPos(lat, lon)) return;

          const cog = validCog(pr.Cog as number | undefined);
          const hdg = validHeading(pr.TrueHeading as number | undefined) ?? cog;
          const existing = seen.get(mmsi) ?? ({} as Partial<AisVessel>);

          seen.set(mmsi, {
            mmsi,
            name:        ((meta.ShipName as string | undefined) ?? existing.name ?? "").trim(),
            callsign:    existing.callsign ?? "",
            lat, lon,
            sog:         validSog(pr.Sog as number | undefined),
            cog, heading: hdg,
            shipType:    existing.shipType ?? 0,
            destination: existing.destination ?? "",
            draught:     existing.draught  ?? 0,
            length:      existing.length   ?? 0,
            width:       existing.width    ?? 0,
          });
        }

        if (sd) {
          const existing = seen.get(mmsi);
          if (existing) {
            const sdName = ((sd.Name as string | undefined) ?? "").trim();
            if (sdName) existing.name = sdName;
            existing.shipType    = (sd.Type        as number | undefined) ?? existing.shipType;
            existing.destination = ((sd.Destination as string | undefined) ?? "").trim();
            existing.draught     = (sd.Draught      as number | undefined) ?? existing.draught;
            existing.callsign    = ((sd.CallSign    as string | undefined) ?? "").trim();
            const dim = (sd.Dimension ?? {}) as Record<string, number>;
            const len = (dim.A ?? 0) + (dim.B ?? 0);
            const wid = (dim.C ?? 0) + (dim.D ?? 0);
            if (len > 0) existing.length = len;
            if (wid > 0) existing.width  = wid;
          }
        }

        if (seen.size >= MAX_VESSELS) { clearTimeout(timer); finish(); }
      } catch { /* skip malformed message */ }
    });

    ws.addEventListener("error", () => { clearTimeout(timer); finish(); });
    ws.addEventListener("close", () => { clearTimeout(timer); finish(); });
  });
}
