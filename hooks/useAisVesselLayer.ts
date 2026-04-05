"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import { shipColorCss, vesselArrowSvgUri } from "@/lib/vesselBillboard";
import type { VesselData } from "@/types/vessel";

// How often to poll /api/vessels for fresh AIS snapshots.
const DEFAULT_POLL_MS = 60_000;
// How often to record the smoothly-interpolated position for trail rendering.
const INTERP_TICK_MS = 2_000;
// Cap the number of vessels drawn on the globe.
const MAX_DISPLAY = 500;
const TRAIL_MAX_POINTS = 15;
const ALTITUDE_M = 12;
const TRAIL_GLOW_POWER = 0.07;
const TRAIL_WIDTH_PX = 2;
const TRAIL_COLOR_ALPHA = 0.38;

interface MotionSegment {
  startLon: number; startLat: number; startHdg: number;
  endLon:   number; endLat:   number; endHdg:   number;
  startMs: number; durationMs: number;
}

/**
 * [minLat, minLon, maxLat, maxLon] bounding box for the AIS stream.
 * null / undefined = global coverage.
 * Change this value to re-fetch vessels for a different region.
 */
export type AisBbox = [number, number, number, number] | null | undefined;

export interface UseAisVesselLayerOptions {
  viewer: unknown | null;
  showVesselsRef:    MutableRefObject<boolean>;
  vesselEntitiesRef: MutableRefObject<Map<string, unknown>>;
  vesselTrailsRef:   MutableRefObject<Map<string, unknown>>;
  vesselHistoryRef:  MutableRefObject<Map<string, [number, number][]>>;
  vesselDataRef:     MutableRefObject<Map<string, VesselData>>;
  setVesselCount:    (n: number) => void;
  setSelectedVessel: Dispatch<SetStateAction<VesselData | null>>;
  pollIntervalMs?:   number;
  /** Restrict the AIS stream to this bounding box. Changing this clears current vessels and re-fetches. */
  bbox?:             AisBbox;
}

/**
 * Polls /api/vessels (AISstream) and drives Cesium billboards + trails.
 * Positions are interpolated smoothly between API snapshots so ships glide
 * rather than jumping. Falls back silently when AISSTREAM_API_KEY is absent.
 *
 * Drop-in replacement for useMockVesselLayer — accepts the same ref/callback props.
 */
export function useAisVesselLayer({
  viewer,
  showVesselsRef,
  vesselEntitiesRef,
  vesselTrailsRef,
  vesselHistoryRef,
  vesselDataRef,
  setVesselCount,
  setSelectedVessel,
  pollIntervalMs = DEFAULT_POLL_MS,
  bbox,
}: UseAisVesselLayerOptions): void {
  const motionRef      = useRef<Map<string, MotionSegment>>(new Map());
  const pollTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const interpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchingRef    = useRef(false);

  useEffect(() => {
    if (!viewer) return;
    const Cesium = (window as unknown as { Cesium: Record<string, unknown> }).Cesium;
    if (!Cesium) return;

    const v = viewer as {
      isDestroyed: () => boolean;
      entities: { add: (o: unknown) => unknown; remove: (e: unknown) => void };
    };
    if (v.isDestroyed()) return;

    // ── Cesium type aliases ────────────────────────────────────────────
    const Ellipsoid   = Cesium.Ellipsoid as { WGS84: unknown };
    const Cartesian3  = Cesium.Cartesian3 as {
      fromDegrees: (lon: number, lat: number, h: number, ellipsoid?: unknown, result?: unknown) => unknown;
    };
    const Cartesian3Ctor    = Cesium.Cartesian3 as new () => unknown;
    const CallbackProperty  = Cesium.CallbackProperty as new (cb: () => unknown, isConst: boolean) => unknown;
    const MathC             = Cesium.Math as { toRadians: (d: number) => number };

    /** Pooled Cartesian3 arrays per vessel — avoids GC churn on trail updates. */
    const trailCartesianPools = new Map<string, unknown[]>();

    // ── Motion interpolation ───────────────────────────────────────────
    function clamp01(t: number) { return Math.min(1, Math.max(0, t)); }

    function sampleMotion(key: string): { lon: number; lat: number; hdg: number } | null {
      const seg = motionRef.current.get(key);
      if (!seg) return null;
      const u   = clamp01((performance.now() - seg.startMs) / seg.durationMs);
      const lon = seg.startLon + (seg.endLon - seg.startLon) * u;
      const lat = seg.startLat + (seg.endLat - seg.startLat) * u;
      const dH  = ((seg.endHdg - seg.startHdg + 540) % 360) - 180;
      return { lon, lat, hdg: seg.startHdg + dH * u };
    }

    function positionFromSample(key: string) {
      const pt = sampleMotion(key);
      if (!pt) return Cartesian3.fromDegrees(0, 0, 0, Ellipsoid.WGS84);
      return Cartesian3.fromDegrees(pt.lon, pt.lat, ALTITUDE_M, Ellipsoid.WGS84);
    }

    function trailPositionsFromHistory(key: string, history: [number, number][]): unknown[] | null {
      const n = history.length;
      if (n < 2) return null;
      let pool = trailCartesianPools.get(key);
      if (!pool || pool.length < n) {
        const next = pool ?? [];
        while (next.length < n) next.push(new Cartesian3Ctor());
        trailCartesianPools.set(key, next);
        pool = next;
      }
      for (let i = 0; i < n; i++) {
        const [lon, lat] = history[i]!;
        Cartesian3.fromDegrees(lon, lat, ALTITUDE_M, Ellipsoid.WGS84, pool[i]);
      }
      return pool.slice(0, n);
    }

    // ── Cesium entity helpers ──────────────────────────────────────────
    function upsertTrail(key: string) {
      const history   = vesselHistoryRef.current.get(key) ?? [];
      const positions = trailPositionsFromHistory(key, history);
      if (!positions) return;
      const vd    = vesselDataRef.current.get(key);
      const color = shipColorCss(vd?.shipType ?? 0);
      const trailColor = (Cesium.Color as { fromCssColorString: (s: string) => { withAlpha: (a: number) => unknown } })
        .fromCssColorString(color).withAlpha(TRAIL_COLOR_ALPHA);
      const ArcType = Cesium.ArcType as { GEODESIC: unknown };
      const show    = showVesselsRef.current;

      if (vesselTrailsRef.current.has(key)) {
        const trail = vesselTrailsRef.current.get(key) as { polyline: { positions: unknown[]; show: boolean } };
        trail.polyline.positions = positions;
        trail.polyline.show      = show;
      } else {
        const trail = v.entities.add({
          id: `trail_${key}`,
          polyline: {
            positions,
            width: TRAIL_WIDTH_PX,
            arcType: ArcType.GEODESIC,
            material: new (Cesium.PolylineGlowMaterialProperty as new (o: { glowPower: number; color: unknown }) => unknown)({
              glowPower: TRAIL_GLOW_POWER,
              color: trailColor,
            }),
            show,
            clampToGround: false,
          },
        });
        vesselTrailsRef.current.set(key, trail);
      }
    }

    function upsertEntity(key: string, vd: VesselData) {
      const color = shipColorCss(vd.shipType);
      const show  = showVesselsRef.current;

      if (vesselEntitiesRef.current.has(key)) {
        const e = vesselEntitiesRef.current.get(key) as {
          billboard: { show: boolean; image: string };
          label:     { show: boolean };
        };
        e.billboard.show  = show;
        e.label.show      = show;
        e.billboard.image = vesselArrowSvgUri(color);
      } else {
        const CesiumColor  = (Cesium.Color as { fromCssColorString: (s: string) => unknown }).fromCssColorString(color);
        const positionProp = new CallbackProperty(() => positionFromSample(key), false);
        const rotationProp = new CallbackProperty(() => {
          const pt = sampleMotion(key);
          return pt ? MathC.toRadians(pt.hdg) : 0;
        }, false);

        const e = v.entities.add({
          id: `vessel_${key}`,
          position: positionProp,
          billboard: {
            image: vesselArrowSvgUri(color),
            width: 28, height: 36,
            verticalOrigin:   (Cesium.VerticalOrigin   as { CENTER: unknown }).CENTER,
            horizontalOrigin: (Cesium.HorizontalOrigin as { CENTER: unknown }).CENTER,
            rotation: rotationProp,
            show, sizeInMeters: false,
            eyeOffset: new (Cesium.Cartesian3 as new (x: number, y: number, z: number) => unknown)(0, 0, -120),
          },
          label: {
            text:         vd.name || vd.mmsi,
            font:         "10px 'Courier New',monospace",
            fillColor:    CesiumColor,
            outlineColor: (Cesium.Color as { BLACK: unknown }).BLACK,
            outlineWidth: 2,
            style:          (Cesium.LabelStyle as { FILL_AND_OUTLINE: unknown }).FILL_AND_OUTLINE,
            pixelOffset:    new (Cesium.Cartesian2 as new (x: number, y: number) => unknown)(0, -20),
            verticalOrigin: (Cesium.VerticalOrigin as { BOTTOM: unknown }).BOTTOM,
            show,
            translucencyByDistance: new (Cesium.NearFarScalar as new (a: number, b: number, c: number, d: number) => unknown)(
              5e4, 1.0, 1.5e6, 0.0,
            ),
          },
        });
        vesselEntitiesRef.current.set(key, e);
      }
    }

    function removeVessel(key: string) {
      const entity = vesselEntitiesRef.current.get(key);
      if (entity) { v.entities.remove(entity); vesselEntitiesRef.current.delete(key); }
      const trail = vesselTrailsRef.current.get(key);
      if (trail)  { v.entities.remove(trail);  vesselTrailsRef.current.delete(key); }
      motionRef.current.delete(key);
      vesselHistoryRef.current.delete(key);
      vesselDataRef.current.delete(key);
      trailCartesianPools.delete(key);
    }

    // ── Apply a fresh snapshot of vessel positions ─────────────────────
    function applyVesselList(vessels: VesselData[]) {
      if (v.isDestroyed()) return;
      const now  = performance.now();
      const seen = new Set<string>();

      for (const vd of vessels) {
        const key = vd.mmsi;
        if (!key) continue;
        seen.add(key);

        // Smooth motion from current interpolated position toward new fix.
        const existing = motionRef.current.get(key);
        const prev     = existing ? sampleMotion(key) : null;
        motionRef.current.set(key, {
          startLon: prev?.lon ?? existing?.endLon ?? vd.lon,
          startLat: prev?.lat ?? existing?.endLat ?? vd.lat,
          startHdg: prev?.hdg ?? existing?.endHdg ?? vd.heading,
          endLon:   vd.lon,
          endLat:   vd.lat,
          endHdg:   vd.heading,
          startMs:    now,
          durationMs: pollIntervalMs,
        });

        vesselDataRef.current.set(key, vd);
        upsertEntity(key, vd);

        // Append the reported fix to the trail history.
        const history = vesselHistoryRef.current.get(key) ?? [];
        const last    = history[history.length - 1];
        if (!last || Math.abs(last[0] - vd.lon) > 1e-8 || Math.abs(last[1] - vd.lat) > 1e-8) {
          history.push([vd.lon, vd.lat]);
          while (history.length > TRAIL_MAX_POINTS) history.shift();
          vesselHistoryRef.current.set(key, history);
        }
        upsertTrail(key);
      }

      // Remove vessels absent from this snapshot.
      for (const key of [...vesselEntitiesRef.current.keys()]) {
        if (!seen.has(key)) removeVessel(key);
      }

      setVesselCount(seen.size);
      setSelectedVessel(prev => prev ? (vesselDataRef.current.get(prev.mmsi) ?? null) : null);
    }

    // ── Interpolation tick: record smoothed positions for trails ───────
    const interpTick = () => {
      if (v.isDestroyed()) return;
      for (const key of vesselDataRef.current.keys()) {
        const pt = sampleMotion(key);
        if (!pt) continue;
        const history = vesselHistoryRef.current.get(key) ?? [];
        const last    = history[history.length - 1];
        if (last && Math.abs(last[0] - pt.lon) < 1e-7 && Math.abs(last[1] - pt.lat) < 1e-7) continue;
        history.push([pt.lon, pt.lat]);
        while (history.length > TRAIL_MAX_POINTS) history.shift();
        vesselHistoryRef.current.set(key, history);
        upsertTrail(key);
      }
    };

    // ── Polling ────────────────────────────────────────────────────────
    const fetchAndApply = async () => {
      if (fetchingRef.current || v.isDestroyed()) return;
      fetchingRef.current = true;
      try {
        const url = bbox
          ? `/api/vessels?bbox=${bbox.join(",")}`
          : "/api/vessels";
        const res = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          console.warn("[AIS] /api/vessels returned", res.status);
          return;
        }
        const data = (await res.json()) as { vessels?: VesselData[]; error?: string; total?: number };
        if (data.error) {
          console.warn("[AIS]", data.error);
          return;
        }
        const vessels = (data.vessels ?? []).slice(0, MAX_DISPLAY);
        if (vessels.length) applyVesselList(vessels);
      } catch (err) {
        console.warn("[AIS] fetch failed:", err);
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchAndApply();
    pollTimerRef.current   = setInterval(fetchAndApply, pollIntervalMs);
    interpTimerRef.current = setInterval(interpTick,    INTERP_TICK_MS);

    return () => {
      if (pollTimerRef.current)   { clearInterval(pollTimerRef.current);   pollTimerRef.current   = null; }
      if (interpTimerRef.current) { clearInterval(interpTimerRef.current); interpTimerRef.current = null; }
      // Remove all Cesium entities so switching regions starts with a clean slate.
      if (!v.isDestroyed()) {
        for (const entity of vesselEntitiesRef.current.values()) v.entities.remove(entity);
        for (const trail  of vesselTrailsRef.current.values())   v.entities.remove(trail);
      }
      vesselEntitiesRef.current.clear();
      vesselTrailsRef.current.clear();
      vesselHistoryRef.current.clear();
      vesselDataRef.current.clear();
      motionRef.current.clear();
      trailCartesianPools.clear();
      setVesselCount(0);
    };
  // bbox is intentionally included — changing region tears down + re-fetches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewer,
    showVesselsRef,
    vesselEntitiesRef,
    vesselTrailsRef,
    vesselHistoryRef,
    vesselDataRef,
    setVesselCount,
    setSelectedVessel,
    pollIntervalMs,
    // Serialize bbox so React does a value comparison rather than reference comparison.
    bbox?.join(",") ?? "global",
  ]);
}
