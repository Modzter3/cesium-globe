"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import { parseAdsbAircraft } from "@/lib/adsbParse";
import { airplaneSvgUri, altColor, altColorCss } from "@/lib/aircraftStyle";
import type { AircraftData } from "@/types/aircraft";

/** Same-origin proxy fans out to api.adsb.lol (see `app/api/flights/route.ts`). */
const FETCH_URL = "/api/flights";
const DEFAULT_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 120_000;
const WARN_THROTTLE_MS = 30_000;
const MAX_AIRCRAFT_TRAIL_POINTS = 20;

interface MotionSegment {
  startLon: number;
  startLat: number;
  startHdg: number;
  endLon: number;
  endLat: number;
  endHdg: number;
  startMs: number;
  durationMs: number;
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** Shortest-path heading interpolation (degrees). */
function lerpHeadingDeg(a: number, b: number, u: number): number {
  let d = (((b - a + 540) % 360) - 180) * u;
  return ((a + d + 360) % 360);
}

export interface UseAircraftLayerOptions {
  viewer: unknown | null;
  showFlightsRef: MutableRefObject<boolean>;
  entitiesRef: MutableRefObject<Map<string, unknown>>;
  aircraftDataRef: MutableRefObject<Map<string, AircraftData>>;
  aircraftHistoryRef: MutableRefObject<Map<string, [number, number, number][]>>;
  setFlightCount: (n: number) => void;
  setLastUpdate: Dispatch<SetStateAction<string>>;
  setSelectedAc: Dispatch<SetStateAction<AircraftData | null>>;
  /** Called after entities/data maps are updated (e.g. sync track overlays). */
  onAfterUpdate?: () => void;
  intervalMs?: number;
}

/**
 * Polls ADS-B data via `/api/flights` (adsb.lol), validates records, and syncs entities.
 * Positions interpolate smoothly between polls; failures backoff and the last known fleet is kept.
 */
export function useAircraftLayer({
  viewer,
  showFlightsRef,
  entitiesRef,
  aircraftDataRef,
  aircraftHistoryRef,
  setFlightCount,
  setLastUpdate,
  setSelectedAc,
  onAfterUpdate,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseAircraftLayerOptions): void {
  const motionRef = useRef<Map<string, MotionSegment>>(new Map());
  const basePollMsRef = useRef(intervalMs);
  const destroyedRef = useRef(false);
  const backoffMsRef = useRef(intervalMs);
  const inFlightRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWarnAtRef = useRef(0);
  basePollMsRef.current = intervalMs;

  useEffect(() => {
    destroyedRef.current = false;
    return () => {
      destroyedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!viewer) return;
    const Cesium = (window as unknown as { Cesium: Record<string, unknown> }).Cesium;
    if (!Cesium) return;

    const v = viewer as {
      isDestroyed: () => boolean;
      entities: { add: (o: unknown) => unknown; remove: (e: unknown) => void };
    };
    if (v.isDestroyed()) return;

    backoffMsRef.current = intervalMs;
    inFlightRef.current = false;

    const Cartesian3 = Cesium.Cartesian3 as {
      fromDegrees: (longitude: number, latitude: number, height?: number, ellipsoid?: unknown, result?: unknown) => unknown;
    };
    const CallbackProperty = Cesium.CallbackProperty as new (cb: (t: unknown, r?: unknown) => unknown, isConstant: boolean) => unknown;

    const sampleMotion = (key: string): { lon: number; lat: number; hdg: number } | null => {
      const seg = motionRef.current.get(key);
      if (!seg) return null;
      const rawT = (performance.now() - seg.startMs) / seg.durationMs;
      const u = clamp01(rawT);
      const lon = seg.startLon + (seg.endLon - seg.startLon) * u;
      const lat = seg.startLat + (seg.endLat - seg.startLat) * u;
      const hdg = lerpHeadingDeg(seg.startHdg, seg.endHdg, u);
      return { lon, lat, hdg };
    };

    const positionFromSample = (key: string) => {
      const pt = sampleMotion(key);
      if (!pt) return Cartesian3.fromDegrees(0, 0);
      return Cartesian3.fromDegrees(pt.lon, pt.lat);
    };

    const applyFleetPayload = (list: unknown[] | null | undefined) => {
      if (!list || !Array.isArray(list)) return;
      const seen = new Set<string>();

      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const ac = parseAdsbAircraft(raw as Record<string, unknown>);
        if (!ac) continue;
        seen.add(ac.icao);
        aircraftDataRef.current.set(ac.icao, ac);

        const trail = aircraftHistoryRef.current.get(ac.icao) ?? [];
        const prev = trail[trail.length - 1];
        if (
          !prev ||
          Math.abs(prev[0] - ac.lon) > 1e-6 ||
          Math.abs(prev[1] - ac.lat) > 1e-6 ||
          Math.abs(prev[2] - ac.altM) > 15
        ) {
          trail.push([ac.lon, ac.lat, ac.altM]);
          while (trail.length > MAX_AIRCRAFT_TRAIL_POINTS) trail.shift();
          aircraftHistoryRef.current.set(ac.icao, trail);
        }

        const prevSeg = motionRef.current.get(ac.icao);
        motionRef.current.set(ac.icao, {
          startLon: prevSeg ? prevSeg.endLon : ac.lon,
          startLat: prevSeg ? prevSeg.endLat : ac.lat,
          startHdg: prevSeg ? prevSeg.endHdg : ac.heading,
          endLon: ac.lon,
          endLat: ac.lat,
          endHdg: ac.heading,
          startMs: performance.now(),
          durationMs: basePollMsRef.current,
        });

        const color = altColorCss(ac.altM);
        const show = showFlightsRef.current;

        if (entitiesRef.current.has(ac.icao)) {
          const entity = entitiesRef.current.get(ac.icao) as {
            billboard: { show: boolean; image: string };
            label: { show: boolean; text: string };
          };
          entity.billboard.show = show;
          entity.label.show = show;
          entity.label.text = ac.callsign;
          entity.billboard.image = airplaneSvgUri(color, ac.heading);
        } else {
          const positionProp = new CallbackProperty(() => positionFromSample(ac.icao), false);

          const entity = v.entities.add({
            id: ac.icao,
            position: positionProp,
            billboard: {
              image: airplaneSvgUri(color, ac.heading),
              width: 28,
              height: 28,
              verticalOrigin: (Cesium.VerticalOrigin as { CENTER: unknown }).CENTER,
              horizontalOrigin: (Cesium.HorizontalOrigin as { CENTER: unknown }).CENTER,
              show,
              sizeInMeters: false,
            },
            label: {
              text: ac.callsign,
              font: "10px monospace",
              fillColor: altColor(Cesium as never, ac.altM),
              outlineColor: (Cesium.Color as { BLACK: unknown }).BLACK,
              outlineWidth: 2,
              style: (Cesium.LabelStyle as { FILL_AND_OUTLINE: unknown }).FILL_AND_OUTLINE,
              pixelOffset: new (Cesium.Cartesian2 as new (x: number, y: number) => unknown)(0, -22),
              verticalOrigin: (Cesium.VerticalOrigin as { BOTTOM: unknown }).BOTTOM,
              show,
              translucencyByDistance: new (Cesium.NearFarScalar as new (a: number, b: number, c: number, d: number) => unknown)(
                1e5,
                1.0,
                2e6,
                0.0
              ),
            },
          });
          entitiesRef.current.set(ac.icao, entity);
        }
      }

      for (const [icao, entity] of entitiesRef.current) {
        if (!seen.has(icao)) {
          v.entities.remove(entity);
          entitiesRef.current.delete(icao);
          aircraftDataRef.current.delete(icao);
          aircraftHistoryRef.current.delete(icao);
          motionRef.current.delete(icao);
        }
      }

      setFlightCount(seen.size);
      const now = new Date();
      setLastUpdate(
        `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}Z`
      );
      setSelectedAc((prev) => (prev ? aircraftDataRef.current.get(prev.icao) ?? null : null));
      onAfterUpdate?.();
    };

    const throttledWarn = (msg: string, detail?: string) => {
      const now = Date.now();
      if (now - lastWarnAtRef.current < WARN_THROTTLE_MS) return;
      lastWarnAtRef.current = now;
      if (detail) console.warn(msg, detail);
      else console.warn(msg);
    };

    const schedule = (delayMs: number) => {
      if (destroyedRef.current) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => void pollLoop(), delayMs);
    };

    const pollLoop = async () => {
      if (destroyedRef.current || v.isDestroyed()) return;
      if (inFlightRef.current) {
        schedule(backoffMsRef.current);
        return;
      }

      inFlightRef.current = true;
      try {
        const res = await fetch(FETCH_URL, { cache: "no-store" });
        const text = await res.text().catch(() => "");

        if (res.status === 429) {
          const ra = res.headers.get("Retry-After");
          const sec = ra ? parseInt(ra, 10) : NaN;
          if (Number.isFinite(sec) && sec > 0) {
            backoffMsRef.current = Math.min(Math.max(sec * 1000, basePollMsRef.current), MAX_BACKOFF_MS);
          } else {
            backoffMsRef.current = Math.min(
              Math.max(Math.round(backoffMsRef.current * 1.8), basePollMsRef.current),
              MAX_BACKOFF_MS
            );
          }
          throttledWarn(
            "[flights] rate limited; backing off",
            `next poll in ~${Math.round(backoffMsRef.current / 1000)}s`
          );
        } else if (!res.ok) {
          const looksLike429 = text.includes("429");
          if (looksLike429) {
            backoffMsRef.current = Math.min(
              Math.max(Math.round(backoffMsRef.current * 1.8), basePollMsRef.current),
              MAX_BACKOFF_MS
            );
            throttledWarn(
              "[flights] upstream rate limited; backing off",
              `next poll in ~${Math.round(backoffMsRef.current / 1000)}s`
            );
          } else {
            throttledWarn("[flights] request failed", `${res.status} ${text.slice(0, 160)}`);
            backoffMsRef.current = Math.min(backoffMsRef.current + 3000, MAX_BACKOFF_MS);
          }
        } else {
          backoffMsRef.current = basePollMsRef.current;
          let data: { ac?: unknown[] };
          try {
            data = JSON.parse(text) as { ac?: unknown[] };
          } catch {
            throttledWarn("[flights] invalid JSON from /api/flights");
            backoffMsRef.current = Math.min(backoffMsRef.current + 5000, MAX_BACKOFF_MS);
            return;
          }
          applyFleetPayload(data.ac);
        }
      } catch (e) {
        throttledWarn("[flights] update error", String(e));
        backoffMsRef.current = Math.min(Math.round(backoffMsRef.current * 1.5), MAX_BACKOFF_MS);
      } finally {
        inFlightRef.current = false;
        if (!destroyedRef.current) schedule(backoffMsRef.current);
      }
    };

    schedule(0);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      inFlightRef.current = false;
      motionRef.current.clear();
    };
  }, [
    viewer,
    showFlightsRef,
    entitiesRef,
    aircraftDataRef,
    aircraftHistoryRef,
    setFlightCount,
    setLastUpdate,
    setSelectedAc,
    onAfterUpdate,
    intervalMs,
  ]);
}
