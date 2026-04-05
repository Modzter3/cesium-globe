"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import type { EarthquakeData } from "@/types/earthquake";

// USGS GeoJSON feeds — M2.5+ last 24 hours (CORS-enabled, no key required)
const USGS_FEED =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson";

const REFRESH_MS   = 5 * 60 * 1000; // 5 minutes
const PULSE_SPEED  = 1.2;
const PULSE_AMP    = 2.5;

function quakeColor(mag: number): string {
  if (mag >= 6)  return "#cc0000";
  if (mag >= 5)  return "#ff4400";
  if (mag >= 4)  return "#ff8800";
  return "#ffdd00";
}

function quakePixelSize(mag: number): number {
  if (mag >= 6)  return 16;
  if (mag >= 5)  return 12;
  if (mag >= 4)  return 9;
  if (mag >= 3)  return 6;
  return 4;
}

export interface UseEarthquakeLayerOptions {
  viewer: unknown | null;
  showEarthquakesRef:    MutableRefObject<boolean>;
  earthquakeEntitiesRef: MutableRefObject<Map<string, unknown>>;
  earthquakeDataRef:     MutableRefObject<Map<string, EarthquakeData>>;
  setEarthquakeCount:    (n: number) => void;
  setSelectedEarthquake: Dispatch<SetStateAction<EarthquakeData | null>>;
  setFeedEarthquakes?:   (events: EarthquakeData[]) => void;
}

/**
 * Fetches M2.5+ earthquakes from the USGS real-time GeoJSON feed and renders
 * them as pulsing Cesium PointGraphics — sized by magnitude, colored by severity.
 */
export function useEarthquakeLayer({
  viewer,
  showEarthquakesRef,
  earthquakeEntitiesRef,
  earthquakeDataRef,
  setEarthquakeCount,
  setSelectedEarthquake,
  setFeedEarthquakes,
}: UseEarthquakeLayerOptions): void {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const Cesium = (window as unknown as { Cesium: Record<string, unknown> }).Cesium;
    if (!Cesium) return;

    const v = viewer as {
      isDestroyed: () => boolean;
      entities: { add: (o: unknown) => unknown; remove: (e: unknown) => void };
    };
    if (v.isDestroyed()) return;

    const Cartesian3   = Cesium.Cartesian3  as { fromDegrees: (lon: number, lat: number, alt?: number) => unknown };
    const Color        = Cesium.Color       as { fromCssColorString: (s: string) => { withAlpha: (a: number) => unknown } };
    const CallbackProp = Cesium.CallbackProperty as new (cb: () => unknown, isConst: boolean) => unknown;
    const HeightRef    = Cesium.HeightReference as { CLAMP_TO_GROUND: unknown };
    const NearFar      = Cesium.NearFarScalar   as new (a: number, b: number, c: number, d: number) => unknown;

    function removeAll() {
      if (!v.isDestroyed()) {
        for (const e of earthquakeEntitiesRef.current.values()) v.entities.remove(e);
      }
      earthquakeEntitiesRef.current.clear();
      earthquakeDataRef.current.clear();
    }

    function addEntity(eq: EarthquakeData) {
      if (earthquakeEntitiesRef.current.has(eq.id)) return;
      const color   = quakeColor(eq.mag);
      const base    = quakePixelSize(eq.mag);
      const show    = showEarthquakesRef.current;
      const cesColor = Color.fromCssColorString(color);

      const sizeCb = new CallbackProp(() => {
        const t = (performance.now() / 1000) * PULSE_SPEED;
        return base + (Math.sin(t) * 0.5 + 0.5) * PULSE_AMP;
      }, false);

      const e = v.entities.add({
        id:       `quake_${eq.id}`,
        position: Cartesian3.fromDegrees(eq.lon, eq.lat, 0),
        point: {
          pixelSize:       sizeCb,
          color:           cesColor.withAlpha(0.82),
          outlineColor:    cesColor.withAlpha(0.25),
          outlineWidth:    4,
          heightReference: HeightRef.CLAMP_TO_GROUND,
          show,
          scaleByDistance:           new NearFar(1e4, 1.5, 8e6, 0.4),
          disableDepthTestDistance:  1e10,
        },
      });

      earthquakeEntitiesRef.current.set(eq.id, e);
      earthquakeDataRef.current.set(eq.id, eq);
    }

    const fetchAndApply = async () => {
      if (v.isDestroyed()) return;
      try {
        const res = await fetch(USGS_FEED, {
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);

        const json = await res.json() as {
          features: Array<{
            id: string;
            properties: {
              time: number; mag: number; magType: string;
              place: string; tsunami: number;
            };
            geometry: { coordinates: [number, number, number] };
          }>;
        };

        const events: EarthquakeData[] = json.features
          .filter(f => f.properties.mag != null && f.geometry?.coordinates)
          .map(f => ({
            id:       f.id,
            time:     f.properties.time,
            mag:      f.properties.mag,
            magType:  f.properties.magType ?? "Mw",
            place:    f.properties.place ?? "",
            lat:      f.geometry.coordinates[1],
            lon:      f.geometry.coordinates[0],
            depth:    f.geometry.coordinates[2],
            url:      `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`,
            tsunami:  f.properties.tsunami ?? 0,
          }));

        removeAll();
        for (const eq of events) {
          if (v.isDestroyed()) break;
          addEntity(eq);
        }
        setEarthquakeCount(events.length);
        setFeedEarthquakes?.(events);
      } catch (err) {
        console.warn("[EARTHQUAKE] fetch failed:", err);
      }
    };

    fetchAndApply();
    timerRef.current = setInterval(fetchAndApply, REFRESH_MS);

    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      removeAll();
      setEarthquakeCount(0);
      setSelectedEarthquake(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);
}
