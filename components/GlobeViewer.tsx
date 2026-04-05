"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useAircraftLayer } from "@/hooks/useAircraftLayer";
import { useAisVesselLayer } from "@/hooks/useAisVesselLayer";
import { useSatelliteLayer, computeSatInfo } from "@/hooks/useSatelliteLayer";
import { useConflictLayer } from "@/hooks/useConflictLayer";
import { useEarthquakeLayer } from "@/hooks/useEarthquakeLayer";
import { useWeatherLayer } from "@/hooks/useWeatherLayer";
import { altColorCss } from "@/lib/aircraftStyle";
import { airportLabel } from "@/lib/airportLabel";
import { shipColorCss, shipTypeLabel } from "@/lib/vesselBillboard";
import { satColorFromInclination } from "@/lib/satelliteIcon";
import { conflictColor, conflictTypeLabel, CONFLICT_COLORS } from "@/lib/conflictStyle";
import type { AircraftData } from "@/types/aircraft";
import type { FlightAwareFlightDetail, FlightAwareFlightResponse } from "@/types/flightAware";
import type { VesselData } from "@/types/vessel";
import type { SatelliteInfo } from "@/types/satellite";
import type { ConflictEvent } from "@/types/conflict";
import type { EarthquakeData } from "@/types/earthquake";
import type { SpaceWeather } from "@/app/api/spaceweather/route";

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
const AIS_POLL_MS = 60_000;

/** Key maritime regions for the AIS vessel layer. cam: [lat, lon, altitudeMeters] */
const SHIP_REGIONS = {
  global:  { label: "Global",             bbox: null                      as [number,number,number,number] | null, cam: null },
  hormuz:  { label: "Strait of Hormuz",   bbox: [22, 48, 30, 62]         as [number,number,number,number],        cam: [26.5,  56.5,  1_300_000] },
  malacca: { label: "Malacca Strait",     bbox: [1,  99, 7,  105]        as [number,number,number,number],        cam: [4.0,  102.0,    900_000] },
  suez:    { label: "Suez Canal",         bbox: [27, 31, 33, 36]         as [number,number,number,number],        cam: [30.0,   33.5,   800_000] },
  channel: { label: "English Channel",    bbox: [48, -5, 60, 12]         as [number,number,number,number],        cam: [51.0,    1.5,   700_000] },
  med:     { label: "Mediterranean",      bbox: [30, -8, 46, 42]         as [number,number,number,number],        cam: [38.0,   16.0, 2_500_000] },
  bosporus:{ label: "Bosphorus",          bbox: [40, 28, 42, 30]         as [number,number,number,number],        cam: [41.1,   29.0,   250_000] },
  houston: { label: "Gulf of Mexico",     bbox: [18, -98, 32, -80]       as [number,number,number,number],        cam: [25.0,  -89.0, 2_000_000] },
  singapore:{ label: "Singapore",         bbox: [1,  103, 2, 105]        as [number,number,number,number],        cam: [1.3,   103.8,   200_000] },
} as const;
type ShipRegionKey = keyof typeof SHIP_REGIONS;
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

/** Values map to # of GDELT 15-min files fetched (1 → 15 min, 4 → 1 hr, 8 → 2 hr). */
const CONFLICT_DAYS_OPTIONS = [1, 4, 6, 8] as const;
type ConflictDays = (typeof CONFLICT_DAYS_OPTIONS)[number];
const CONFLICT_DAYS_LABELS: Record<ConflictDays, string> = { 1: "15 min", 4: "1 hr", 6: "90 min", 8: "2 hr" };

// ── Conflict Event Card ────────────────────────────────────────
function ConflictCard({
  event,
  onClose,
}: {
  event: ConflictEvent;
  onClose: () => void;
}) {
  const color  = conflictColor(event.eventType);
  const label  = conflictTypeLabel(event.eventType);
  const border = `1px solid ${color}44`;

  return (
    <div className="mil-sidebar open">
      <div className="mil-header" style={{ borderBottom: border }}>
        <div className="mil-header-left">
          <div className="mil-tag" style={{ color, borderColor: color }}>
            {label} · {event.date}
          </div>
          <div className="mil-callsign" style={{ color, fontSize: "0.95rem" }}>
            {event.subEventType || event.eventType}
          </div>
          <div className="mil-reg">{event.country}{event.region ? ` · ${event.region}` : ""}</div>
        </div>
        <button className="mil-close" onClick={onClose}><CloseIcon /></button>
      </div>

      {/* Fatalities */}
      {event.fatalities > 0 && (
        <div style={{ padding: "10px 14px 0", display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: "2rem", fontWeight: 800, fontFamily: "JetBrains Mono", color: "#ff3333", textShadow: "0 0 12px #ff333388" }}>
            {event.fatalities.toLocaleString()}
          </span>
          <span style={{ fontSize: "0.7rem", color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            fatalities reported
          </span>
        </div>
      )}

      {/* Actors */}
      <div className="mil-grid" style={{ marginTop: 8 }}>
        {event.actor1 && (
          <div className="mil-cell mil-cell-wide">
            <div className="mil-label">ACTOR 1</div>
            <div className="mil-value" style={{ fontSize: "0.75rem" }}>{event.actor1}</div>
          </div>
        )}
        {event.actor2 && (
          <div className="mil-cell mil-cell-wide">
            <div className="mil-label">ACTOR 2</div>
            <div className="mil-value" style={{ fontSize: "0.75rem" }}>{event.actor2}</div>
          </div>
        )}
        <div className="mil-cell mil-cell-wide">
          <div className="mil-label">POSITION</div>
          <div className="mil-value mil-mono" style={{ fontSize: "0.72rem" }}>
            {event.lat.toFixed(4)}° N &nbsp; {event.lon.toFixed(4)}° E
          </div>
        </div>
      </div>

      {/* Notes */}
      {event.notes && (
        <div style={{ padding: "8px 14px", borderTop: border, fontSize: "0.7rem", color: "#aaa", lineHeight: 1.5, maxHeight: 140, overflowY: "auto" }}>
          {event.notes.length > 400 ? event.notes.slice(0, 400) + "…" : event.notes}
        </div>
      )}

      {/* Source */}
      {event.source && (
        <div style={{ padding: "4px 14px 10px", fontSize: "0.62rem", color: "#666" }}>
          SOURCE: {event.source}
        </div>
      )}

      {/* Legend */}
      <div className="mil-legend" style={{ flexWrap: "wrap", gap: "4px 10px" }}>
        {Object.entries(CONFLICT_COLORS).map(([type, c]) => (
          <span key={type} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span className="leg-dot" style={{ background: c }} />
            <span style={{ fontSize: "0.6rem" }}>{conflictTypeLabel(type)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const SAT_GROUPS = {
  visual:   "Visually Observable",
  stations: "Space Stations",
  weather:  "Weather Sats",
  starlink: "Starlink",
} as const;
type SatGroupKey = keyof typeof SAT_GROUPS;

// ── Satellite Info Card ────────────────────────────────────────
function SatelliteCard({
  sat,
  onClose,
  onFlyTo,
}: {
  sat: SatelliteInfo;
  onClose: () => void;
  onFlyTo: () => void;
}) {
  const color = satColorFromInclination(sat.inclination);
  const border = "1px solid rgba(0,255,65,0.18)";
  const row = (label: string, value: string) => (
    <div className="mil-cell">
      <div className="mil-label">{label}</div>
      <div className="mil-value">{value}</div>
    </div>
  );
  return (
    <div className="mil-sidebar open">
      <div className="mil-header">
        <div className="mil-header-left">
          <div className="mil-tag" style={{ color }}>SAT · NORAD {sat.noradId}</div>
          <div className="mil-callsign" style={{ color }}>{sat.name}</div>
        </div>
        <button className="mil-close" onClick={onClose}><CloseIcon /></button>
      </div>

      <div className="mil-grid" style={{ marginTop: 8 }}>
        {row("ALTITUDE", `${sat.altKm.toFixed(0)} km`)}
        {row("VELOCITY", `${sat.velKms.toFixed(2)} km/s`)}
        {row("INCLINATION", `${sat.inclination.toFixed(1)}°`)}
        {row("PERIOD", `${sat.periodMin.toFixed(1)} min`)}
        <div className="mil-cell mil-cell-wide" style={{ borderTop: border }}>
          <div className="mil-label">TLE EPOCH</div>
          <div className="mil-value mil-mono" style={{ fontSize: "0.7rem" }}>{sat.epoch}</div>
        </div>
      </div>

      <button
        className="mil-flyto"
        style={{ borderColor: color, color }}
        onClick={onFlyTo}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="10" /><path d="M12 8v4l3 3" />
        </svg>
        FLY TO SATELLITE
      </button>

      <div className="mil-legend" style={{ marginTop: 8, fontSize: "0.65rem" }}>
        <span className="leg-dot" style={{ background: "#ff6644" }} /> Polar/Sun-sync &nbsp;
        <span className="leg-dot" style={{ background: "#00ff88" }} /> ISS-like &nbsp;
        <span className="leg-dot" style={{ background: "#ffdd00" }} /> GEO &nbsp;
        <span className="leg-dot" style={{ background: "#00ddff" }} /> LEO
      </div>
    </div>
  );
}

// ── Dashboard overlay sub-components ──────────────────────────

/** World Monitor–style card grid docked at the bottom of the viewport. */
function DashboardGrid({
  flightCount, vesselCount, satCount, conflictCount, earthquakeCount,
  feedEvents, feedEarthquakes, shipRegion, satGroup, conflictError,
  onEventClick, onQuakeClick, onClose,
}: {
  flightCount: number; vesselCount: number; satCount: number;
  conflictCount: number; earthquakeCount: number;
  feedEvents: ConflictEvent[];
  feedEarthquakes: EarthquakeData[];
  shipRegion: string; satGroup: string;
  conflictError: string | null;
  onEventClick: (ev: ConflictEvent) => void;
  onQuakeClick: (eq: EarthquakeData) => void;
  onClose: () => void;
}) {
  const M = "'JetBrains Mono', monospace";
  const CARD_H = 242;

  // Space weather — fetch from /api/spaceweather every 5 min
  const [sw, setSw] = React.useState<SpaceWeather | null>(null);
  React.useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/spaceweather");
        if (r.ok) setSw(await r.json());
      } catch { /* silently ignore */ }
    };
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => clearInterval(id);
  }, []);

  // ── AI SITREP ─────────────────────────────────────────────
  const [sitrepText, setSitrepText]       = React.useState("");
  const [sitrepLoading, setSitrepLoading] = React.useState(false);
  const [sitrepTime, setSitrepTime]       = React.useState("");
  const [sitrepError, setSitrepError]     = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const generateSitrep = React.useCallback(async () => {
    if (sitrepLoading) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setSitrepLoading(true);
    setSitrepText("");
    setSitrepError(null);

    try {
      const res = await fetch("/api/sitrep", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conflicts:     feedEvents,
          earthquakes:   feedEarthquakes,
          spaceWeather:  sw,
          flightCount,
          vesselCount,
          newsHeadlines: newsArticles.slice(0, 10).map(a => a.title),
        }),
      });

      if (res.status === 503) { setSitrepError("no-key"); return; }
      if (!res.ok || !res.body) { setSitrepError(`HTTP ${res.status}`); return; }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let finished = false;
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { finished = true; break; }
          try {
            const obj = JSON.parse(payload) as { text?: string; error?: string };
            if (obj.error) { setSitrepError(obj.error); finished = true; break; }
            if (obj.text)  setSitrepText(prev => prev + obj.text);
          } catch { /* ignore malformed SSE chunks */ }
        }
        if (finished) { reader.cancel(); break; }
      }
      setSitrepTime(new Date().toISOString().slice(11, 16) + " UTC");
    } catch (err) {
      if ((err as Error).name !== "AbortError") setSitrepError((err as Error).message);
    } finally {
      setSitrepLoading(false);
    }
  // feedEvents / feedEarthquakes / sw / flightCount / vesselCount intentionally
  // excluded: we don't want to regenerate on every data tick; only on manual refresh
  // or the 20-min timer below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitrepLoading]);

  // Hold a stable ref so the interval always calls the freshest version
  const genRef = React.useRef(generateSitrep);
  genRef.current = generateSitrep;

  // Auto-generate 4 s after mount, then every 20 min
  React.useEffect(() => {
    const t = window.setTimeout(() => genRef.current(), 4_000);
    const i = window.setInterval(() => genRef.current(), 20 * 60_000);
    return () => { clearTimeout(t); clearInterval(i); abortRef.current?.abort(); };
  }, []); // fires once

  // ── News article feed (GDELT DOC API) ────────────────────
  type NewsArticle = { title: string; url: string; domain: string; seenAt: string; country: string };
  const [feedMode, setFeedMode]         = React.useState<"events" | "news">("events");
  const [newsArticles, setNewsArticles] = React.useState<NewsArticle[]>([]);
  const [newsLoading, setNewsLoading]   = React.useState(false);
  // Per-article streaming analysis: url → text
  const [analysisMap, setAnalysisMap]   = React.useState<Record<string, string>>({});
  const [analyzingUrl, setAnalyzingUrl] = React.useState<string | null>(null);
  const newsAbortRef = React.useRef<AbortController | null>(null);

  const loadNews = React.useCallback(async () => {
    setNewsLoading(true);
    try {
      const r = await fetch("/api/newsfeed");
      if (r.ok) {
        const data = await r.json() as { articles?: NewsArticle[] };
        setNewsArticles(data.articles ?? []);
      }
    } catch { /* ignore */ } finally { setNewsLoading(false); }
  }, []);

  React.useEffect(() => {
    loadNews();
    const id = setInterval(loadNews, 15 * 60_000);
    return () => clearInterval(id);
  }, [loadNews]);

  const analyzeArticle = React.useCallback(async (article: NewsArticle) => {
    if (analyzingUrl || analysisMap[article.url] !== undefined) return;
    newsAbortRef.current?.abort();
    const ctrl = new AbortController();
    newsAbortRef.current = ctrl;
    setAnalyzingUrl(article.url);
    setAnalysisMap(prev => ({ ...prev, [article.url]: "" }));
    try {
      const res = await fetch("/api/newsanalysis", {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: article.title, domain: article.domain, seenAt: article.seenAt, country: article.country }),
      });
      if (!res.ok || !res.body) { setAnalysisMap(prev => ({ ...prev, [article.url]: "Request failed." })); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        let finished = false;
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { finished = true; break; }
          try {
            const obj = JSON.parse(payload) as { text?: string; error?: string };
            if (obj.error) { setAnalysisMap(prev => ({ ...prev, [article.url]: obj.error! })); finished = true; break; }
            if (obj.text) setAnalysisMap(prev => ({ ...prev, [article.url]: (prev[article.url] ?? "") + obj.text }));
          } catch { /* ignore */ }
        }
        if (finished) { reader.cancel(); break; }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setAnalysisMap(prev => ({ ...prev, [article.url]: (err as Error).message }));
    } finally { setAnalyzingUrl(null); }
  }, [analyzingUrl, analysisMap]);

  // ── earthquake stats ──────────────────────────────────────
  const topQuakes = React.useMemo(
    () => [...feedEarthquakes].sort((a, b) => b.mag - a.mag).slice(0, 4),
    [feedEarthquakes],
  );
  const biggestQuake = topQuakes[0] ?? null;

  // ── derived data ──────────────────────────────────────────
  const hotRegions = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of feedEvents) m.set(ev.country, (m.get(ev.country) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [feedEvents]);

  const totalFatalities = React.useMemo(
    () => feedEvents.reduce((s, ev) => s + ev.fatalities, 0),
    [feedEvents],
  );

  const recentNews = React.useMemo(
    () => [...feedEvents].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
    [feedEvents],
  );

  function timeAgo(d: string) {
    const ms = Date.now() - new Date(d).getTime();
    if (isNaN(ms)) return d;
    const h = Math.floor(ms / 3_600_000);
    if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  // ── building blocks ────────────────────────────────────────
  const CARD: React.CSSProperties = {
    background: "#080e08", display: "flex", flexDirection: "column", overflow: "hidden",
    borderTop: "2px solid rgba(0,255,136,0.18)",
  };

  function Hdr({ title, right }: { title: string; right?: React.ReactNode }) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 11px 5px", borderBottom: "1px solid rgba(0,255,136,0.07)", flexShrink: 0, background: "rgba(0,255,136,0.015)" }}>
        <span style={{ fontFamily: M, fontSize: "0.5rem", fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase" as const, color: "rgba(0,255,136,0.38)" }}>{title}</span>
        {right}
      </div>
    );
  }

  function LivePill({ color = "#00ff88" }: { color?: string }) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 3, background: `${color}12`, border: `1px solid ${color}35`, borderRadius: 2, padding: "1px 6px" }}>
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: color, boxShadow: `0 0 5px ${color}` }} />
        <span style={{ fontFamily: M, fontSize: "0.4rem", fontWeight: 800, letterSpacing: "0.15em", color }}>LIVE</span>
      </div>
    );
  }

  function OffPill() {
    return (
      <div style={{ display: "inline-flex", background: "rgba(255,68,68,0.1)", border: "1px solid rgba(255,68,68,0.22)", borderRadius: 2, padding: "1px 6px" }}>
        <span style={{ fontFamily: M, fontSize: "0.4rem", fontWeight: 800, letterSpacing: "0.15em", color: "#ff5555" }}>OFFLINE</span>
      </div>
    );
  }

  function BigNum({ n, color }: { n: number; color: string }) {
    return (
      <span style={{ fontFamily: M, fontSize: "2.4rem", fontWeight: 800, color, lineHeight: 1, letterSpacing: "-0.02em" }}>
        {n > 0 ? n.toLocaleString() : "—"}
      </span>
    );
  }

  function MetaRow({ label, ok }: { label: string; ok: boolean }) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: ok ? "#00ff88" : "#ff4444", boxShadow: ok ? "0 0 4px #00ff88" : "none" }} />
        <span style={{ fontFamily: M, fontSize: "0.52rem", color: ok ? "rgba(0,255,136,0.5)" : "rgba(255,68,68,0.55)" }}>{label}</span>
      </div>
    );
  }

  function TypeTag({ ev }: { ev: ConflictEvent }) {
    const map: Record<string, [string, string]> = {
      "Battles": ["BATTLE", "#ff3333"],
      "Explosions/Remote violence": ["EXPL", "#ff7700"],
      "Violence against civilians": ["VIO", "#cc0044"],
      "Protests": ["PROTEST", "#ffdd00"],
      "Riots": ["RIOT", "#ff9900"],
    };
    const [label, color] = map[ev.eventType] ?? ["INTEL", "#aa55ff"];
    return (
      <span style={{ fontFamily: M, fontSize: "0.42rem", fontWeight: 800, letterSpacing: "0.06em", padding: "1px 4px", borderRadius: 2, background: `${color}1a`, border: `1px solid ${color}45`, color, flexShrink: 0 }}>
        {label}
      </span>
    );
  }

  /** Bold headline string from actors + event type + location. */
  function eventHeadline(ev: ConflictEvent): string {
    const a1 = ev.actor1?.trim() ?? "";
    const a2 = ev.actor2?.trim() ?? "";
    if (a1 && a2) {
      const s = `${a1} — ${a2}`;
      return s.length > 58 ? `${a1.slice(0, 48)}…` : s;
    }
    if (a1) return a1.length > 55 ? `${a1.slice(0, 52)}…` : a1;
    const place = ev.region?.split(",")[0]?.trim() || ev.country;
    const type  = ev.subEventType.startsWith("CAMEO") ? ev.eventType : ev.subEventType;
    return `${type} — ${place}`;
  }

  return (
    <div style={{ position: "fixed", left: 175, right: 0, bottom: 0, zIndex: 98, display: "flex", flexDirection: "column" }}>
      {/* ── Handle bar ─────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", height: 26, background: "#060c06", borderTop: "1px solid rgba(0,255,136,0.2)", boxShadow: "0 -4px 20px rgba(0,0,0,0.55)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: M, fontSize: "0.44rem", fontWeight: 800, letterSpacing: "0.3em", color: "rgba(0,255,136,0.3)", textTransform: "uppercase" }}>Intelligence Dashboard</span>
          <span className="live-dot" />
        </div>
        <button onClick={onClose} className="ui-reset" style={{ background: "transparent", border: "1px solid rgba(0,255,136,0.12)", borderRadius: 3, padding: "2px 9px", cursor: "pointer", fontFamily: M, fontSize: "0.43rem", fontWeight: 800, letterSpacing: "0.18em", color: "rgba(0,255,136,0.28)", textTransform: "uppercase", transition: "all 0.15s" }}>
          ▼ Minimize
        </button>
      </div>

      {/* ── Card grid ─────────────────────────────────────── */}
      <div style={{ height: CARD_H, display: "grid", gridTemplateColumns: "190px 1fr 1fr 1fr 1fr 1fr 1fr", gap: "1px", background: "rgba(0,255,136,0.05)", overflow: "hidden" }}>

        {/* ── LIVE FEED (Events | AI News) ── */}
        <div style={CARD}>
          {/* Header with tab toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 9px 4px", borderBottom: "1px solid rgba(0,255,136,0.07)", flexShrink: 0, background: "rgba(0,255,136,0.015)" }}>
            <span style={{ fontFamily: M, fontSize: "0.5rem", fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(0,255,136,0.38)" }}>Live Feed</span>
            <div style={{ display: "flex", gap: 2 }}>
              {(["events", "news"] as const).map(mode => (
                <button key={mode} onClick={() => setFeedMode(mode)} style={{
                  background: feedMode === mode ? "rgba(0,255,136,0.12)" : "transparent",
                  border: `1px solid ${feedMode === mode ? "rgba(0,255,136,0.35)" : "rgba(0,255,136,0.1)"}`,
                  borderRadius: 2, padding: "1px 6px", cursor: "pointer",
                  fontFamily: M, fontSize: "0.42rem", fontWeight: 700, letterSpacing: "0.1em",
                  color: feedMode === mode ? "rgba(0,255,136,0.8)" : "rgba(0,255,136,0.28)",
                  textTransform: "uppercase",
                }}>
                  {mode === "events" ? `EVT` : `AI`}
                </button>
              ))}
              {feedMode === "news" && newsLoading && (
                <span style={{ fontFamily: M, fontSize: "0.4rem", color: "rgba(168,85,247,0.5)", marginLeft: 3, alignSelf: "center" }}>…</span>
              )}
            </div>
          </div>

          {/* ── EVENTS tab ── */}
          {feedMode === "events" && (
            <div className="news-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {recentNews.length === 0 && (
                <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: M, fontSize: "0.55rem", color: "rgba(0,255,136,0.12)" }}>NO DATA</div>
              )}
              {recentNews.map(ev => {
                const headline = eventHeadline(ev);
                const articleUrl = ev.notes?.startsWith("http") ? ev.notes : ev.source?.startsWith("http") ? ev.source : null;
                const place = ev.region?.split(",").slice(0, 2).join(",").trim() || ev.country;
                return (
                  <button key={ev.id} className="news-item" onClick={() => onEventClick(ev)}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", border: "none", borderBottom: "1px solid rgba(0,255,136,0.04)", cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 5 }}>
                      <TypeTag ev={ev} />
                      <span style={{ fontFamily: M, fontSize: "0.49rem", color: "rgba(0,255,136,0.2)", marginLeft: "auto", flexShrink: 0 }}>{timeAgo(ev.date)}</span>
                    </div>
                    {articleUrl ? (
                      <a href={articleUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                        className="news-headline-link"
                        style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as React.CSSProperties["WebkitBoxOrient"], overflow: "hidden", fontFamily: M, fontSize: "0.6rem", fontWeight: 700, color: "#d4f5d4", lineHeight: 1.45, textDecoration: "none", marginBottom: 4 }}>
                        {headline}
                        <svg style={{ display: "inline", width: 9, height: 9, marginLeft: 3, verticalAlign: "middle", opacity: 0.5 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      </a>
                    ) : (
                      <div style={{ fontFamily: M, fontSize: "0.6rem", fontWeight: 700, color: "#d4f5d4", lineHeight: 1.45, marginBottom: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as React.CSSProperties["WebkitBoxOrient"], overflow: "hidden" }}>{headline}</div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                      <span style={{ fontFamily: M, fontSize: "0.5rem", color: "rgba(0,255,136,0.32)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{place}</span>
                      {ev.source && !ev.source.startsWith("http") && <span style={{ fontFamily: M, fontSize: "0.48rem", color: "rgba(0,255,136,0.2)", flexShrink: 0 }}>{ev.source}</span>}
                    </div>
                    {ev.fatalities > 0 && <div style={{ fontFamily: M, fontSize: "0.48rem", color: "#ff6644", marginTop: 3 }}>✦ {ev.fatalities} KIA</div>}
                  </button>
                );
              })}
            </div>
          )}

          {/* ── AI NEWS tab ── */}
          {feedMode === "news" && (
            <div className="news-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {newsArticles.length === 0 && !newsLoading && (
                <div style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: M, fontSize: "0.55rem", color: "rgba(0,255,136,0.12)" }}>LOADING…</div>
              )}
              {newsArticles.map(article => {
                const isAnalyzing = analyzingUrl === article.url;
                const analysis    = analysisMap[article.url];
                const hasAnalysis = analysis !== undefined;
                const relTime = article.seenAt ? timeAgo(article.seenAt) : "";
                return (
                  <div key={article.url} style={{ padding: "8px 10px", borderBottom: "1px solid rgba(0,255,136,0.04)" }}>
                    {/* Source + time */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontFamily: M, fontSize: "0.44rem", color: "rgba(168,85,247,0.55)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{article.domain}</span>
                      <span style={{ fontFamily: M, fontSize: "0.42rem", color: "rgba(0,255,136,0.2)", flexShrink: 0, marginLeft: 4 }}>{relTime}</span>
                    </div>
                    {/* Title linked */}
                    <a href={article.url} target="_blank" rel="noopener noreferrer"
                      className="news-headline-link"
                      style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as React.CSSProperties["WebkitBoxOrient"], overflow: "hidden", fontFamily: M, fontSize: "0.58rem", fontWeight: 700, color: "#d4f5d4", lineHeight: 1.45, textDecoration: "none" }}>
                      {article.title}
                      <svg style={{ display: "inline", width: 8, height: 8, marginLeft: 3, verticalAlign: "middle", opacity: 0.45 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                    {/* AI Analysis section */}
                    {!hasAnalysis && (
                      <button onClick={() => analyzeArticle(article)}
                        disabled={!!analyzingUrl}
                        style={{ marginTop: 5, background: "transparent", border: "1px solid rgba(168,85,247,0.25)", borderRadius: 2, cursor: analyzingUrl ? "default" : "pointer", padding: "2px 7px", fontFamily: M, fontSize: "0.42rem", fontWeight: 700, color: analyzingUrl ? "rgba(168,85,247,0.2)" : "rgba(168,85,247,0.6)", letterSpacing: "0.08em" }}>
                        ◉ ANALYZE
                      </button>
                    )}
                    {hasAnalysis && (
                      <div style={{ marginTop: 5, padding: "5px 7px", background: "rgba(168,85,247,0.05)", border: "1px solid rgba(168,85,247,0.12)", borderRadius: 2 }}>
                        <div style={{ fontFamily: M, fontSize: "0.49rem", lineHeight: 1.7, color: "rgba(200,180,255,0.75)" }}>
                          {analysis || <span style={{ color: "rgba(168,85,247,0.3)", fontStyle: "italic" }}>Analyzing…</span>}
                          {isAnalyzing && analysis && <span className="sitrep-cursor" style={{ color: "rgba(168,85,247,0.8)", marginLeft: 1 }}>▌</span>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── AIRCRAFT ── */}
        <div style={CARD}>
          <Hdr title="Aircraft" right={flightCount > 0 ? <LivePill /> : <OffPill />} />
          <div style={{ padding: "14px 13px 10px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <BigNum n={flightCount} color="#00ff88" />
              <div style={{ fontFamily: M, fontSize: "0.46rem", fontWeight: 700, letterSpacing: "0.2em", color: "rgba(0,255,136,0.22)", textTransform: "uppercase", marginTop: 6 }}>Active Flights</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <MetaRow label="OpenSky Network" ok={flightCount > 0} />
              <div style={{ fontFamily: M, fontSize: "0.52rem", color: "rgba(0,255,136,0.25)", letterSpacing: "0.04em" }}>ADS-B · 10s refresh</div>
            </div>
          </div>
        </div>

        {/* ── VESSELS ── */}
        <div style={CARD}>
          <Hdr title="Vessels" right={vesselCount > 0 ? <LivePill color="#00ccff" /> : <OffPill />} />
          <div style={{ padding: "14px 13px 10px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <BigNum n={vesselCount} color="#00ccff" />
              <div style={{ fontFamily: M, fontSize: "0.46rem", fontWeight: 700, letterSpacing: "0.2em", color: "rgba(0,204,255,0.22)", textTransform: "uppercase", marginTop: 6 }}>AIS Targets</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <MetaRow label="AIS Marine" ok={vesselCount > 0} />
              <div style={{ fontFamily: M, fontSize: "0.52rem", color: "rgba(0,204,255,0.3)" }}>
                {shipRegion.charAt(0).toUpperCase() + shipRegion.slice(1)} · 60s refresh
              </div>
            </div>
          </div>
        </div>

        {/* ── SATELLITES ── */}
        <div style={CARD}>
          <Hdr title="Satellites" right={satCount > 0 ? <LivePill color="#aa88ff" /> : <OffPill />} />
          <div style={{ padding: "14px 13px 10px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <BigNum n={satCount} color="#aa88ff" />
              <div style={{ fontFamily: M, fontSize: "0.46rem", fontWeight: 700, letterSpacing: "0.2em", color: "rgba(170,136,255,0.22)", textTransform: "uppercase", marginTop: 6 }}>Tracked Objects</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <MetaRow label="TLE / Space-Track" ok={satCount > 0} />
              <div style={{ fontFamily: M, fontSize: "0.52rem", color: "rgba(170,136,255,0.3)" }}>
                {satGroup.charAt(0).toUpperCase() + satGroup.slice(1)} group
              </div>
            </div>
          </div>
        </div>

        {/* ── CONFLICTS + HOT ZONES ── */}
        <div style={CARD}>
          <Hdr title="Conflict Events" right={conflictError ? <OffPill /> : <LivePill color="#ff6644" />} />
          <div style={{ padding: "12px 13px 6px", flexShrink: 0 }}>
            <BigNum n={conflictCount} color="#ff6644" />
            <div style={{ fontFamily: M, fontSize: "0.46rem", fontWeight: 700, letterSpacing: "0.2em", color: "rgba(255,102,68,0.28)", textTransform: "uppercase", marginTop: 5 }}>
              Events{totalFatalities > 0 && <span style={{ marginLeft: 8, color: "rgba(255,102,68,0.5)" }}>· {totalFatalities.toLocaleString()} ✝</span>}
            </div>
          </div>
          {hotRegions.length > 0 && (
            <div style={{ flex: 1, padding: "7px 13px 10px", borderTop: "1px solid rgba(0,255,136,0.05)", overflowY: "hidden" }}>
              {hotRegions.map(([country, count], i) => {
                const pct = Math.round((count / (hotRegions[0]?.[1] ?? 1)) * 100);
                return (
                  <div key={country} style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span style={{ fontFamily: M, fontSize: "0.52rem", color: i === 0 ? "#ff6644" : "rgba(0,255,136,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "80%" }}>{country}</span>
                      <span style={{ fontFamily: M, fontSize: "0.52rem", color: i === 0 ? "rgba(255,102,68,0.65)" : "rgba(0,255,136,0.3)" }}>{count}</span>
                    </div>
                    <div style={{ height: 2, background: "rgba(0,255,136,0.06)", borderRadius: 1 }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: i === 0 ? "#ff6644" : "rgba(0,255,136,0.32)", borderRadius: 1, transition: "width 0.6s ease" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── HAZARDS (Earthquakes + Space Weather) ── */}
        <div style={CARD}>
          <Hdr title="Hazards" right={earthquakeCount > 0 ? <LivePill color="#ffdd00" /> : <OffPill />} />

          {/* Earthquakes section */}
          <div style={{ padding: "10px 13px 6px", flexShrink: 0, borderBottom: "1px solid rgba(0,255,136,0.05)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontFamily: M, fontSize: "1.9rem", fontWeight: 800, color: "#ffdd00", lineHeight: 1, letterSpacing: "-0.02em" }}>
                {earthquakeCount > 0 ? earthquakeCount : "—"}
              </span>
              {biggestQuake && (
                <span style={{ fontFamily: M, fontSize: "0.72rem", fontWeight: 700, color: biggestQuake.mag >= 6 ? "#cc0000" : biggestQuake.mag >= 5 ? "#ff4400" : "#ff8800" }}>
                  M{biggestQuake.mag.toFixed(1)} max
                </span>
              )}
            </div>
            <div style={{ fontFamily: M, fontSize: "0.46rem", fontWeight: 700, letterSpacing: "0.2em", color: "rgba(255,221,0,0.25)", textTransform: "uppercase", marginTop: 4 }}>M2.5+ / 24h · USGS</div>
          </div>

          {/* Top quakes list */}
          {topQuakes.length > 0 && (
            <div style={{ padding: "6px 13px 6px", flex: sw ? "none" : 1, overflowY: "hidden" }}>
              {topQuakes.slice(0, sw ? 2 : 4).map(eq => (
                <button
                  key={eq.id}
                  onClick={() => onQuakeClick(eq)}
                  style={{ display: "flex", alignItems: "center", gap: 5, width: "100%", marginBottom: 4, background: "transparent", border: "none", cursor: "pointer", padding: "1px 0", textAlign: "left" }}
                >
                  <span style={{ fontFamily: M, fontSize: "0.58rem", fontWeight: 700, color: eq.mag >= 6 ? "#cc0000" : eq.mag >= 5 ? "#ff4400" : eq.mag >= 4 ? "#ff8800" : "#ffdd00", flexShrink: 0, width: 28 }}>M{eq.mag.toFixed(1)}</span>
                  <span style={{ fontFamily: M, fontSize: "0.52rem", color: "rgba(0,255,136,0.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{eq.place}</span>
                </button>
              ))}
            </div>
          )}

          {/* Space weather section */}
          {sw && (
            <div style={{ padding: "7px 13px 8px", borderTop: "1px solid rgba(0,255,136,0.05)", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontFamily: M, fontSize: "0.46rem", fontWeight: 800, letterSpacing: "0.2em", color: "rgba(0,255,136,0.28)", textTransform: "uppercase" }}>Space Weather</span>
                <span style={{ fontFamily: M, fontSize: "0.5rem", fontWeight: 700, color: sw.stormColor, background: `${sw.stormColor}15`, border: `1px solid ${sw.stormColor}35`, borderRadius: 3, padding: "1px 5px" }}>{sw.stormLabel}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Kp gauge */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                  <span style={{ fontFamily: M, fontSize: "1.4rem", fontWeight: 800, color: sw.stormColor, lineHeight: 1 }}>Kp{sw.kp.toFixed(0)}</span>
                  <span style={{ fontFamily: M, fontSize: "0.42rem", color: "rgba(0,255,136,0.22)", letterSpacing: "0.1em" }}>K-INDEX</span>
                </div>
                {sw.solarWindSpeed != null && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, borderLeft: "1px solid rgba(0,255,136,0.08)", paddingLeft: 8 }}>
                    <span style={{ fontFamily: M, fontSize: "0.9rem", fontWeight: 700, color: "rgba(0,204,255,0.9)", lineHeight: 1 }}>{Math.round(sw.solarWindSpeed)}</span>
                    <span style={{ fontFamily: M, fontSize: "0.42rem", color: "rgba(0,255,136,0.22)", letterSpacing: "0.1em" }}>km/s</span>
                  </div>
                )}
                {sw.bz != null && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, borderLeft: "1px solid rgba(0,255,136,0.08)", paddingLeft: 8 }}>
                    <span style={{ fontFamily: M, fontSize: "0.9rem", fontWeight: 700, color: sw.bz < -10 ? "#ff4444" : "rgba(170,136,255,0.9)", lineHeight: 1 }}>{sw.bz > 0 ? "+" : ""}{sw.bz.toFixed(1)}</span>
                    <span style={{ fontFamily: M, fontSize: "0.42rem", color: "rgba(0,255,136,0.22)", letterSpacing: "0.1em" }}>Bz nT</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── INTEL BRIEF (AI SITREP) ─────────────────────────────── */}
        <div style={CARD}>
          <Hdr
            title="Intel Brief"
            right={
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                {sitrepLoading && <LivePill color="#a855f7" />}
                <button
                  onClick={generateSitrep}
                  disabled={sitrepLoading}
                  title="Regenerate SITREP"
                  style={{
                    background: "transparent",
                    border: "1px solid rgba(168,85,247,0.3)",
                    borderRadius: 3,
                    color: sitrepLoading ? "rgba(168,85,247,0.25)" : "rgba(168,85,247,0.75)",
                    cursor: sitrepLoading ? "default" : "pointer",
                    padding: "2px 7px",
                    fontFamily: M,
                    fontSize: "0.46rem",
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    transition: "color 0.2s, border-color 0.2s",
                  }}
                >
                  ↺ BRIEF
                </button>
              </div>
            }
          />

          {/* Body */}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {sitrepError === "no-key" ? (
              /* ── Setup instructions ── */
              <div style={{ padding: "12px 13px 8px", flex: 1 }}>
                <div style={{ fontFamily: M, fontSize: "0.5rem", color: "rgba(0,255,136,0.35)", lineHeight: 1.8 }}>
                  Add{" "}
                  <span style={{ color: "rgba(168,85,247,0.75)", fontWeight: 700 }}>GROQ_API_KEY</span>
                  {" "}(free) or{" "}
                  <span style={{ color: "rgba(168,85,247,0.75)", fontWeight: 700 }}>OPENAI_API_KEY</span>
                  {" "}to{" "}
                  <span style={{ color: "rgba(0,255,136,0.55)" }}>.env.local</span>
                  {" "}to enable live AI intelligence briefs.
                </div>
                <div style={{ marginTop: 10, fontFamily: M, fontSize: "0.44rem", color: "rgba(168,85,247,0.28)", lineHeight: 1.7 }}>
                  Free key → console.groq.com<br />
                  Model: llama-3.1-8b-instant
                </div>
              </div>
            ) : sitrepError ? (
              /* ── Generic error ── */
              <div style={{ padding: "10px 13px", fontFamily: M, fontSize: "0.5rem", color: "rgba(255,68,68,0.6)", lineHeight: 1.6 }}>
                {sitrepError}
              </div>
            ) : (
              /* ── Streaming text ── */
              <div style={{
                padding: "10px 13px 6px",
                flex: 1,
                overflowY: "auto",
                fontFamily: M,
                fontSize: "0.54rem",
                lineHeight: 1.8,
                color: "rgba(0,255,136,0.72)",
                letterSpacing: "0.01em",
              }}>
                {sitrepText ? (
                  <>
                    {sitrepText}
                    {sitrepLoading && (
                      <span className="sitrep-cursor" style={{ color: "rgba(168,85,247,0.9)", marginLeft: 1 }}>▌</span>
                    )}
                  </>
                ) : sitrepLoading ? (
                  <span style={{ color: "rgba(168,85,247,0.4)", fontStyle: "italic" }}>
                    Analyzing global sensor data…
                  </span>
                ) : (
                  <span style={{ color: "rgba(0,255,136,0.2)" }}>Press ↺ BRIEF to generate.</span>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          {sitrepTime && !sitrepLoading && !sitrepError && (
            <div style={{
              padding: "4px 13px 6px",
              borderTop: "1px solid rgba(0,255,136,0.04)",
              display: "flex",
              justifyContent: "space-between",
              flexShrink: 0,
            }}>
              <span style={{ fontFamily: M, fontSize: "0.42rem", color: "rgba(0,255,136,0.2)" }}>
                {sitrepTime}
              </span>
              <span style={{ fontFamily: M, fontSize: "0.42rem", color: "rgba(168,85,247,0.25)", letterSpacing: "0.08em" }}>
                AI · GEOINT
              </span>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ─────────── OLD PANELS (now replaced by DashboardGrid) ────────────

/** @deprecated Use DashboardGrid instead */
function NewsPanel({ events, onClose }: { events: ConflictEvent[]; onClose: () => void }) {
  const M = "'JetBrains Mono', monospace";
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 80);

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (isNaN(diff)) return dateStr;
    const h = Math.floor(diff / 3_600_000);
    if (h < 1) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  const panel: React.CSSProperties = {
    position: "fixed", left: 175, top: 44, bottom: 0, width: 248, zIndex: 997,
    background: "rgba(2, 7, 2, 0.94)",
    borderRight: "1px solid rgba(0,255,136,0.1)",
    backdropFilter: "blur(24px) saturate(1.4)",
    WebkitBackdropFilter: "blur(24px) saturate(1.4)",
    boxShadow: "4px 0 24px rgba(0,0,0,0.3)",
    display: "flex", flexDirection: "column", overflow: "hidden",
    backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.04) 2px,rgba(0,0,0,0.04) 4px)",
  };

  return (
    <div style={panel}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px 8px", borderBottom: "1px solid rgba(0,255,136,0.09)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#00ff88" strokeWidth={2} aria-hidden><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1" fill="#00ff88" stroke="none"/></svg>
          <span style={{ fontFamily: M, fontSize: "0.43rem", fontWeight: 800, letterSpacing: "0.26em", textTransform: "uppercase", color: "rgba(0,255,136,0.22)" }}>Live Events</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: M, fontSize: "0.58rem", fontWeight: 700, color: "rgba(0,255,136,0.4)", background: "rgba(0,255,136,0.07)", border: "1px solid rgba(0,255,136,0.15)", borderRadius: 10, padding: "1px 7px" }}>{events.length}</span>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(0,255,136,0.15)", borderRadius: 3, padding: "3px 5px", cursor: "pointer", color: "rgba(0,255,136,0.35)", fontSize: "0.6rem", lineHeight: 1, fontFamily: M, transition: "all 0.15s" }}>✕</button>
        </div>
      </div>

      {/* Feed */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}
           className="news-scroll">
        {sorted.length === 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 80, color: "rgba(0,255,136,0.15)", fontFamily: M, fontSize: "0.6rem", letterSpacing: "0.1em" }}>NO DATA</div>
        )}
        {sorted.map(ev => {
          const color = conflictColor(ev.eventType);
          const label = (ev.eventType === "Battles" ? "BATTLE"
            : ev.eventType === "Explosions/Remote violence" ? "EXPL"
            : ev.eventType === "Violence against civilians" ? "VIO"
            : ev.eventType === "Protests" ? "PROTEST"
            : ev.eventType === "Riots" ? "RIOT"
            : "INTEL");
          return (
            <div key={ev.id} style={{ padding: "9px 12px", borderBottom: "1px solid rgba(0,255,136,0.05)", transition: "background 0.12s" }}
                 className="news-item">
              {/* Top row: badge + country + time */}
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                <span style={{ fontFamily: M, fontSize: "0.44rem", fontWeight: 800, letterSpacing: "0.1em", padding: "1px 5px", borderRadius: 3, background: `${color}18`, border: `1px solid ${color}44`, color }}>{label}</span>
                <span style={{ fontFamily: M, fontSize: "0.57rem", fontWeight: 600, color: "#c8f0c8", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.country}</span>
                <span style={{ fontFamily: M, fontSize: "0.52rem", color: "rgba(0,255,136,0.25)", flexShrink: 0 }}>{timeAgo(ev.date)}</span>
              </div>
              {/* Actors */}
              {(ev.actor1 || ev.actor2) && (
                <div style={{ fontFamily: M, fontSize: "0.56rem", color: "rgba(0,255,136,0.45)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {[ev.actor1, ev.actor2].filter(Boolean).join(" · ")}
                </div>
              )}
              {/* Notes */}
              {ev.notes && (
                <div style={{ fontSize: "0.59rem", color: "rgba(0,255,136,0.3)", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as React.CSSProperties["WebkitBoxOrient"], overflow: "hidden" }}>
                  {ev.notes}
                </div>
              )}
              {/* Fatalities */}
              {ev.fatalities > 0 && (
                <div style={{ fontFamily: M, fontSize: "0.52rem", color: "#ff6644", marginTop: 3 }}>
                  ✦ {ev.fatalities} {ev.fatalities === 1 ? "fatality" : "fatalities"}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Right metrics panel — system status + hot regions. */
function MetricsPanel({
  flightCount, vesselCount, satCount, conflictCount, conflictError,
  feedEvents, shipRegion, satGroup, onClose,
}: {
  flightCount: number; vesselCount: number; satCount: number; conflictCount: number;
  conflictError: string | null; feedEvents: ConflictEvent[];
  shipRegion: string; satGroup: string; onClose: () => void;
}) {
  const M = "'JetBrains Mono', monospace";

  // Top countries by event count
  const hotRegions = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of feedEvents) m.set(ev.country, (m.get(ev.country) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [feedEvents]);

  // Total fatalities
  const totalFatalities = React.useMemo(
    () => feedEvents.reduce((s, ev) => s + ev.fatalities, 0),
    [feedEvents],
  );

  const src = (label: string, ok: boolean, detail?: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: ok ? "#00ff88" : "#ff4444", boxShadow: ok ? "0 0 5px #00ff88" : "0 0 5px #ff4444" }} />
      <span style={{ fontFamily: M, fontSize: "0.58rem", color: ok ? "rgba(0,255,136,0.7)" : "#ff7777", flex: 1 }}>{label}</span>
      {detail && <span style={{ fontFamily: M, fontSize: "0.52rem", color: "rgba(0,255,136,0.3)" }}>{detail}</span>}
    </div>
  );

  const section = (title: string) => (
    <div style={{ fontFamily: M, fontSize: "0.43rem", fontWeight: 800, letterSpacing: "0.26em", textTransform: "uppercase" as const, color: "rgba(0,255,136,0.22)", marginBottom: 8, paddingBottom: 5, borderBottom: "1px solid rgba(0,255,136,0.06)" }}>
      {title}
    </div>
  );

  const panel: React.CSSProperties = {
    position: "fixed", right: 0, top: 44, bottom: 0, width: 225, zIndex: 100,
    background: "rgba(2, 7, 2, 0.94)",
    borderLeft: "1px solid rgba(0,255,136,0.1)",
    backdropFilter: "blur(24px) saturate(1.4)",
    WebkitBackdropFilter: "blur(24px) saturate(1.4)",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.3)",
    display: "flex", flexDirection: "column", overflow: "hidden",
    backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.04) 2px,rgba(0,0,0,0.04) 4px)",
  };

  const sect: React.CSSProperties = { padding: "11px 13px 9px", borderBottom: "1px solid rgba(0,255,136,0.07)", flexShrink: 0 };

  return (
    <div style={panel}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 13px 8px", borderBottom: "1px solid rgba(0,255,136,0.09)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#00ff88" strokeWidth={2} aria-hidden><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          <span style={{ fontFamily: M, fontSize: "0.43rem", fontWeight: 800, letterSpacing: "0.26em", textTransform: "uppercase", color: "rgba(0,255,136,0.22)" }}>Metrics</span>
        </div>
        <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(0,255,136,0.15)", borderRadius: 3, padding: "3px 5px", cursor: "pointer", color: "rgba(0,255,136,0.35)", fontSize: "0.6rem", lineHeight: 1, fontFamily: M, transition: "all 0.15s" }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {/* Data sources */}
        <div style={sect}>
          {section("Data Sources")}
          {src("Aircraft (OpenSky)", flightCount > 0, flightCount > 0 ? `${flightCount.toLocaleString()} ac` : "offline")}
          {src("Vessels (AIS)",      vesselCount > 0, vesselCount > 0 ? `${vesselCount} mv` : "offline")}
          {src("Satellites (TLE)",   satCount > 0,    satCount > 0 ? `${satCount} obj` : "offline")}
          {src("Events (GDELT)",     !conflictError,  conflictCount > 0 ? `${conflictCount} ev` : "offline")}
        </div>

        {/* Live totals */}
        <div style={sect}>
          {section("Live Totals")}
          {[
            ["Aircraft",   flightCount,  "#00ff88"],
            ["Vessels",    vesselCount,  "#00ccff"],
            ["Satellites", satCount,     "#aa88ff"],
            ["Events",     conflictCount,"#ff6644"],
          ].map(([label, count, color]) => (
            <div key={label as string} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ fontFamily: M, fontSize: "0.58rem", color: "rgba(0,255,136,0.45)" }}>{label}</span>
              <span style={{ fontFamily: M, fontSize: "0.82rem", fontWeight: 700, color: color as string }}>{(count as number).toLocaleString()}</span>
            </div>
          ))}
          {totalFatalities > 0 && (
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", paddingTop: 7, borderTop: "1px solid rgba(0,255,136,0.06)" }}>
              <span style={{ fontFamily: M, fontSize: "0.58rem", color: "rgba(255,102,68,0.5)" }}>Fatalities</span>
              <span style={{ fontFamily: M, fontSize: "0.82rem", fontWeight: 700, color: "#ff6644" }}>{totalFatalities.toLocaleString()}</span>
            </div>
          )}
        </div>

        {/* Hot regions */}
        {hotRegions.length > 0 && (
          <div style={sect}>
            {section("Hot Regions")}
            {hotRegions.map(([country, count], i) => {
              const maxCount = hotRegions[0]?.[1] ?? 1;
              const pct = Math.round((count / maxCount) * 100);
              return (
                <div key={country} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontFamily: M, fontSize: "0.57rem", color: i === 0 ? "#ff6644" : "rgba(0,255,136,0.55)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "75%" }}>{country}</span>
                    <span style={{ fontFamily: M, fontSize: "0.57rem", color: "rgba(0,255,136,0.3)" }}>{count}</span>
                  </div>
                  <div style={{ height: 2, background: "rgba(0,255,136,0.07)", borderRadius: 1 }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: i === 0 ? "#ff6644" : "rgba(0,255,136,0.4)", borderRadius: 1, transition: "width 0.6s ease" }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Active layer config */}
        <div style={sect}>
          {section("Active Config")}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ fontFamily: M, fontSize: "0.57rem", color: "rgba(0,255,136,0.35)" }}>Vessel region</span>
            <span style={{ fontFamily: M, fontSize: "0.57rem", color: "rgba(0,255,136,0.65)" }}>{shipRegion}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontFamily: M, fontSize: "0.57rem", color: "rgba(0,255,136,0.35)" }}>Sat group</span>
            <span style={{ fontFamily: M, fontSize: "0.57rem", color: "rgba(0,255,136,0.65)" }}>{satGroup}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Bottom center stat cards — quick summary row. */
function CenterBar({
  flightCount, vesselCount, satCount, conflictCount, leftOffset,
}: {
  flightCount: number; vesselCount: number; satCount: number; conflictCount: number; leftOffset: number;
}) {
  const M = "'JetBrains Mono', monospace";

  const card = (icon: React.ReactNode, count: number, label: string, color: string): React.ReactNode => (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      padding: "10px 18px 9px",
      background: "rgba(2, 7, 2, 0.9)",
      border: `1px solid rgba(0,255,136,0.1)`,
      borderBottom: `2px solid ${color}`,
      borderRadius: 6,
      backdropFilter: "blur(20px) saturate(1.4)",
      WebkitBackdropFilter: "blur(20px) saturate(1.4)",
      boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
      minWidth: 96,
    }}>
      <div style={{ color, opacity: 0.7 }}>{icon}</div>
      <div style={{ fontFamily: M, fontSize: "1.35rem", fontWeight: 800, color, lineHeight: 1, letterSpacing: "-0.02em" }}>
        {count > 0 ? count.toLocaleString() : "—"}
      </div>
      <div style={{ fontFamily: M, fontSize: "0.43rem", fontWeight: 700, letterSpacing: "0.2em", color: "rgba(0,255,136,0.3)", textTransform: "uppercase" }}>
        {label}
      </div>
    </div>
  );

  const iconSz: React.CSSProperties = { width: 16, height: 16 };

  return (
    <div style={{
      position: "fixed", bottom: 18, zIndex: 100,
      left: leftOffset, right: 0,
      display: "flex", justifyContent: "center", gap: 8,
      pointerEvents: "none",
    }}>
      <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
        {card(<svg style={iconSz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 2c-2-2-4-2-5.5-.5L10 5 1.8 6.2c-.5.1-.7.6-.4 1L4 10l2 2-2 2-2.5.4c-.4.1-.6.6-.3.9L4 18l2 2 .4-2.5L9 15l2 2 3 2c.4.3.9.1 1-.4z"/></svg>, flightCount, "Aircraft", "#00ff88")}
        {card(<svg style={iconSz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 20h20M5 20V10l7-7 7 7v10M9 20v-5h6v5"/></svg>, vesselCount, "Vessels", "#00ccff")}
        {card(<svg style={iconSz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><rect x="4" y="10" width="5" height="5"/><line x1="6.5" y1="10" x2="6.5" y2="6"/><line x1="4" y1="8" x2="9" y2="8"/><line x1="14" y1="7" x2="20" y2="7"/><line x1="17" y1="4" x2="17" y2="10"/><circle cx="17" cy="17" r="3"/></svg>, satCount, "Satellites", "#aa88ff")}
        {card(<svg style={iconSz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/></svg>, conflictCount, "Events", "#ff6644")}
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

  // Satellite tracking
  const satEntitiesRef = useRef<Map<string, any>>(new Map());       // noradId → billboard entity
  const satOrbitsRef   = useRef<Map<string, any>>(new Map());       // noradId → polyline entity
  const satDataRef     = useRef<Map<string, any>>(new Map());       // noradId → SatRecord

  // Conflict event layer
  const conflictEntitiesRef = useRef<Map<string, any>>(new Map());  // eventId → point entity
  const conflictDataRef     = useRef<Map<string, ConflictEvent>>(new Map());

  // Earthquake layer
  const earthquakeEntitiesRef = useRef<Map<string, any>>(new Map());
  const earthquakeDataRef     = useRef<Map<string, EarthquakeData>>(new Map());

  const [mode, setMode] = useState<ImageryMode>("satellite");
  const [coords, setCoords] = useState<CoordState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flightCount, setFlightCount] = useState(0);
  const [selectedAc, setSelectedAc] = useState<AircraftData | null>(null);
  const [showFlights, setShowFlights] = useState(true);
  const [showVessels, setShowVessels] = useState(true);
  const [shipRegion, setShipRegion] = useState<ShipRegionKey>("global");
  const [vesselCount, setVesselCount] = useState(0);
  const [selectedVessel, setSelectedVessel] = useState<VesselData | null>(null);
  const [showSatellites, setShowSatellites] = useState(true);
  const [satCount, setSatCount] = useState(0);
  const [selectedSat, setSelectedSat] = useState<SatelliteInfo | null>(null);
  const [satGroup, setSatGroup] = useState<SatGroupKey>("visual");
  const [showConflicts, setShowConflicts] = useState(true);
  const [conflictCount, setConflictCount] = useState(0);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [selectedConflict, setSelectedConflict] = useState<ConflictEvent | null>(null);
  const [conflictDays, setConflictDays] = useState<ConflictDays>(4);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [trackOriginPlace, setTrackOriginPlace] = useState("—");
  const [trackDestPlace, setTrackDestPlace] = useState("—");
  const [trackPlacesLoading, setTrackPlacesLoading] = useState(false);
  const [faDetail, setFaDetail] = useState<FlightAwareFlightDetail | null>(null);
  const [faError, setFaError] = useState<string | null>(null);
  const [faMatchedBy, setFaMatchedBy] = useState<"callsign" | "registration" | null>(null);
  // Dashboard overlay state
  const [feedEvents, setFeedEvents] = useState<ConflictEvent[]>([]);
  const [showDashboard, setShowDashboard] = useState(true);

  // Earthquake layer state
  const [showEarthquakes, setShowEarthquakes] = useState(true);
  const [earthquakeCount, setEarthquakeCount] = useState(0);
  const [selectedEarthquake, setSelectedEarthquake] = useState<EarthquakeData | null>(null);
  const [feedEarthquakes, setFeedEarthquakes] = useState<EarthquakeData[]>([]);
  const showEarthquakesRef = useRef(true);

  // Weather radar layer
  const [showWeather, setShowWeather] = useState(false);
  const [weatherReady, setWeatherReady] = useState(false);
  const showWeatherRef = useRef(false);

  // UTC clock
  const [utcClock, setUtcClock] = useState("");

  // Location search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const showFlightsRef    = useRef(true);
  const showVesselsRef    = useRef(true);
  const showSatellitesRef = useRef(true);
  const showConflictsRef  = useRef(true);

  useSatelliteLayer({
    viewer: ready ? viewerRef.current : null,
    showSatellitesRef,
    satEntitiesRef,
    satOrbitsRef,
    satDataRef,
    setSatCount,
    setSelectedSat,
    group: satGroup,
  });

  useConflictLayer({
    viewer: ready ? viewerRef.current : null,
    showConflictsRef,
    conflictEntitiesRef,
    conflictDataRef,
    setConflictCount,
    setConflictError,
    setSelectedConflict,
    setFeedEvents,
    days: conflictDays,
  });

  useEarthquakeLayer({
    viewer: ready ? viewerRef.current : null,
    showEarthquakesRef,
    earthquakeEntitiesRef,
    earthquakeDataRef,
    setEarthquakeCount,
    setSelectedEarthquake,
    setFeedEarthquakes,
  });

  const weatherLayerRef = useWeatherLayer({
    viewer: ready ? viewerRef.current : null,
    showWeatherRef,
    setWeatherReady,
  });

  // UTC clock — ticks every second
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, "0");
      const m = String(now.getUTCMinutes()).padStart(2, "0");
      const s = String(now.getUTCSeconds()).padStart(2, "0");
      setUtcClock(`${h}:${m}:${s} UTC`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useAisVesselLayer({
    viewer: ready ? viewerRef.current : null,
    showVesselsRef,
    vesselEntitiesRef,
    vesselTrailsRef,
    vesselHistoryRef,
    vesselDataRef,
    setVesselCount,
    setSelectedVessel,
    pollIntervalMs: AIS_POLL_MS,
    bbox: SHIP_REGIONS[shipRegion].bbox ?? undefined,
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

        // ESRI World Imagery — sharper than Ion/Bing and free
        const esriProvider = new Cesium.UrlTemplateImageryProvider({
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          credit: "\u00a9 Esri, Maxar, Earthstar Geographics",
          maximumLevel: 19,
        });

        const viewer = new Cesium.Viewer(containerRef.current, {
          terrain: Cesium.Terrain.fromWorldTerrain(),
          baseLayer: new Cesium.ImageryLayer(esriProvider),
          animation: false, baseLayerPicker: false, fullscreenButton: false,
          geocoder: false, homeButton: false, infoBox: false,
          sceneModePicker: false, selectionIndicator: false,
          timeline: false, navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
          // Disable Cesium's auto-resolution so we control it manually
          useBrowserRecommendedResolution: false,
        });

        // ── Rendering quality ─────────────────────────────────────────────────
        // HiDPI: match the physical pixel density (capped at 2× to limit GPU load)
        viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2.0);
        // 4× MSAA + FXAA for smooth edges
        viewer.scene.msaaSamples = 4;
        if (viewer.scene.postProcessStages?.fxaa) {
          viewer.scene.postProcessStages.fxaa.enabled = true;
        }
        // Lower SSE → higher-res tiles loaded sooner (default = 2)
        viewer.scene.globe.maximumScreenSpaceError = 1.5;
        // Keep more tiles in memory to prevent re-fetching while panning
        viewer.scene.globe.tileCacheSize = 200;
        // ─────────────────────────────────────────────────────────────────────

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
            if (entityId.startsWith("conflict_")) {
              const evId = entityId.replace("conflict_", "");
              const ev = conflictDataRef.current.get(evId);
              if (ev) { setSelectedConflict(ev); setSelectedAc(null); setSelectedVessel(null); setSelectedSat(null); setSelectedEarthquake(null); }
            } else if (entityId.startsWith("quake_")) {
              const eqId = entityId.replace("quake_", "");
              const eq = earthquakeDataRef.current.get(eqId);
              if (eq) { setSelectedEarthquake(eq); setSelectedAc(null); setSelectedVessel(null); setSelectedSat(null); setSelectedConflict(null); }
            } else if (entityId.startsWith("sat_orbit_")) {
              // clicking an orbit line — select the satellite
              const noradId = entityId.replace("sat_orbit_", "");
              const info = computeSatInfo(satDataRef, noradId);
              if (info) { setSelectedSat(info); setSelectedAc(null); setSelectedVessel(null); }
            } else if (entityId.startsWith("sat_")) {
              const noradId = entityId.replace("sat_", "");
              const info = computeSatInfo(satDataRef, noradId);
              if (info) { setSelectedSat(info); setSelectedAc(null); setSelectedVessel(null); }
            } else if (entityId.startsWith("vessel_")) {
              const mmsi = entityId.replace("vessel_", "");
              const vessel = vesselDataRef.current.get(mmsi);
              if (vessel) { setSelectedVessel(vessel); setSelectedAc(null); setSelectedSat(null); }
            } else if (entityId.startsWith("ac_track_hist_") || entityId.startsWith("ac_track_fwd_")) {
              const icao = entityId.replace(/^ac_track_(?:hist|fwd)_/, "");
              const ac = aircraftDataRef.current.get(icao);
              if (ac) { setSelectedAc(ac); setSelectedVessel(null); setSelectedSat(null); }
            } else if (!entityId.startsWith("trail_")) {
              const ac = aircraftDataRef.current.get(entityId);
              if (ac) { setSelectedAc(ac); setSelectedVessel(null); setSelectedSat(null); }
            }
          } else {
            setSelectedAc(null);
            setSelectedVessel(null);
            setSelectedSat(null);
            setSelectedConflict(null);
            setSelectedEarthquake(null);
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

  const changeShipRegion = useCallback((key: string) => {
    const region = SHIP_REGIONS[key as ShipRegionKey];
    if (!region) return;
    setShipRegion(key as ShipRegionKey);
    if (region.cam && viewerRef.current) {
      const Cesium = (window as unknown as { Cesium: Record<string, unknown> }).Cesium;
      (viewerRef.current as { camera: { flyTo: (o: unknown) => void } }).camera.flyTo({
        destination: (Cesium.Cartesian3 as { fromDegrees: (lon: number, lat: number, alt: number) => unknown })
          .fromDegrees(region.cam[1], region.cam[0], region.cam[2]),
        duration: 2.5,
      });
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

  const toggleSatellites = useCallback(() => {
    const next = !showSatellitesRef.current;
    showSatellitesRef.current = next;
    setShowSatellites(next);
    for (const e of satEntitiesRef.current.values()) {
      (e as any).billboard.show = next;
      (e as any).label.show = next;
    }
    for (const o of satOrbitsRef.current.values()) {
      (o as any).polyline.show = next;
    }
  }, []);

  const toggleConflicts = useCallback(() => {
    const next = !showConflictsRef.current;
    showConflictsRef.current = next;
    setShowConflicts(next);
    for (const e of conflictEntitiesRef.current.values()) {
      (e as any).point.show = next;
      const label = (e as any).label;
      if (label) label.show = next;
    }
  }, []);

  const flyToSatellite = useCallback(() => {
    if (!selectedSat || !viewerRef.current) return;
    const Cesium = (window as any).Cesium;
    const rec = satDataRef.current.get(selectedSat.noradId) as any;
    if (!rec) return;
    // Compute current position to fly to
    import("satellite.js").then(({ propagate, gstime, eciToGeodetic, degreesLong, degreesLat, SatRecError }) => {
      const now = new Date();
      const pv = propagate(rec.satrec, now);
      if (rec.satrec.error !== SatRecError.None) return;
      const gst = gstime(now);
      const geo = eciToGeodetic(pv.position as any, gst);
      const lon = degreesLong(geo.longitude);
      const lat = degreesLat(geo.latitude);
      const altM = geo.height * 1000 + 500_000; // camera offset above satellite
      viewerRef.current?.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, altM),
        duration: 2.5,
      });
    });
  }, [selectedSat]);

  const flyToAircraft = useCallback(() => {
    if (!selectedAc || !viewerRef.current) return;
    const Cesium = (window as any).Cesium;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(selectedAc.lon, selectedAc.lat, 800_000),
      duration: 2,
    });
  }, [selectedAc]);

  const flyToConflict = useCallback((ev: ConflictEvent) => {
    setSelectedConflict(ev);
    setSelectedAc(null);
    setSelectedVessel(null);
    setSelectedSat(null);
    if (!viewerRef.current) return;
    const Cesium = (window as any).Cesium;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(ev.lon, ev.lat, 600_000),
      duration: 2,
    });
  }, []);

  const toggleEarthquakes = useCallback(() => {
    const next = !showEarthquakesRef.current;
    showEarthquakesRef.current = next;
    setShowEarthquakes(next);
    for (const e of earthquakeEntitiesRef.current.values()) {
      (e as any).point.show = next;
    }
  }, []);

  const toggleWeather = useCallback(() => {
    const next = !showWeatherRef.current;
    showWeatherRef.current = next;
    setShowWeather(next);
    if (weatherLayerRef.current) {
      (weatherLayerRef.current as { show: boolean }).show = next;
    }
  }, [weatherLayerRef]);

  const flyToEarthquake = useCallback((eq: EarthquakeData) => {
    setSelectedEarthquake(eq);
    setSelectedAc(null);
    setSelectedVessel(null);
    setSelectedSat(null);
    setSelectedConflict(null);
    if (!viewerRef.current) return;
    const Cesium = (window as any).Cesium;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(eq.lon, eq.lat, 400_000),
      duration: 2,
    });
  }, []);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || !viewerRef.current) return;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
        { headers: { "Accept-Language": "en" } }
      );
      const results = await res.json() as Array<{ lat: string; lon: string; display_name: string }>;
      if (results[0]) {
        const Cesium = (window as any).Cesium;
        viewerRef.current.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            parseFloat(results[0].lon), parseFloat(results[0].lat), 800_000
          ),
          duration: 2,
        });
      }
    } catch { /* silently ignore */ }
    setSearchQuery("");
    setSearchOpen(false);
  }, [searchQuery]);

  // ── Design tokens (all structural/layout as inline styles) ────
  const M = "'JetBrains Mono', monospace";

  // Pill chip for the counter bar
  const chip = (color: string): React.CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "3px 9px 3px 7px", borderRadius: 20,
    background: `${color}12`, border: `1px solid ${color}28`,
    color, fontFamily: M, fontSize: "0.61rem", fontWeight: 700, letterSpacing: "0.05em",
    whiteSpace: "nowrap" as const,
  });

  // Status dot for toggle buttons
  const dot = (on: boolean, color = "#00ff88") => (
    <span style={{
      width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
      background: on ? color : "rgba(0,255,136,0.1)",
      boxShadow: on ? `0 0 6px ${color}` : "none",
      transition: "all 0.2s ease",
    }} />
  );

  const S = {
    // Top bar
    topbar: {
      position: "fixed" as const, top: 0, left: 0, right: 0, height: 44,
      zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 18px",
      background: "rgba(3, 9, 3, 0.92)",
      borderBottom: "1px solid rgba(0,255,136,0.1)",
      backdropFilter: "blur(24px) saturate(1.5)",
      WebkitBackdropFilter: "blur(24px) saturate(1.5)",
      boxShadow: "0 1px 0 rgba(0,255,136,0.04), 0 4px 24px rgba(0,0,0,0.35)",
      fontFamily: M,
    },
    // Left panel
    panel: {
      position: "fixed" as const, top: 44, left: 0, bottom: 0, width: 175,
      zIndex: 999,
      background: "rgba(3, 8, 3, 0.93)",
      borderRight: "1px solid rgba(0,255,136,0.1)",
      backdropFilter: "blur(24px) saturate(1.4)",
      WebkitBackdropFilter: "blur(24px) saturate(1.4)",
      boxShadow: "4px 0 28px rgba(0,0,0,0.35)",
      display: "flex", flexDirection: "column" as const,
      overflow: "hidden",
      backgroundImage: "repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.04) 2px,rgba(0,0,0,0.04) 4px)",
    },
    // Section wrapper
    sect: {
      padding: "11px 11px 9px",
      borderBottom: "1px solid rgba(0,255,136,0.07)",
      flexShrink: 0,
    },
    // Section title
    sectTitle: {
      fontSize: "0.43rem", fontWeight: 800, letterSpacing: "0.26em",
      textTransform: "uppercase" as const, color: "rgba(0,255,136,0.22)",
      fontFamily: M, marginBottom: 8,
      paddingBottom: 6, borderBottom: "1px solid rgba(0,255,136,0.06)",
    },
    // Toggle button (layer on/off)
    toggle: (on: boolean, accent = "#00ff88"): React.CSSProperties => ({
      display: "flex", alignItems: "center", gap: 7, width: "100%",
      fontSize: "0.6rem", fontWeight: 600, letterSpacing: "0.05em",
      background: on ? `${accent}09` : "transparent",
      border: "none", borderRadius: 4, padding: "6px 7px",
      cursor: "pointer", textAlign: "left" as const,
      color: on ? accent : "rgba(0,255,136,0.2)",
      fontFamily: M, transition: "all 0.15s ease",
    }),
    // Sub-select dropdown
    select: {
      width: "100%", marginTop: 3,
      fontSize: "0.56rem", fontWeight: 600, letterSpacing: "0.02em",
      color: "rgba(0,255,136,0.48)",
      background: "rgba(0,255,136,0.03)",
      border: "1px solid rgba(0,255,136,0.1)",
      borderRadius: 3, padding: "4px 7px",
      cursor: "pointer", fontFamily: M,
      appearance: "none" as const, WebkitAppearance: "none" as const,
    },
    // 3×2 imagery grid
    imgGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 3, marginTop: 6 },
    imgBtn: (on: boolean): React.CSSProperties => ({
      padding: "5px 2px",
      fontSize: "0.48rem", fontWeight: 700, letterSpacing: "0.05em",
      textTransform: "uppercase" as const, textAlign: "center" as const,
      color: on ? "#00ff88" : "rgba(0,255,136,0.3)",
      background: on ? "rgba(0,255,136,0.12)" : "rgba(0,255,136,0.02)",
      border: on ? "1px solid rgba(0,255,136,0.45)" : "1px solid rgba(0,255,136,0.09)",
      borderRadius: 3, cursor: "pointer", fontFamily: M,
      transition: "all 0.14s ease",
      textShadow: on ? "0 0 8px rgba(0,255,136,0.5)" : "none",
    }),
    spacer: { flex: 1, minHeight: 0 },
    footer: { padding: "9px 11px", borderTop: "1px solid rgba(0,255,136,0.07)", flexShrink: 0 },
    resetBtn: {
      display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
      width: "100%", padding: "6px",
      fontSize: "0.54rem", fontWeight: 700, letterSpacing: "0.1em",
      textTransform: "uppercase" as const,
      color: "rgba(0,255,136,0.3)",
      background: "rgba(0,255,136,0.02)", border: "1px solid rgba(0,255,136,0.1)",
      borderRadius: 4, cursor: "pointer", fontFamily: M, transition: "all 0.15s ease",
    },
    icon: { width: 11, height: 11, flexShrink: 0 } as const,
  };

  // ── Render ────────────────────────────────────────────────────
  return (
    <>
      <div id="cesiumContainer" ref={containerRef} />

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header style={S.topbar}>
        {/* Brand + search */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden>
              <circle cx="16" cy="16" r="14" stroke="rgba(0,255,136,0.65)" strokeWidth="1.5" />
              <ellipse cx="16" cy="16" rx="6" ry="14" stroke="rgba(0,255,136,0.35)" strokeWidth="1.2" />
              <line x1="2" y1="16" x2="30" y2="16" stroke="rgba(0,255,136,0.2)" strokeWidth="1" />
              <line x1="4" y1="10" x2="28" y2="10" stroke="rgba(0,255,136,0.12)" strokeWidth="0.8" />
              <line x1="4" y1="22" x2="28" y2="22" stroke="rgba(0,255,136,0.12)" strokeWidth="0.8" />
            </svg>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <div style={{ fontSize: "0.76rem", fontWeight: 800, letterSpacing: "0.15em", color: "#00ff88", textShadow: "0 0 12px rgba(0,255,136,0.45)", textTransform: "uppercase", lineHeight: 1 }}>
                Global Sentinel
              </div>
              <div style={{ fontSize: "0.47rem", color: "rgba(0,255,136,0.24)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
                Real-time Spatial Intelligence
              </div>
            </div>
          </div>

          {/* UTC clock */}
          {utcClock && (
            <div style={{ fontFamily: M, fontSize: "0.62rem", fontWeight: 700, color: "rgba(0,255,136,0.4)", letterSpacing: "0.08em", borderLeft: "1px solid rgba(0,255,136,0.1)", paddingLeft: 14 }}>
              {utcClock}
            </div>
          )}

          {/* Search */}
          {ready && (
            <form onSubmit={handleSearch} style={{ display: "flex", alignItems: "center", gap: 0 }}>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => setSearchOpen(true)}
                placeholder="Search location…"
                className="search-input"
                style={{
                  width: searchOpen || searchQuery ? 160 : 0,
                  opacity: searchOpen || searchQuery ? 1 : 0,
                  pointerEvents: searchOpen || searchQuery ? "auto" : "none",
                  transition: "width 0.2s ease, opacity 0.2s ease",
                  background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.18)",
                  borderRight: "none", borderRadius: "4px 0 0 4px",
                  padding: "4px 9px", color: "#d4f5d4",
                  fontFamily: M, fontSize: "0.58rem", outline: "none",
                }}
              />
              <button
                type={searchOpen || searchQuery ? "submit" : "button"}
                onClick={() => !searchOpen && setSearchOpen(true)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: "4px 8px", cursor: "pointer",
                  background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.18)",
                  borderRadius: searchOpen || searchQuery ? "0 4px 4px 0" : 4,
                  color: "rgba(0,255,136,0.5)", transition: "all 0.15s",
                }}
                title="Search location"
              >
                <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
              {(searchOpen || searchQuery) && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(""); setSearchOpen(false); }}
                  style={{ background: "transparent", border: "none", cursor: "pointer", color: "rgba(0,255,136,0.3)", padding: "0 4px", fontSize: "0.7rem", lineHeight: 1 }}
                >✕</button>
              )}
            </form>
          )}
        </div>

        {/* Right side: panel toggles + counter chips */}
        {ready && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>

            {/* Dashboard toggle */}
            <button
              onClick={() => setShowDashboard(v => !v)}
              title={showDashboard ? "Hide dashboard" : "Show dashboard"}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 10px", borderRadius: 4, cursor: "pointer",
                background: showDashboard ? "rgba(0,255,136,0.1)" : "transparent",
                border: showDashboard ? "1px solid rgba(0,255,136,0.35)" : "1px solid rgba(0,255,136,0.12)",
                color: showDashboard ? "#00ff88" : "rgba(0,255,136,0.3)",
                fontFamily: M, fontSize: "0.52rem", fontWeight: 700, letterSpacing: "0.1em",
                transition: "all 0.15s ease",
              }}
            >
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              Dashboard
            </button>

            {/* Divider */}
            <div style={{ width: 1, height: 18, background: "rgba(0,255,136,0.1)" }} />

            {/* Counter chips */}
            {(flightCount > 0 || vesselCount > 0 || satCount > 0 || conflictCount > 0) && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="live-dot" style={{ marginRight: 2 }} />
                {flightCount > 0 && (
                  <div className="chip" style={chip("#00ff88")}>
                    <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 2c-2-2-4-2-5.5-.5L10 5 1.8 6.2c-.5.1-.7.6-.4 1L4 10l2 2-2 2-2.5.4c-.4.1-.6.6-.3.9L4 18l2 2 .4-2.5L9 15l2 2 3 2c.4.3.9.1 1-.4z" /></svg>
                    {flightCount.toLocaleString()}
                  </div>
                )}
                {vesselCount > 0 && (
                  <div className="chip" style={chip("#00ccff")}>
                    <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 20h20M5 20V10l7-7 7 7v10M9 20v-5h6v5"/></svg>
                    {vesselCount}
                  </div>
                )}
                {satCount > 0 && (
                  <div className="chip" style={chip("#aa88ff")}>
                    <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><rect x="4" y="10" width="5" height="5"/><line x1="6.5" y1="10" x2="6.5" y2="6"/><line x1="4" y1="8" x2="9" y2="8"/><line x1="14" y1="7" x2="20" y2="7"/><line x1="17" y1="4" x2="17" y2="10"/><circle cx="17" cy="17" r="3"/></svg>
                    {satCount}
                  </div>
                )}
                {conflictCount > 0 && (
                  <div className="chip" style={chip("#ff6644")}>
                    <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/></svg>
                    {conflictCount}
                  </div>
                )}
                {lastUpdate && (
                  <span style={{ color: "rgba(0,255,136,0.22)", fontSize: "0.52rem", fontFamily: M, letterSpacing: "0.05em", marginLeft: 2 }}>
                    {lastUpdate}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {/* ── Left panel ──────────────────────────────────────────── */}
      {ready && (
        <div style={S.panel}>

          {/* Layers section */}
          <div style={S.sect}>
            <div style={S.sectTitle}>Layers</div>

            <button className="ui-toggle" style={S.toggle(showFlights)} onClick={toggleFlights}>
              {dot(showFlights)}
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 2c-2-2-4-2-5.5-.5L10 5 1.8 6.2c-.5.1-.7.6-.4 1L4 10l2 2-2 2-2.5.4c-.4.1-.6.6-.3.9L4 18l2 2 .4-2.5L9 15l2 2 3 2c.4.3.9.1 1-.4z"/></svg>
              Aircraft
            </button>

            <button className="ui-toggle" style={S.toggle(showVessels, "#00ccff")} onClick={toggleVessels}>
              {dot(showVessels, "#00ccff")}
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 20h20M5 20V10l7-7 7 7v10M9 20v-5h6v5"/></svg>
              Vessels
            </button>
            <select style={S.select} value={shipRegion} onChange={e => changeShipRegion(e.target.value)}>
              {(Object.entries(SHIP_REGIONS) as [ShipRegionKey, typeof SHIP_REGIONS[ShipRegionKey]][]).map(([k, r]) => (
                <option key={k} value={k}>{r.label}</option>
              ))}
            </select>

            <button className="ui-toggle" style={{ ...S.toggle(showSatellites, "#aa88ff"), marginTop: 5 }} onClick={toggleSatellites}>
              {dot(showSatellites, "#aa88ff")}
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><rect x="4" y="10" width="5" height="5"/><line x1="6.5" y1="10" x2="6.5" y2="6"/><line x1="4" y1="8" x2="9" y2="8"/><line x1="14" y1="7" x2="20" y2="7"/><line x1="17" y1="4" x2="17" y2="10"/><circle cx="17" cy="17" r="3"/></svg>
              Satellites
            </button>
            <select style={S.select} value={satGroup} onChange={e => setSatGroup(e.target.value as SatGroupKey)}>
              {(Object.entries(SAT_GROUPS) as [SatGroupKey, string][]).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>

            <button className="ui-toggle" style={{ ...S.toggle(showConflicts, "#ff6644"), marginTop: 5 }} onClick={toggleConflicts}>
              {dot(showConflicts, "#ff6644")}
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1" fill="currentColor" stroke="none"/></svg>
              Events
            </button>
            <select style={S.select} value={conflictDays} onChange={e => setConflictDays(Number(e.target.value) as ConflictDays)}>
              {CONFLICT_DAYS_OPTIONS.map(d => (
                <option key={d} value={d}>{CONFLICT_DAYS_LABELS[d]}</option>
              ))}
            </select>

            <button className="ui-toggle" style={{ ...S.toggle(showEarthquakes, "#ffdd00"), marginTop: 5 }} onClick={toggleEarthquakes}>
              {dot(showEarthquakes, "#ffdd00")}
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              Earthquakes
            </button>

            <button
              className="ui-toggle"
              style={{ ...S.toggle(showWeather, "#00cfff"), marginTop: 5, opacity: weatherReady ? 1 : 0.5 }}
              onClick={toggleWeather}
              disabled={!weatherReady}
              title={weatherReady ? "Toggle radar overlay" : "Loading radar…"}
            >
              {dot(showWeather, "#00cfff")}
              {/* cloud with rain icon */}
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"/>
                <line x1="8" y1="19" x2="8" y2="21"/><line x1="8" y1="23" x2="8" y2="23"/>
                <line x1="12" y1="18" x2="12" y2="20"/><line x1="12" y1="22" x2="12" y2="22"/>
                <line x1="16" y1="19" x2="16" y2="21"/><line x1="16" y1="23" x2="16" y2="23"/>
              </svg>
              Weather Radar
            </button>
          </div>

          {/* Imagery section — 3-col grid */}
          <div style={S.sect}>
            <div style={S.sectTitle}>Imagery</div>
            <div style={S.imgGrid}>
              {([ ["satellite","Bing"], ["sentinel2","S2"], ["viirs","VIIRS"], ["modis","MODIS"], ["osm","Streets"], ["dark","Night"] ] as [ImageryMode, string][]).map(([m, label]) => (
                <button key={m} className="ui-img-btn" style={S.imgBtn(mode === m)} onClick={() => switchImagery(m)}>{label}</button>
              ))}
            </div>
          </div>

          <div style={S.spacer} />

          <div style={S.footer}>
            <button className="ui-reset" style={S.resetBtn} onClick={flyHome}>
              <svg style={S.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              Reset View
            </button>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div style={{ position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:"#f87171",fontSize:"1rem",background:"#020a02",zIndex:2000 }}>
          {error}
        </div>
      )}

      {/* GDELT error banner */}
      {ready && conflictError && conflictError.startsWith("gdelt_failed") && (
        <div style={{ position:"fixed",top:52,left:"50%",transform:"translateX(-50%)",zIndex:1100,background:"rgba(26,10,0,0.95)",backdropFilter:"blur(12px)",border:"1px solid rgba(255,102,0,0.4)",borderRadius:6,padding:"7px 16px",fontSize:"0.67rem",fontFamily:M,color:"#ff9944",display:"flex",gap:10,alignItems:"center",whiteSpace:"nowrap",boxShadow:"0 4px 16px rgba(0,0,0,0.4)" }}>
          <span style={{ color:"#ff6600", fontSize:"0.8rem" }}>⚠</span> Conflict feed unavailable
        </div>
      )}

      {/* ── Intelligence Dashboard Grid ──────────────────────────── */}
      {ready && showDashboard && (
        <DashboardGrid
          flightCount={flightCount}
          vesselCount={vesselCount}
          satCount={satCount}
          conflictCount={conflictCount}
          earthquakeCount={earthquakeCount}
          feedEvents={feedEvents}
          feedEarthquakes={feedEarthquakes}
          shipRegion={shipRegion}
          satGroup={satGroup}
          conflictError={conflictError}
          onEventClick={flyToConflict}
          onQuakeClick={flyToEarthquake}
          onClose={() => setShowDashboard(false)}
        />
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
              {/* FlightAware itinerary — inside the scrollable grid */}
              <div className="mil-cell mil-cell-wide" style={{ padding: 0 }}>
                <div style={{ padding: "0 0.85rem 0.75rem" }}>
                  <FlightAwareCard
                    detail={faDetail}
                    faError={faError}
                    loading={trackPlacesLoading}
                    callsign={selectedAc.callsign ?? ""}
                  />
                </div>
              </div>
            </div>

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

      {/* ── Conflict Sidebar ──────────────────────────────────── */}
      {selectedConflict && !selectedAc && !selectedVessel && !selectedSat && (
        <ConflictCard
          event={selectedConflict}
          onClose={() => setSelectedConflict(null)}
        />
      )}

      {/* ── Satellite Sidebar ─────────────────────────────────── */}
      {selectedSat && !selectedAc && !selectedVessel && (
        <SatelliteCard
          sat={selectedSat}
          onClose={() => setSelectedSat(null)}
          onFlyTo={flyToSatellite}
        />
      )}

      {/* ── Earthquake Sidebar ───────────────────────────────── */}
      {selectedEarthquake && !selectedAc && !selectedVessel && !selectedSat && !selectedConflict && (
        <div className="mil-sidebar open">
          <div className="mil-header">
            <div className="mil-header-left">
              <div className="mil-tag">SEISMIC EVENT · {selectedEarthquake.magType.toUpperCase()}</div>
              <div className="mil-callsign" style={{ color: selectedEarthquake.mag >= 6 ? "#cc0000" : selectedEarthquake.mag >= 5 ? "#ff4400" : selectedEarthquake.mag >= 4 ? "#ff8800" : "#ffdd00" }}>
                M{selectedEarthquake.mag.toFixed(1)}
              </div>
              <div className="mil-reg">{selectedEarthquake.tsunami === 1 ? "⚠ TSUNAMI WATCH" : "No tsunami warning"}</div>
            </div>
            <button className="mil-close" onClick={() => setSelectedEarthquake(null)}><CloseIcon /></button>
          </div>

          <div className="mil-grid">
            <div className="mil-cell mil-cell-wide">
              <div className="mil-label">LOCATION</div>
              <div className="mil-value" style={{ fontSize: "0.76rem" }}>{selectedEarthquake.place}</div>
            </div>
            <div className="mil-cell">
              <div className="mil-label">MAGNITUDE</div>
              <div className="mil-value">{selectedEarthquake.mag.toFixed(1)} <span className="mil-unit">{selectedEarthquake.magType}</span></div>
            </div>
            <div className="mil-cell">
              <div className="mil-label">DEPTH</div>
              <div className="mil-value">{selectedEarthquake.depth.toFixed(1)} <span className="mil-unit">km</span></div>
            </div>
            <div className="mil-cell mil-cell-wide">
              <div className="mil-label">TIME (UTC)</div>
              <div className="mil-value mil-mono">{new Date(selectedEarthquake.time).toUTCString().replace(" GMT","")}</div>
            </div>
            <div className="mil-cell mil-cell-wide">
              <div className="mil-label">COORDINATES</div>
              <div className="mil-value mil-mono">{selectedEarthquake.lat.toFixed(4)}° N &nbsp; {selectedEarthquake.lon.toFixed(4)}° E</div>
            </div>
          </div>

          <button className="mil-flyto" onClick={() => flyToEarthquake(selectedEarthquake)}>
            <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            FLY TO EPICENTRE
          </button>

          {selectedEarthquake.url && (
            <div className="mil-legend">
              <a href={selectedEarthquake.url} target="_blank" rel="noopener noreferrer" style={{ color: "#00ff88", textDecoration: "none", fontSize: "0.6rem" }}>
                ↗ USGS Event Page
              </a>
            </div>
          )}

          <div className="mil-legend">
            <span className="leg-dot" style={{background:"#ffdd00"}} /> M2.5–4 &nbsp;
            <span className="leg-dot" style={{background:"#ff8800"}} /> M4–5 &nbsp;
            <span className="leg-dot" style={{background:"#ff4400"}} /> M5–6 &nbsp;
            <span className="leg-dot" style={{background:"#cc0000"}} /> M6+
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
