"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import {
  advanceMockVessels,
  createInitialMockVessels,
  mockVesselToVesselData,
  type MockVessel,
} from "@/lib/mockVessels";
import { shipColorCss, vesselArrowSvgUri } from "@/lib/vesselBillboard";
import type { VesselData } from "@/types/vessel";

/** Last N simulated fixes per vessel (one point per simulation tick). */
const TRAIL_MAX_POINTS = 20;
const DEFAULT_INTERVAL_MS = 2000;
const ALTITUDE_M = 12;
/** Subtle glow: lower power + softer alpha keeps trails readable without bloom. */
const TRAIL_GLOW_POWER = 0.07;
const TRAIL_WIDTH_PX = 2;
const TRAIL_COLOR_ALPHA = 0.38;

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

export interface UseMockVesselLayerOptions {
  viewer: unknown | null;
  showVesselsRef: MutableRefObject<boolean>;
  vesselEntitiesRef: MutableRefObject<Map<string, unknown>>;
  vesselTrailsRef: MutableRefObject<Map<string, unknown>>;
  vesselHistoryRef: MutableRefObject<Map<string, [number, number][]>>;
  vesselDataRef: MutableRefObject<Map<string, VesselData>>;
  setVesselCount: (n: number) => void;
  setSelectedVessel: Dispatch<SetStateAction<VesselData | null>>;
  intervalMs?: number;
}

/**
 * Drives mock vessel positions and syncs billboards + trails to a Cesium Viewer.
 * Markers interpolate smoothly between simulation steps; icons rotate with heading.
 * Trails keep the last TRAIL_MAX_POINTS positions per ship as a geodesic glow polyline.
 */
export function useMockVesselLayer({
  viewer,
  showVesselsRef,
  vesselEntitiesRef,
  vesselTrailsRef,
  vesselHistoryRef,
  vesselDataRef,
  setVesselCount,
  setSelectedVessel,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseMockVesselLayerOptions): void {
  const vesselsStateRef = useRef<MockVessel[] | null>(null);
  const motionRef = useRef<Map<string, MotionSegment>>(new Map());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const Cesium = (window as unknown as { Cesium: Record<string, unknown> }).Cesium;
    if (!Cesium) return;

    const v = viewer as {
      isDestroyed: () => boolean;
      entities: { add: (o: unknown) => unknown; remove: (e: unknown) => void };
    };
    if (v.isDestroyed()) return;

    if (!vesselsStateRef.current) {
      vesselsStateRef.current = createInitialMockVessels();
    }

    /** Reused Cartesian3 slots per vessel — avoids allocating ~20 vectors every tick. */
    const trailCartesianPools = new Map<string, unknown[]>();

    const Ellipsoid = Cesium.Ellipsoid as { WGS84: unknown };
    const Cartesian3 = Cesium.Cartesian3 as {
      fromDegrees: (lon: number, lat: number, h: number, ellipsoid?: unknown, result?: unknown) => unknown;
    };
    const CallbackProperty = Cesium.CallbackProperty as new (cb: (t: unknown, r?: unknown) => unknown, isConstant: boolean) => unknown;
    const MathC = Cesium.Math as { toRadians: (d: number) => number };

    const sampleMotion = (key: string): { lon: number; lat: number; hdg: number } | null => {
      const seg = motionRef.current.get(key);
      if (!seg) return null;
      const rawT = (performance.now() - seg.startMs) / seg.durationMs;
      const u = clamp01(rawT);
      const lon = seg.startLon + (seg.endLon - seg.startLon) * u;
      const lat = seg.startLat + (seg.endLat - seg.startLat) * u;
      const dH = ((seg.endHdg - seg.startHdg + 540) % 360) - 180;
      const hdg = seg.startHdg + dH * u;
      return { lon, lat, hdg };
    };

    /** Always allocate; avoid passing Cesium's `result` (often undefined / wrong type for entity callbacks). */
    const positionFromSample = (key: string) => {
      const pt = sampleMotion(key);
      if (!pt) return Cartesian3.fromDegrees(0, 0, 0, Ellipsoid.WGS84);
      return Cartesian3.fromDegrees(pt.lon, pt.lat, ALTITUDE_M, Ellipsoid.WGS84);
    };

    const Cartesian3Ctor = Cesium.Cartesian3 as new () => unknown;

    /** Fills pooled Cartesian3s from [lon,lat][]; returns a fresh array reference for Cesium. */
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

    const applyTick = () => {
      if (!vesselsStateRef.current || v.isDestroyed()) return;
      const list = advanceMockVessels(vesselsStateRef.current, intervalMs / 1000);
      vesselsStateRef.current = list;
      const seen = new Set<string>();

      list.forEach((ship, index) => {
        const key = ship.id;
        seen.add(key);
        const vd = mockVesselToVesselData(ship, index);
        vesselDataRef.current.set(key, vd);

        const prevSeg = motionRef.current.get(key);
        const endLon = vd.lon;
        const endLat = vd.lat;
        const endHdg = vd.heading;
        motionRef.current.set(key, {
          startLon: prevSeg ? prevSeg.endLon : endLon,
          startLat: prevSeg ? prevSeg.endLat : endLat,
          startHdg: prevSeg ? prevSeg.endHdg : endHdg,
          endLon,
          endLat,
          endHdg,
          startMs: performance.now(),
          durationMs: intervalMs,
        });

        const history = vesselHistoryRef.current.get(key) ?? [];
        const last = history[history.length - 1];
        const moved =
          !last ||
          Math.abs(last[0] - vd.lon) > 1e-9 ||
          Math.abs(last[1] - vd.lat) > 1e-9;
        if (moved) {
          history.push([vd.lon, vd.lat]);
          while (history.length > TRAIL_MAX_POINTS) history.shift();
          vesselHistoryRef.current.set(key, history);
        }

        const color = shipColorCss(vd.shipType);
        const show = showVesselsRef.current;

        if (vesselEntitiesRef.current.has(key)) {
          const e = vesselEntitiesRef.current.get(key) as {
            billboard: { show: boolean; image: string };
            label: { show: boolean };
          };
          e.billboard.show = show;
          e.label.show = show;
          e.billboard.image = vesselArrowSvgUri(color);
        } else {
          const CesiumColor = (Cesium.Color as { fromCssColorString: (s: string) => unknown }).fromCssColorString(color);

          const positionProp = new CallbackProperty(() => positionFromSample(key), false);

          const rotationProp = new CallbackProperty(() => {
            const pt = sampleMotion(key);
            if (!pt) return 0;
            return MathC.toRadians(pt.hdg);
          }, false);

          const e = v.entities.add({
            id: `vessel_${key}`,
            position: positionProp,
            billboard: {
              image: vesselArrowSvgUri(color),
              width: 22,
              height: 26,
              verticalOrigin: (Cesium.VerticalOrigin as { CENTER: unknown }).CENTER,
              horizontalOrigin: (Cesium.HorizontalOrigin as { CENTER: unknown }).CENTER,
              rotation: rotationProp,
              show,
              sizeInMeters: false,
              eyeOffset: new (Cesium.Cartesian3 as new (x: number, y: number, z: number) => unknown)(0, 0, -120),
            },
            label: {
              text: vd.name,
              font: "9px monospace",
              fillColor: CesiumColor,
              outlineColor: (Cesium.Color as { BLACK: unknown }).BLACK,
              outlineWidth: 2,
              style: (Cesium.LabelStyle as { FILL_AND_OUTLINE: unknown }).FILL_AND_OUTLINE,
              pixelOffset: new (Cesium.Cartesian2 as new (x: number, y: number) => unknown)(0, -20),
              verticalOrigin: (Cesium.VerticalOrigin as { BOTTOM: unknown }).BOTTOM,
              show,
              translucencyByDistance: new (Cesium.NearFarScalar as new (a: number, b: number, c: number, d: number) => unknown)(
                5e4,
                1.0,
                1.5e6,
                0.0
              ),
            },
          });
          vesselEntitiesRef.current.set(key, e);
        }

        const history2 = vesselHistoryRef.current.get(key) ?? [];
        const positions = trailPositionsFromHistory(key, history2);
        if (positions) {
          const trailColor = (Cesium.Color as { fromCssColorString: (s: string) => { withAlpha: (a: number) => unknown } })
            .fromCssColorString(color)
            .withAlpha(TRAIL_COLOR_ALPHA);
          const ArcType = Cesium.ArcType as { GEODESIC: unknown };

          if (vesselTrailsRef.current.has(key)) {
            const trail = vesselTrailsRef.current.get(key) as {
              polyline: { positions: unknown[]; show: boolean };
            };
            trail.polyline.positions = positions;
            trail.polyline.show = show;
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
      });

      for (const [key, entity] of vesselEntitiesRef.current) {
        if (!seen.has(key)) {
          v.entities.remove(entity);
          vesselEntitiesRef.current.delete(key);
          motionRef.current.delete(key);
          const trail = vesselTrailsRef.current.get(key);
          if (trail) {
            v.entities.remove(trail);
            vesselTrailsRef.current.delete(key);
          }
          trailCartesianPools.delete(key);
          vesselHistoryRef.current.delete(key);
          vesselDataRef.current.delete(key);
        }
      }

      setVesselCount(seen.size);
      setSelectedVessel((prev) => (prev ? vesselDataRef.current.get(prev.mmsi) ?? null : null));
    };

    applyTick();
    tickRef.current = setInterval(applyTick, intervalMs);

    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      motionRef.current.clear();
      trailCartesianPools.clear();
    };
  }, [
    viewer,
    showVesselsRef,
    vesselEntitiesRef,
    vesselTrailsRef,
    vesselHistoryRef,
    vesselDataRef,
    setVesselCount,
    setSelectedVessel,
    intervalMs,
  ]);
}
