"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import {
  json2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLong,
  degreesLat,
  SatRecError,
} from "satellite.js";
import type { SatRec } from "satellite.js";
import { satelliteSvgUri, satColorFromInclination } from "@/lib/satelliteIcon";
import type { SatelliteInfo, SatelliteOMM } from "@/types/satellite";

/** How many minutes to sample for the orbit preview polyline. */
const ORBIT_SAMPLE_MINS = 100;
/** Interval between orbit sample points (minutes). */
const ORBIT_STEP_MINS = 1;
/** Minimum altitude to consider a satellite valid (km above WGS-84). */
const MIN_ALT_KM = 50;

interface SatRecord {
  noradId: string;
  name: string;
  satrec: SatRec;
  inclination: number;  // degrees
  periodMin: number;    // minutes
  epoch: string;
}

export interface UseSatelliteLayerOptions {
  viewer: unknown | null;
  showSatellitesRef: MutableRefObject<boolean>;
  satEntitiesRef: MutableRefObject<Map<string, unknown>>;
  satOrbitsRef: MutableRefObject<Map<string, unknown>>;
  satDataRef: MutableRefObject<Map<string, SatRecord>>;
  setSatCount: (n: number) => void;
  setSelectedSat: Dispatch<SetStateAction<SatelliteInfo | null>>;
  group?: string;
}

/** Propagate satrec at a given Date → geodetic or null on failure. */
function getGeodetic(satrec: SatRec, date: Date) {
  const pv = propagate(satrec, date);
  if (satrec.error !== SatRecError.None) return null;
  const gst = gstime(date);
  const geo = eciToGeodetic(pv.position, gst);
  const altKm = geo.height;
  if (altKm < MIN_ALT_KM) return null;
  return { lon: degreesLong(geo.longitude), lat: degreesLat(geo.latitude), altKm };
}

/** Build an array of Cartesian3 positions spanning one orbit. */
function buildOrbitPath(
  satrec: SatRec,
  periodMin: number,
  Cartesian3: { fromDegrees: (lon: number, lat: number, alt: number) => unknown },
): unknown[] {
  const now = new Date();
  const sampleCount = Math.min(ORBIT_SAMPLE_MINS, Math.ceil(periodMin)) + 1;
  const stepMin = Math.max(ORBIT_STEP_MINS, periodMin / sampleCount);
  const positions: unknown[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = new Date(now.getTime() + i * stepMin * 60_000);
    const geo = getGeodetic(satrec, t);
    if (!geo) continue;
    positions.push(Cartesian3.fromDegrees(geo.lon, geo.lat, geo.altKm * 1000));
  }
  return positions;
}

/**
 * Loads satellite TLE data from /api/satellites, creates Cesium billboard + orbit
 * entities for each, and animates positions in real time via satellite.js SGP4.
 */
export function useSatelliteLayer({
  viewer,
  showSatellitesRef,
  satEntitiesRef,
  satOrbitsRef,
  satDataRef,
  setSatCount,
  setSelectedSat,
  group = "visual",
}: UseSatelliteLayerOptions): void {
  const fetchedRef = useRef(false);

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
    const Cartesian3 = Cesium.Cartesian3 as {
      fromDegrees: (lon: number, lat: number, alt: number) => unknown;
    };
    const CallbackProperty = Cesium.CallbackProperty as new (
      cb: () => unknown,
      isConst: boolean,
    ) => unknown;
    const Color = Cesium.Color as {
      fromCssColorString: (s: string) => unknown;
    };
    const ArcType  = Cesium.ArcType  as { NONE: unknown };
    const NearFarScalar = Cesium.NearFarScalar as new (
      a: number, b: number, c: number, d: number,
    ) => unknown;
    const VerticalOrigin   = Cesium.VerticalOrigin   as { CENTER: unknown };
    const HorizontalOrigin = Cesium.HorizontalOrigin as { CENTER: unknown };
    const Cartesian2 = Cesium.Cartesian2 as new (x: number, y: number) => unknown;
    const LabelStyle = Cesium.LabelStyle as { FILL_AND_OUTLINE: unknown };

    // ── Create a satellite entity ──────────────────────────────────────
    function addSatEntity(rec: SatRecord) {
      if (satEntitiesRef.current.has(rec.noradId)) return;
      const color = satColorFromInclination(rec.inclination);
      const show  = showSatellitesRef.current;

      const posCallback = new CallbackProperty(() => {
        const geo = getGeodetic(rec.satrec, new Date());
        if (!geo) return Cartesian3.fromDegrees(0, 0, 0);
        return Cartesian3.fromDegrees(geo.lon, geo.lat, geo.altKm * 1000);
      }, false);

      const entity = v.entities.add({
        id: `sat_${rec.noradId}`,
        position: posCallback,
        billboard: {
          image:            satelliteSvgUri(color),
          width:            20,
          height:           20,
          verticalOrigin:   VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          sizeInMeters:     false,
          show,
          eyeOffset: new (Cesium.Cartesian3 as new (x: number, y: number, z: number) => unknown)(0, 0, -200),
          scaleByDistance: new NearFarScalar(5e6, 1.0, 2e7, 0.5),
        },
        label: {
          text:         rec.name,
          font:         "9px monospace",
          fillColor:    Color.fromCssColorString(color),
          outlineColor: (Cesium.Color as { BLACK: unknown }).BLACK,
          outlineWidth: 2,
          style:          LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:    new Cartesian2(0, -18),
          verticalOrigin: (Cesium.VerticalOrigin as { BOTTOM: unknown }).BOTTOM,
          show,
          translucencyByDistance: new NearFarScalar(8e6, 1.0, 2e7, 0.0),
        },
      });
      satEntitiesRef.current.set(rec.noradId, entity);
    }

    // ── Create orbit path polyline ────────────────────────────────────
    function addOrbitPath(rec: SatRecord) {
      if (satOrbitsRef.current.has(rec.noradId)) return;
      const positions = buildOrbitPath(rec.satrec, rec.periodMin, Cartesian3);
      if (positions.length < 2) return;
      const color  = satColorFromInclination(rec.inclination);
      const show   = showSatellitesRef.current;

      const orbit = v.entities.add({
        id: `sat_orbit_${rec.noradId}`,
        polyline: {
          positions,
          width:         1.2,
          arcType:       ArcType.NONE,
          material:      Color.fromCssColorString(color + "55"),  // 33% alpha
          show,
          clampToGround: false,
        },
      });
      satOrbitsRef.current.set(rec.noradId, orbit);
    }

    // ── Load TLE data from API ─────────────────────────────────────────
    const load = async () => {
      if (fetchedRef.current || v.isDestroyed()) return;
      fetchedRef.current = true;
      try {
        const res = await fetch(`/api/satellites?group=${group}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          console.warn("[SAT] /api/satellites returned", res.status);
          return;
        }
        const json = (await res.json()) as {
          satellites?: SatelliteOMM[];
          error?: string;
        };
        if (json.error) {
          console.warn("[SAT]", json.error);
          return;
        }
        const omms = json.satellites ?? [];
        let loaded = 0;

        for (const omm of omms) {
          if (v.isDestroyed()) break;
          try {
            const satrec = json2satrec(omm as Parameters<typeof json2satrec>[0]);
            const inclDeg = Number(omm.INCLINATION);
            const mm = Number(omm.MEAN_MOTION);
            if (!mm || isNaN(mm) || mm <= 0) continue;
            const periodMin = 1440 / mm;
            const noradId = String(omm.NORAD_CAT_ID);
            const name = omm.OBJECT_NAME.trim();

            // Quick sanity-check: propagate at t=0 to confirm TLE is valid
            const test = getGeodetic(satrec, new Date());
            if (!test) continue;

            const rec: SatRecord = {
              noradId,
              name,
              satrec,
              inclination: inclDeg,
              periodMin,
              epoch: omm.EPOCH,
            };

            satDataRef.current.set(noradId, rec);
            addSatEntity(rec);
            addOrbitPath(rec);
            loaded++;
          } catch {
            // Skip satellites that fail to parse
          }
        }

        setSatCount(loaded);
      } catch (err) {
        console.warn("[SAT] fetch failed:", err);
      }
    };

    void load();

    return () => {
      fetchedRef.current = false;
      if (!v.isDestroyed()) {
        for (const e of satEntitiesRef.current.values()) v.entities.remove(e);
        for (const o of satOrbitsRef.current.values())   v.entities.remove(o);
      }
      satEntitiesRef.current.clear();
      satOrbitsRef.current.clear();
      satDataRef.current.clear();
      setSatCount(0);
      setSelectedSat(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, group]);
}

/**
 * Given a noradId, compute the live SatelliteInfo (altitude, velocity, etc.)
 * at the current moment from the stored SatRec.
 */
export function computeSatInfo(
  satDataRef: MutableRefObject<Map<string, SatRecord>>,
  noradId: string,
): SatelliteInfo | null {
  const rec = satDataRef.current.get(noradId);
  if (!rec) return null;
  const now = new Date();
  const pv = propagate(rec.satrec, now);
  if (rec.satrec.error !== SatRecError.None) return null;
  const gst = gstime(now);
  const geo = eciToGeodetic(pv.position, gst);
  const v = pv.velocity;
  const velKms = Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
  return {
    noradId: rec.noradId,
    name:    rec.name,
    inclination: rec.inclination,
    periodMin:   rec.periodMin,
    altKm:   geo.height,
    velKms,
    epoch:   rec.epoch,
  };
}
