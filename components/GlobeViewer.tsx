"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useAircraftLayer } from "@/hooks/useAircraftLayer";
import { useMockVesselLayer } from "@/hooks/useMockVesselLayer";
import { altColorCss } from "@/lib/aircraftStyle";
import { airportLabel } from "@/lib/airportLabel";
import { shipColorCss, shipTypeLabel } from "@/lib/vesselBillboard";
import type { AircraftData } from "@/types/aircraft";
import type { FlightAwareFlightDetail, FlightAwareFlightResponse } from "@/types/flightAware";
import type { VesselData } from "@/types/vessel";

type ImageryMode = "satellite" | "osm" | "dark" | "viirs" | "sentinel2" | "modis";

interface CoordState {
  lat: string;
  lon: string;
  alt: string;
}

const CESIUM_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWEzYTYzMi1iYTMyLTQ5MjctYmEwMy05NGY1ZmQ5NGY0NzQiLCJpZCI6NDEzNTkzLCJpYXQiOjE3NzUyODI2Mjl9._sdtsqjhWpRKOwWKY7gMjh4fohPNRpz_WtaoTdgOHC4";

const CESIUM_VERSION = "1.127";
const CESIUM_CDN = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium`;
const AIRCRAFT_POLL_MS = 10_000;
const MOCK_VESSEL_TICK_MS = 2000;
/** Straight-line projection along reported heading for “where it’s headed”. */
const AIRCRAFT_LOOKAHEAD_MINUTES = 3;

const FA_ERROR_HINT: Record<string, string> = {
  missing_api_key: "Set FLIGHTAWARE_API_KEY in .env.local and restart the dev server.",
  flightaware_auth: "FlightAware rejected this API key (401/403). Verify it in your AeroAPI portal.",
  no_matching_flight: "No FlightAware itinerary matched this callsign or tail number.",
  callsign_or_registration_required: "Need a callsign or tail number to query FlightAware.",
  flightaware_fetch_failed: "FlightAware request failed (network or timeout).",
};

/** Format an ISO timestamp into local date + time strings for a given IANA timezone. */
function formatInTz(iso: string | null | undefined, tz: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const zone = tz || "UTC";
  try {
    const dp = new Intl.DateTimeFormat("en-US", {
      weekday: "long", month: "short", day: "2-digit", year: "numeric", timeZone: zone,
    }).formatToParts(d);
    const weekday = dp.find(p => p.type === "weekday")?.value ?? "";
    const month   = dp.find(p => p.type === "month")?.value ?? "";
    const day     = dp.find(p => p.type === "day")?.value ?? "";
    const year    = dp.find(p => p.type === "year")?.value ?? "";

    const tp = new Intl.DateTimeFormat("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: zone, timeZoneName: "short",
    }).formatToParts(d);
    const hour   = tp.find(p => p.type === "hour")?.value ?? "";
    const minute = tp.find(p => p.type === "minute")?.value ?? "";
    const period = tp.find(p => p.type === "dayPeriod")?.value ?? "";
    const tzName = tp.find(p => p.type === "timeZoneName")?.value ?? "";

    return {
      dayLine:  `${weekday} ${day}-${month}-${year}`,
      timeLine: `${hour}:${minute}${period}${tzName ? ` ${tzName}` : ""}`,
    };
  } catch {
    return null;
  }
}

function fmtDelay(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  const mins = Math.round(Math.abs(sec) / 60);
  if (mins === 0) return "On time";
  return `(${mins} minute${mins !== 1 ? "s" : ""} ${sec < 0 ? "early" : "late"})`;
}

function fmtDuration(ms: number): string {
  const totalMins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtMiles(mi: number): string {
  return mi.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " mi";
}

function FlightAwareCard({
  detail,
  faError,
  loading,
  callsign,
}: {
  detail: FlightAwareFlightDetail | null;
  faError: string | null;
  loading: boolean;
  callsign: string;
}) {
  const borderStyle = "1px solid rgba(0,255,65,0.18)";
  const wrap: React.CSSProperties = { marginTop: 6, paddingTop: 12, borderTop: borderStyle, color: "#c8f0c8" };

  if (loading) {
    return (
      <div style={wrap}>
        <p style={{ opacity: 0.5, fontSize: "0.78rem", margin: 0 }}>Loading FlightAware…</p>
      </div>
    );
  }
  if (faError) {
    return (
      <div style={wrap}>
        <div style={{ fontSize: "0.74rem", color: "#fbbf24", padding: "8px 10px", background: "rgba(251,191,36,0.08)", borderRadius: 4, lineHeight: 1.45 }}>
          {FA_ERROR_HINT[faError] ?? `FlightAware: ${faError}`}
        </div>
      </div>
    );
  }
  if (!detail) return null;

  const origin = detail.origin;
  const dest   = detail.destination;

  const depTime = detail.actualOut ?? detail.estimatedOut ?? detail.scheduledOut;
  const arrTime = detail.actualIn  ?? detail.estimatedIn  ?? detail.scheduledIn;
  const depFmt  = formatInTz(depTime, origin?.timezone);
  const arrFmt  = formatInTz(arrTime, dest?.timezone);
  const depDelay = fmtDelay(detail.departureDelaySec);
  const arrDelay = fmtDelay(detail.arrivalDelaySec);

  const now       = Date.now();
  const schedOut  = detail.scheduledOut ? new Date(detail.scheduledOut).getTime() : null;
  const schedIn   = detail.scheduledIn  ? new Date(detail.scheduledIn).getTime()  : null;
  const actualOff = detail.actualOff    ? new Date(detail.actualOff).getTime()    : null;
  const estOn     = detail.estimatedOn  ? new Date(detail.estimatedOn).getTime()  : null;
  const totalMs     = schedOut && schedIn ? schedIn - schedOut : null;
  const elapsedMs   = actualOff ? now - actualOff : null;
  const remainingMs = estOn ? estOn - now : null;

  const totalMi   = detail.routeDistance;
  const progress  = detail.progressPercent;
  const milesFlown = totalMi != null && progress != null ? Math.round(totalMi * progress / 100) : null;
  const milesToGo  = totalMi != null && milesFlown != null ? Math.round(totalMi - milesFlown) : null;

  const linkIdent  = detail.identIcao ?? detail.ident ?? callsign;
  const schedIdent = detail.identIata ?? detail.ident ?? callsign;

  const subLabel: React.CSSProperties = { fontSize: "0.68rem", opacity: 0.45, marginBottom: 2, letterSpacing: "0.06em" };
  const mono: React.CSSProperties     = { fontFamily: "JetBrains Mono, monospace" };
  const sep: React.CSSProperties      = { borderTop: borderStyle, paddingTop: 10, marginBottom: 10 };

  return (
    <div style={wrap}>

      {/* ── Origin → Destination ── */}
      {(origin || dest) && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 14 }}>
          {origin && (
            <div style={{ flex: 1 }}>
              <div style={{ ...mono, fontSize: "2rem", fontWeight: 800, color: "#00ff41", lineHeight: 1, letterSpacing: 1 }}>
                {origin.code}
              </div>
              <div style={{ fontSize: "0.72rem", opacity: 0.65, marginTop: 3, lineHeight: 1.35 }}>
                {[origin.city, origin.country].filter(Boolean).join(", ")}
              </div>
            </div>
          )}
          {origin && dest && (
            <div style={{ opacity: 0.35, alignSelf: "center", fontSize: "1rem", padding: "0 2px" }}>→</div>
          )}
          {dest && (
            <div style={{ flex: 1, textAlign: "right" }}>
              <div style={{ ...mono, fontSize: "2rem", fontWeight: 800, color: "#00ff41", lineHeight: 1, letterSpacing: 1 }}>
                {dest.code}
              </div>
              <div style={{ fontSize: "0.72rem", opacity: 0.65, marginTop: 3, lineHeight: 1.35 }}>
                {[dest.city, dest.country].filter(Boolean).join(", ")}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Gate / Terminal / Airport names ── */}
      {(detail.gateOrigin || origin?.name || detail.terminalDestination || dest?.name) && (
        <div style={{ fontSize: "0.78rem", lineHeight: 1.75, marginBottom: 12 }}>
          {(detail.gateOrigin || origin?.name) && (
            <div>
              {detail.gateOrigin && <div>left Gate {detail.gateOrigin}</div>}
              {origin?.name && (
                <div style={{ opacity: 0.6 }}>
                  {origin.name}{origin.code ? ` — ${origin.code}` : ""}
                </div>
              )}
            </div>
          )}
          {(detail.terminalDestination || dest?.name) && (
            <div style={{ marginTop: detail.gateOrigin || origin?.name ? 6 : 0 }}>
              {detail.terminalDestination && <div>arriving at Terminal {detail.terminalDestination}</div>}
              {dest?.name && (
                <div style={{ opacity: 0.6 }}>
                  {dest.name}{dest.code ? ` — ${dest.code}` : ""}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Departure ── */}
      {depFmt && (
        <div style={{ marginBottom: 10 }}>
          <div style={subLabel}>DEPARTED</div>
          <div style={{ ...mono, fontSize: "0.82rem" }}>{depFmt.dayLine}</div>
          <div style={{ fontSize: "0.82rem" }}>
            {depFmt.timeLine}
            {depDelay && (
              <span style={{ marginLeft: 7, opacity: 0.6, fontSize: "0.75rem" }}>{depDelay}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Arrival ── */}
      {arrFmt && (
        <div style={{ marginBottom: 14 }}>
          <div style={subLabel}>{detail.actualIn ? "ARRIVED" : "EST. ARRIVAL"}</div>
          <div style={{ ...mono, fontSize: "0.82rem" }}>{arrFmt.dayLine}</div>
          <div style={{ fontSize: "0.82rem" }}>
            {arrFmt.timeLine}
            {arrDelay && (
              <span style={{ marginLeft: 7, opacity: 0.6, fontSize: "0.75rem" }}>{arrDelay}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Time progress ── */}
      {(totalMs || elapsedMs || remainingMs) && (
        <div style={{ ...sep, fontSize: "0.78rem", lineHeight: 1.8, marginBottom: 0 }}>
          {elapsedMs != null && elapsedMs > 0 && <div>{fmtDuration(elapsedMs)} elapsed</div>}
          {totalMs   != null && totalMs > 0   && <div>{fmtDuration(totalMs)} total travel time</div>}
          {remainingMs != null && remainingMs > 0 && <div>{fmtDuration(remainingMs)} remaining</div>}
        </div>
      )}

      {/* ── Distance progress ── */}
      {totalMi != null && (
        <div style={{ fontSize: "0.78rem", lineHeight: 1.8, marginBottom: 12 }}>
          {milesFlown != null && milesFlown > 0 && <div>{fmtMiles(milesFlown)} flown</div>}
          {milesToGo  != null && milesToGo  > 0 && <div>{fmtMiles(milesToGo)} to go</div>}
        </div>
      )}

      {/* ── Status flags ── */}
      {detail.diverted  && <div style={{ fontSize: "0.78rem", color: "#fbbf24", marginBottom: 4 }}>⚠ Diverted</div>}
      {detail.cancelled && <div style={{ fontSize: "0.78rem", color: "#f87171", marginBottom: 4 }}>✕ Cancelled</div>}

      {/* ── "Not your flight?" link ── */}
      {schedIdent && (
        <div style={{ fontSize: "0.74rem", opacity: 0.6, marginTop: 6 }}>
          Not your flight?{" "}
          <a
            href={`https://www.flightaware.com/live/flight/${encodeURIComponent(linkIdent)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#00ff41", textDecoration: "underline" }}
          >
            {schedIdent} flight schedule
          </a>
        </div>
      )}
    </div>
  );
}

// ── NASA GIBS / EOX layer configs ────────────────────────────
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().split("T")[0];

// ── SVG Icons ─────────────────────────────────────────────────
const SatelliteIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 7 9 3 5 7l4 4" /><path d="m17 11 4 4-4 4-4-4" /><path d="m8 12 4 4 6-6-4-4Z" /><path d="m16 8 3-3" /><path d="M9 21a6 6 0 0 0-6-6" />
  </svg>
);
const MapIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" /><line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);
const MoonIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
const HomeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);
const PlaneIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 2c-2-2-4-2-5.5-.5L10 5 1.8 6.2c-.5.1-.7.6-.4 1L4 10l2 2-2 2-2.5.4c-.4.1-.6.6-.3.9L4 18l2 2 .4-2.5L9 15l2 2 3 2c.4.3.9.1 1-.4z" />
  </svg>
);
const LayersIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// ── Helpers ───────────────────────────────────────────────────
/**
 * Injects Cesium.js once and waits until `window.Cesium` is actually defined.
 * A bare `script` tag in the DOM is not enough — the bundle may still be executing
 * (and duplicate visits must not resolve early).
 */
function loadCesiumScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const err = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    const waitForGlobal = () => {
      const deadline = Date.now() + 30_000;
      const step = () => {
        const w = window as unknown as { Cesium?: { Ion?: unknown } };
        if (w.Cesium?.Ion != null) {
          ok();
          return;
        }
        if (Date.now() > deadline) {
          err("Timed out waiting for Cesium (window.Cesium.Ion never appeared)");
          return;
        }
        requestAnimationFrame(step);
      };
      step();
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      const w = window as unknown as { Cesium?: { Ion?: unknown } };
      if (w.Cesium?.Ion != null) {
        ok();
        return;
      }
      existing.addEventListener("load", waitForGlobal, { once: true });
      existing.addEventListener("error", () => err(`Failed to load ${src}`), { once: true });
      queueMicrotask(waitForGlobal);
      return;
    }

    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => waitForGlobal();
    s.onerror = () => err(`Failed to load ${src}`);
    document.head.appendChild(s);
  });
}
function loadCSS(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href;
  document.head.appendChild(l);
}

/** Great-circle destination: true heading °, distance in nautical miles. */
function destinationLatLonNm(latDeg: number, lonDeg: number, headingDeg: number, distanceNm: number): { lat: number; lon: number } {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const R = 3440.065;
  const δ = distanceNm / R;
  const θ = toRad(headingDeg);
  const φ1 = toRad(latDeg);
  const λ1 = toRad(lonDeg);
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  let lon = toDeg(λ2);
  lon = ((lon + 540) % 360) - 180;
  return { lat: toDeg(φ2), lon };
}

// ── Heading compass ───────────────────────────────────────────
function HeadingDial({ heading }: { heading: number }) {
  return (
    <div className="hdg-dial">
      <svg viewBox="0 0 80 80" width="80" height="80">
        <circle cx="40" cy="40" r="36" fill="none" stroke="#1a2a1a" strokeWidth="2" />
        <circle cx="40" cy="40" r="36" fill="none" stroke="#0f3" strokeWidth="0.5" strokeDasharray="4 8" />
        {["N","E","S","W"].map((d, i) => {
          const angle = i * 90;
          const rad = (angle - 90) * Math.PI / 180;
          const x = 40 + 28 * Math.cos(rad);
          const y = 40 + 28 * Math.sin(rad);
          return <text key={d} x={x} y={y} textAnchor="middle" dominantBaseline="central" fill="#0f3" fontSize="8" fontFamily="monospace" fontWeight="bold">{d}</text>;
        })}
        {/* Heading arrow */}
        <g transform={`rotate(${heading}, 40, 40)`}>
          <polygon points="40,10 43,38 40,34 37,38" fill="#0f3" />
          <polygon points="40,70 43,42 40,46 37,42" fill="#333" />
        </g>
        <circle cx="40" cy="40" r="3" fill="#0f3" />
      </svg>
      <div className="hdg-value">{heading.toString().padStart(3, "0")}°</div>
    </div>
  );
}

// ── Altitude bar ──────────────────────────────────────────────
function AltBar({ altFt }: { altFt: number }) {
  const maxFt = 45000;
  const pct = Math.min(100, (altFt / maxFt) * 100);
  const color = altFt < 10000 ? "#ffff00" : altFt < 30000 ? "#00ffff" : "#cc88ff";
  return (
    <div className="alt-bar-wrap">
      <div className="alt-bar-track">
        <div className="alt-bar-fill" style={{ height: `${pct}%`, background: color }} />
      </div>
      <div className="alt-bar-labels">
        <span style={{ color }}>FL{Math.round(altFt / 100).toString().padStart(3, "0")}</span>
        <span>{altFt.toLocaleString()} ft</span>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────
export default function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const handlerRef = useRef<any>(null);
  const entitiesRef = useRef<Map<string, any>>(new Map());
  const aircraftDataRef = useRef<Map<string, AircraftData>>(new Map());
  /** Per ICAO: [lon, lat, altM][] from recent polls (where the track came from on the map). */
  const aircraftHistoryRef = useRef<Map<string, [number, number, number][]>>(new Map());
  const aircraftTrackOverlayRef = useRef<{ history: any | null; forward: any | null } | null>(null);
  const selectedAcRef = useRef<AircraftData | null>(null);

  // Vessel tracking
  const vesselEntitiesRef = useRef<Map<string, any>>(new Map());    // mmsi → billboard entity
  const vesselTrailsRef = useRef<Map<string, any>>(new Map());      // mmsi → polyline entity
  const vesselHistoryRef = useRef<Map<string, [number,number][]>>(new Map()); // mmsi → [[lon,lat],...]
  const vesselDataRef = useRef<Map<string, VesselData>>(new Map());

  const [mode, setMode] = useState<ImageryMode>("satellite");
  const [coords, setCoords] = useState<CoordState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flightCount, setFlightCount] = useState(0);
  const [selectedAc, setSelectedAc] = useState<AircraftData | null>(null);
  const [showFlights, setShowFlights] = useState(true);
  const [showVessels, setShowVessels] = useState(true);
  const [vesselCount, setVesselCount] = useState(0);
  const [selectedVessel, setSelectedVessel] = useState<VesselData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [trackOriginPlace, setTrackOriginPlace] = useState("—");
  const [trackDestPlace, setTrackDestPlace] = useState("—");
  const [trackPlacesLoading, setTrackPlacesLoading] = useState(false);
  const [faDetail, setFaDetail] = useState<FlightAwareFlightDetail | null>(null);
  const [faError, setFaError] = useState<string | null>(null);
  const [faMatchedBy, setFaMatchedBy] = useState<"callsign" | "registration" | null>(null);
  const showFlightsRef = useRef(true);
  const showVesselsRef = useRef(true);

  useMockVesselLayer({
    viewer: ready ? viewerRef.current : null,
    showVesselsRef,
    vesselEntitiesRef,
    vesselTrailsRef,
    vesselHistoryRef,
    vesselDataRef,
    setVesselCount,
    setSelectedVessel,
    intervalMs: MOCK_VESSEL_TICK_MS,
  });

  useEffect(() => {
    selectedAcRef.current = selectedAc;
  }, [selectedAc]);

  useEffect(() => {
    const icao = selectedAc?.icao;
    if (!icao) {
      setTrackOriginPlace("—");
      setTrackDestPlace("—");
      setTrackPlacesLoading(false);
      setFaDetail(null);
      setFaError(null);
      setFaMatchedBy(null);
      return;
    }

    const ac = aircraftDataRef.current.get(icao);
    if (!ac) {
      setTrackPlacesLoading(false);
      return;
    }

    const hist = aircraftHistoryRef.current.get(icao) ?? [];
    const oldest = hist[0];
    const oLat = oldest ? oldest[1] : ac.lat;
    const oLon = oldest ? oldest[0] : ac.lon;
    const distNm = Math.min(45, Math.max(1.5, ac.speedKts * (AIRCRAFT_LOOKAHEAD_MINUTES / 60)));
    const destPt = destinationLatLonNm(ac.lat, ac.lon, ac.heading, distNm);

    let cancelled = false;
    setTrackPlacesLoading(true);
    setTrackOriginPlace("—");
    setTrackDestPlace("—");
    setFaDetail(null);
    setFaError(null);
    setFaMatchedBy(null);

    const run = async () => {
      const cs = (ac.callsign ?? "").trim();
      const reg = (ac.registration ?? "").trim();
      const tryFa = cs.length >= 3 || reg.length >= 2;

      if (tryFa && !cancelled) {
        try {
          const q = new URLSearchParams();
          if (cs.length >= 3) q.set("callsign", cs);
          if (reg.length >= 2) q.set("registration", reg);
          const faRes = await fetch(`/api/aircraft/flightaware?${q}`, { cache: "no-store" });
          const fa = (await faRes.json()) as FlightAwareFlightResponse;
          if (cancelled) return;
          setFaDetail(fa.flight);
          setFaMatchedBy(fa.matchedBy);
          setFaError(fa.error);

          let origin = fa.flight?.origin ? airportLabel(fa.flight.origin) : null;
          let dest = fa.flight?.destination ? airportLabel(fa.flight.destination) : null;

          if ((!origin || !dest) && !cancelled) {
            try {
              const params = new URLSearchParams();
              if (!origin) {
                params.set("olat", oLat.toFixed(5));
                params.set("olon", oLon.toFixed(5));
              }
              if (!dest) {
                params.set("dlat", destPt.lat.toFixed(5));
                params.set("dlon", destPt.lon.toFixed(5));
              }
              if (params.toString()) {
                const geoRes = await fetch(`/api/geocode/places?${params}`);
                const geo = (await geoRes.json()) as { origin?: string; destination?: string };
                if (!origin && geo.origin) origin = geo.origin;
                if (!dest && geo.destination) dest = geo.destination;
              }
            } catch {
              if (!origin) origin = "Place lookup failed";
              if (!dest) dest = "Place lookup failed";
            }
          }

          if (!cancelled) {
            setTrackOriginPlace(origin ?? "—");
            setTrackDestPlace(dest ?? "—");
          }
        } catch {
          if (!cancelled) {
            setFaError("flightaware_fetch_failed");
            try {
              const params = new URLSearchParams({
                olat: oLat.toFixed(5),
                olon: oLon.toFixed(5),
                dlat: destPt.lat.toFixed(5),
                dlon: destPt.lon.toFixed(5),
              });
              const geoRes = await fetch(`/api/geocode/places?${params}`);
              const geo = (await geoRes.json()) as { origin?: string; destination?: string };
              setTrackOriginPlace(geo.origin ?? "—");
              setTrackDestPlace(geo.destination ?? "—");
            } catch {
              setTrackOriginPlace("Place lookup failed");
              setTrackDestPlace("Place lookup failed");
            }
          }
        }
      } else if (!cancelled) {
        try {
          const params = new URLSearchParams({
            olat: oLat.toFixed(5),
            olon: oLon.toFixed(5),
            dlat: destPt.lat.toFixed(5),
            dlon: destPt.lon.toFixed(5),
          });
          const geoRes = await fetch(`/api/geocode/places?${params}`);
          const geo = (await geoRes.json()) as { origin?: string; destination?: string };
          setTrackOriginPlace(geo.origin ?? "—");
          setTrackDestPlace(geo.destination ?? "—");
        } catch {
          setTrackOriginPlace("Place lookup failed");
          setTrackDestPlace("Place lookup failed");
        }
      }

      if (!cancelled) setTrackPlacesLoading(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [selectedAc?.icao, selectedAc?.callsign, selectedAc?.registration]);

  const clearAircraftTrackOverlays = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const o = aircraftTrackOverlayRef.current;
    if (o?.history) try { viewer.entities.remove(o.history); } catch { /* noop */ }
    if (o?.forward) try { viewer.entities.remove(o.forward); } catch { /* noop */ }
    aircraftTrackOverlayRef.current = null;
  }, []);

  const syncSelectedAircraftTrackOverlays = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const Cesium = (window as any).Cesium;
    if (!Cesium) return;

    clearAircraftTrackOverlays();
    if (!showFlightsRef.current) return;
    const sel = selectedAcRef.current;
    if (!sel) return;

    const ac = aircraftDataRef.current.get(sel.icao);
    if (!ac) return;

    const Ellipsoid = Cesium.Ellipsoid.WGS84;
    const hist = aircraftHistoryRef.current.get(ac.icao) ?? [];
    const trailColor = Cesium.Color.fromCssColorString(altColorCss(ac.altM)).withAlpha(0.42);

    let histEntity: any = null;
    if (hist.length >= 2) {
      const positions = hist.map(([lon, lat, altM]) =>
        Cesium.Cartesian3.fromDegrees(lon, lat, altM, Ellipsoid)
      );
      histEntity = viewer.entities.add({
        id: `ac_track_hist_${ac.icao}`,
        polyline: {
          positions,
          width: 2,
          arcType: Cesium.ArcType.GEODESIC,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.06,
            color: trailColor,
          }),
        },
      });
    }

    const distNm = Math.min(45, Math.max(1.5, ac.speedKts * (AIRCRAFT_LOOKAHEAD_MINUTES / 60)));
    const dest = destinationLatLonNm(ac.lat, ac.lon, ac.heading, distNm);
    const forwardColor = Cesium.Color.fromCssColorString("#a8ffc8").withAlpha(0.9);
    const forwardEntity = viewer.entities.add({
      id: `ac_track_fwd_${ac.icao}`,
      polyline: {
        positions: [
          Cesium.Cartesian3.fromDegrees(ac.lon, ac.lat, ac.altM, Ellipsoid),
          Cesium.Cartesian3.fromDegrees(dest.lon, dest.lat, ac.altM, Ellipsoid),
        ],
        width: 2.5,
        arcType: Cesium.ArcType.GEODESIC,
        material: new Cesium.PolylineDashMaterialProperty({
          color: forwardColor,
          gapColor: Cesium.Color.TRANSPARENT,
          dashLength: 14,
        }),
      },
    });

    aircraftTrackOverlayRef.current = { history: histEntity, forward: forwardEntity };
  }, [clearAircraftTrackOverlays]);

  useEffect(() => {
    if (!ready) return;
    syncSelectedAircraftTrackOverlays();
  }, [ready, selectedAc, showFlights, syncSelectedAircraftTrackOverlays]);

  useAircraftLayer({
    viewer: ready ? viewerRef.current : null,
    showFlightsRef,
    entitiesRef,
    aircraftDataRef,
    aircraftHistoryRef,
    setFlightCount,
    setLastUpdate,
    setSelectedAc,
    onAfterUpdate: syncSelectedAircraftTrackOverlays,
    intervalMs: AIRCRAFT_POLL_MS,
  });

  // ── Init ──────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        loadCSS(`${CESIUM_CDN}/Widgets/widgets.css`);
        (window as any).CESIUM_BASE_URL = `${CESIUM_CDN}/`;
        await loadCesiumScript(`${CESIUM_CDN}/Cesium.js`);
        if (!active || !containerRef.current) return;

        const Cesium = (window as any).Cesium;
        if (!Cesium?.Ion) {
          throw new Error("Cesium loaded but window.Cesium.Ion is missing");
        }
        Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;

        const viewer = new Cesium.Viewer(containerRef.current, {
          terrain: Cesium.Terrain.fromWorldTerrain(),
          baseLayer: Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2)),
          animation: false, baseLayerPicker: false, fullscreenButton: false,
          geocoder: false, homeButton: false, infoBox: false,
          sceneModePicker: false, selectionIndicator: false,
          timeline: false, navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
        });

        viewer.scene.globe.enableLighting = true;
        viewer.scene.fog.enabled = true;
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
        viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-98.5, 39.5, 8_000_000), duration: 0 });

        viewerRef.current = viewer;
        if (active) setReady(true);

        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handlerRef.current = handler;

        handler.setInputAction((e: any) => {
          const ray = viewer.camera.getPickRay(e.endPosition);
          if (!ray) return;
          const pos = viewer.scene.globe.pick(ray, viewer.scene);
          if (!pos) { setCoords(null); return; }
          const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(pos);
          setCoords({
            lat: Cesium.Math.toDegrees(carto.latitude).toFixed(4),
            lon: Cesium.Math.toDegrees(carto.longitude).toFixed(4),
            alt: (viewer.camera.positionCartographic.height / 1000).toFixed(1),
          });
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        handler.setInputAction((e: any) => {
          const picked = viewer.scene.pick(e.position);
          if (Cesium.defined(picked) && picked.id?.id) {
            const entityId: string = picked.id.id;
            if (entityId.startsWith("vessel_")) {
              const mmsi = entityId.replace("vessel_", "");
              const vessel = vesselDataRef.current.get(mmsi);
              if (vessel) { setSelectedVessel(vessel); setSelectedAc(null); }
            } else if (entityId.startsWith("ac_track_hist_") || entityId.startsWith("ac_track_fwd_")) {
              const icao = entityId.replace(/^ac_track_(?:hist|fwd)_/, "");
              const ac = aircraftDataRef.current.get(icao);
              if (ac) { setSelectedAc(ac); setSelectedVessel(null); }
            } else if (!entityId.startsWith("trail_")) {
              const ac = aircraftDataRef.current.get(entityId);
              if (ac) { setSelectedAc(ac); setSelectedVessel(null); }
            }
          } else {
            setSelectedAc(null);
            setSelectedVessel(null);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      } catch (err) {
        console.error(err);
        if (active) setError("Failed to initialise globe.");
      }
    };

    init();
    return () => {
      active = false;
      handlerRef.current?.destroy();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) viewerRef.current.destroy();
    };
  }, []);

  const toggleFlights = useCallback(() => {
    const next = !showFlightsRef.current;
    showFlightsRef.current = next;
    setShowFlights(next);
    for (const entity of entitiesRef.current.values()) {
      entity.billboard.show = next;
      entity.label.show = next;
    }
    if (!next) clearAircraftTrackOverlays();
  }, [clearAircraftTrackOverlays]);

  const switchImagery = useCallback(async (newMode: ImageryMode) => {
    if (!viewerRef.current || newMode === mode) return;
    setMode(newMode);
    const Cesium = (window as any).Cesium;
    const layers = viewerRef.current.scene.imageryLayers;
    layers.removeAll();

    if (newMode === "satellite") {
      // Bing Aerial via Cesium Ion
      layers.add(Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2)));

    } else if (newMode === "osm") {
      layers.add(new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })));

    } else if (newMode === "dark") {
      layers.add(Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(3812)));

    } else if (newMode === "sentinel2") {
      // Sentinel-2 Cloudless 2023 mosaic from EOX — free, no API key
      layers.add(new Cesium.ImageryLayer(
        new Cesium.WebMapTileServiceImageryProvider({
          url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{TileMatrix}/{TileRow}/{TileCol}.jpg",
          layer: "s2cloudless-2023_3857",
          style: "default",
          format: "image/jpeg",
          tileMatrixSetID: "g",
          maximumLevel: 14,
          credit: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH",
        })
      ));

    } else if (newMode === "viirs") {
      // VIIRS SNPP Near-Daily True Color from NASA GIBS — free, no API key
      layers.add(new Cesium.ImageryLayer(
        new Cesium.WebMapTileServiceImageryProvider({
          url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/" + YESTERDAY + "/GoogleMapsCompatible_Level9/{TileMatrix}/{TileRow}/{TileCol}.jpg",
          layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
          style: "default",
          format: "image/jpeg",
          tileMatrixSetID: "GoogleMapsCompatible_Level9",
          maximumLevel: 9,
          credit: "NASA GIBS – VIIRS SNPP True Color",
        })
      ));

    } else if (newMode === "modis") {
      // MODIS Terra Daily True Color from NASA GIBS — free, no API key
      layers.add(new Cesium.ImageryLayer(
        new Cesium.WebMapTileServiceImageryProvider({
          url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/" + YESTERDAY + "/GoogleMapsCompatible_Level9/{TileMatrix}/{TileRow}/{TileCol}.jpg",
          layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
          style: "default",
          format: "image/jpeg",
          tileMatrixSetID: "GoogleMapsCompatible_Level9",
          maximumLevel: 9,
          credit: "NASA GIBS – MODIS Terra True Color",
        })
      ));
    }
  }, [mode]);

  const flyHome = useCallback(() => {
    if (!viewerRef.current) return;
    const Cesium = (window as any).Cesium;
    viewerRef.current.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-98.5, 39.5, 8_000_000), duration: 1.5 });
  }, []);

  const toggleVessels = useCallback(() => {
    const next = !showVesselsRef.current;
    showVesselsRef.current = next;
    setShowVessels(next);
    for (const e of vesselEntitiesRef.current.values()) {
      e.billboard.show = next; e.label.show = next;
    }
    for (const t of vesselTrailsRef.current.values()) {
      t.polyline.show = next;
    }
  }, []);

  const flyToVessel = useCallback(() => {
    if (!selectedVessel || !viewerRef.current) return;
    const Cesium = (window as any).Cesium;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(selectedVessel.lon, selectedVessel.lat, 200_000),
      duration: 2,
    });
  }, [selectedVessel]);

  const flyToAircraft = useCallback(() => {
    if (!selectedAc || !viewerRef.current) return;
    const Cesium = (window as any).Cesium;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(selectedAc.lon, selectedAc.lat, 800_000),
      duration: 2,
    });
  }, [selectedAc]);

  // ── Render ────────────────────────────────────────────────────
  return (
    <>
      <div id="cesiumContainer" ref={containerRef} />

      {/* Header */}
      <header className="hud">
        <div className="hud-logo">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-label="Globe" xmlns="http://www.w3.org/2000/svg">
            <circle cx="16" cy="16" r="14" stroke="rgba(255,255,255,0.9)" strokeWidth="1.5" />
            <ellipse cx="16" cy="16" rx="6" ry="14" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" />
            <line x1="2" y1="16" x2="30" y2="16" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <line x1="4" y1="10" x2="28" y2="10" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
            <line x1="4" y1="22" x2="28" y2="22" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
          </svg>
          <div>
            <div className="hud-title">CesiumJS Globe</div>
            <div className="hud-subtitle">Next.js · 3D Terrain</div>
          </div>
        </div>
      </header>

      {error && (
        <div style={{ position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:"#f87171",fontSize:"1rem",background:"#0b0e14" }}>
          {error}
        </div>
      )}

      {/* Controls */}
      {ready && (
        <nav className="controls">
          <button className={`ctrl-btn${mode==="satellite"?" active":""}`} onClick={() => switchImagery("satellite")}><SatelliteIcon />Bing</button>
          <div className="ctrl-divider" />
          <button className={`ctrl-btn${mode==="sentinel2"?" active":""}`} onClick={() => switchImagery("sentinel2")}><LayersIcon />Sentinel-2</button>
          <div className="ctrl-divider" />
          <button className={`ctrl-btn${mode==="viirs"?" active":""}`} onClick={() => switchImagery("viirs")}><LayersIcon />VIIRS</button>
          <div className="ctrl-divider" />
          <button className={`ctrl-btn${mode==="modis"?" active":""}`} onClick={() => switchImagery("modis")}><LayersIcon />MODIS</button>
          <div className="ctrl-divider" />
          <button className={`ctrl-btn${mode==="osm"?" active":""}`} onClick={() => switchImagery("osm")}><MapIcon />Streets</button>
          <div className="ctrl-divider" />
          <button className={`ctrl-btn${mode==="dark"?" active":""}`} onClick={() => switchImagery("dark")}><MoonIcon />Night</button>
          <div className="ctrl-divider" />
          <button className="ctrl-btn" onClick={flyHome}><HomeIcon />Reset</button>
          <div className="ctrl-divider" />
          <button className={`ctrl-btn${!showFlights?" active":""}`} onClick={toggleFlights}><PlaneIcon />{showFlights?"Hide":"Show"} Planes</button>
          <div className="ctrl-divider" />
          <button className={`ctrl-btn${!showVessels?" active":""}`} onClick={toggleVessels}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2 20h20M5 20V10l7-7 7 7v10M9 20v-5h6v5"/>
            </svg>
            {showVessels?"Hide":"Show"} Ships
          </button>
        </nav>
      )}

      {/* Counters */}
      {ready && (flightCount > 0 || vesselCount > 0) && (
        <div className="flight-counter">
          <span className="counter-dot" />
          {flightCount > 0 && <>{flightCount} AIRCRAFT</>}
          {flightCount > 0 && vesselCount > 0 && <span className="counter-sep">|</span>}
          {vesselCount > 0 && <>{vesselCount} VESSELS</>}
          {lastUpdate && <span className="counter-time">{lastUpdate}</span>}
        </div>
      )}

      {/* ── Military Sidebar ─────────────────────────────────── */}
      <div className={`mil-sidebar${selectedAc ? " open" : ""}`}>
        {selectedAc ? (
          <>
            {/* Header bar */}
            <div className="mil-header">
              <div className="mil-header-left">
                <div className="mil-tag">TGT ACQUIRED</div>
                <div className="mil-callsign">{selectedAc.callsign}</div>
                {selectedAc.registration && <div className="mil-reg">{selectedAc.registration}</div>}
              </div>
              <button className="mil-close" onClick={() => setSelectedAc(null)}><CloseIcon /></button>
            </div>

            {/* Emergency banner */}
            {selectedAc.emergency && (
              <div className="mil-emergency">⚠ EMERGENCY: {selectedAc.emergency.toUpperCase()}</div>
            )}

            {/* Gauges row */}
            <div className="mil-gauges">
              <HeadingDial heading={selectedAc.heading} />
              <AltBar altFt={selectedAc.altFt} />
            </div>

            {/* Data grid */}
            <div className="mil-grid">
              <div className="mil-cell">
                <div className="mil-label">SPEED</div>
                <div className="mil-value">{selectedAc.speedKts} <span className="mil-unit">KTS</span></div>
              </div>
              <div className="mil-cell">
                <div className="mil-label">VERT RATE</div>
                <div className={`mil-value ${selectedAc.verticalRate > 0 ? "mil-climb" : selectedAc.verticalRate < 0 ? "mil-descend" : ""}`}>
                  {selectedAc.verticalRate > 0 ? "▲" : selectedAc.verticalRate < 0 ? "▼" : "—"} {Math.abs(selectedAc.verticalRate)} <span className="mil-unit">FT/M</span>
                </div>
              </div>
              <div className="mil-cell">
                <div className="mil-label">SQUAWK</div>
                <div className="mil-value">{selectedAc.squawk || "—"}</div>
              </div>
              <div className="mil-cell">
                <div className="mil-label">ICAO HEX</div>
                <div className="mil-value">{selectedAc.icao.toUpperCase()}</div>
              </div>
              <div className="mil-cell mil-cell-wide">
                <div className="mil-label">POSITION</div>
                <div className="mil-value mil-mono">{selectedAc.lat.toFixed(4)}° N &nbsp; {selectedAc.lon.toFixed(4)}° E</div>
              </div>
              {selectedAc.type && (
                <div className="mil-cell mil-cell-wide">
                  <div className="mil-label">AIRCRAFT TYPE</div>
                  <div className="mil-value">{selectedAc.type}{selectedAc.typeDesc ? ` — ${selectedAc.typeDesc}` : ""}</div>
                </div>
              )}
              {selectedAc.operator && (
                <div className="mil-cell mil-cell-wide">
                  <div className="mil-label">OPERATOR</div>
                  <div className="mil-value">{selectedAc.operator}</div>
                </div>
              )}
              {!faDetail?.origin && (
                <div className="mil-cell mil-cell-wide">
                  <div className="mil-label">ORIGIN</div>
                  <div className="mil-value">{trackPlacesLoading ? "…" : trackOriginPlace}</div>
                </div>
              )}
              {!faDetail?.destination && (
                <div className="mil-cell mil-cell-wide">
                  <div className="mil-label">DESTINATION</div>
                  <div className="mil-value">{trackPlacesLoading ? "…" : trackDestPlace}</div>
                </div>
              )}
            </div>

            {/* FlightAware AeroAPI */}
            <FlightAwareCard
              detail={faDetail}
              faError={faError}
              loading={trackPlacesLoading}
              callsign={selectedAc.callsign ?? ""}
            />

            {/* Fly to button */}
            <button className="mil-flyto" onClick={flyToAircraft}>
              <PlaneIcon /> FLY TO TARGET
            </button>

            {/* Altitude legend */}
            <div className="mil-legend">
              <span className="leg-dot" style={{background:"#ffff00"}} /> &lt;10k ft &nbsp;
              <span className="leg-dot" style={{background:"#00ffff"}} /> 10–30k ft &nbsp;
              <span className="leg-dot" style={{background:"#cc88ff"}} /> &gt;30k ft
            </div>
          </>
        ) : (
          <div className="mil-empty">
            <PlaneIcon />
            <p>SELECT A TARGET</p>
            <p className="mil-empty-sub">Click any aircraft on the globe</p>
          </div>
        )}
      </div>

      {/* ── Vessel Sidebar ───────────────────────────────────── */}
      {selectedVessel && !selectedAc && (
        <div className="mil-sidebar open">
          <div className="mil-header">
            <div className="mil-header-left">
              <div className="mil-tag">AIS · {shipTypeLabel(selectedVessel.shipType)}</div>
              <div className="mil-callsign" style={{ color: shipColorCss(selectedVessel.shipType) }}>
                {selectedVessel.name || selectedVessel.mmsi}
              </div>
              {selectedVessel.callsign && <div className="mil-reg">{selectedVessel.callsign}</div>}
            </div>
            <button className="mil-close" onClick={() => setSelectedVessel(null)}><CloseIcon /></button>
          </div>

          <div className="mil-gauges">
            <HeadingDial heading={Math.round(selectedVessel.heading)} />
            {/* Speed gauge */}
            <div className="hdg-dial">
              <div style={{ fontSize: "1.8rem", fontWeight: 800, fontFamily: "JetBrains Mono", color: shipColorCss(selectedVessel.shipType), textShadow: `0 0 12px ${shipColorCss(selectedVessel.shipType)}` }}>
                {selectedVessel.sog.toFixed(1)}
              </div>
              <div className="hdg-value">KTS SOG</div>
            </div>
          </div>

          <div className="mil-grid">
            <div className="mil-cell">
              <div className="mil-label">MMSI</div>
              <div className="mil-value">{selectedVessel.mmsi}</div>
            </div>
            <div className="mil-cell">
              <div className="mil-label">COURSE</div>
              <div className="mil-value">{Math.round(selectedVessel.cog)}°</div>
            </div>
            <div className="mil-cell mil-cell-wide">
              <div className="mil-label">POSITION</div>
              <div className="mil-value mil-mono">{selectedVessel.lat.toFixed(4)}° N &nbsp; {selectedVessel.lon.toFixed(4)}° E</div>
            </div>
            {selectedVessel.destination && (
              <div className="mil-cell mil-cell-wide">
                <div className="mil-label">DESTINATION</div>
                <div className="mil-value">{selectedVessel.destination}</div>
              </div>
            )}
            {selectedVessel.draught > 0 && (
              <div className="mil-cell">
                <div className="mil-label">DRAUGHT</div>
                <div className="mil-value">{selectedVessel.draught.toFixed(1)} <span className="mil-unit">M</span></div>
              </div>
            )}
            {selectedVessel.length > 0 && (
              <div className="mil-cell">
                <div className="mil-label">LENGTH</div>
                <div className="mil-value">{selectedVessel.length} <span className="mil-unit">M</span></div>
              </div>
            )}
          </div>

          <button className="mil-flyto" style={{ borderColor: shipColorCss(selectedVessel.shipType), color: shipColorCss(selectedVessel.shipType) }} onClick={flyToVessel}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}><path d="M22 12A10 10 0 1 1 12 2"/><path d="M22 2 11 13"/><path d="M22 2h-7M22 2v7"/></svg>
            FLY TO VESSEL
          </button>

          <div className="mil-legend">
            <span className="leg-dot" style={{background:"#ffa500"}} /> Cargo &nbsp;
            <span className="leg-dot" style={{background:"#ff4444"}} /> Tanker &nbsp;
            <span className="leg-dot" style={{background:"#44aaff"}} /> Passenger &nbsp;
            <span className="leg-dot" style={{background:"#44ff88"}} /> Fishing
          </div>
        </div>
      )}

      {/* Coords */}
      {coords && (
        <div className="coords">
          {coords.lat}° N &nbsp; {coords.lon}° E<br />{coords.alt} km alt
        </div>
      )}
    </>
  );
}
