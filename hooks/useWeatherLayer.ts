"use client";

import type { MutableRefObject } from "react";
import { useEffect, useRef } from "react";

/**
 * Adds a RainViewer precipitation-radar imagery layer to the Cesium viewer.
 * No API key required. Tiles refresh every 10 minutes.
 *
 * Returns a ref to the active ImageryLayer so the caller can toggle
 * `layer.show` directly without re-running the effect.
 */

const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
const TILE_SIZE      = 512;
const REFRESH_MS     = 10 * 60 * 1000;

// RainViewer NEXRAD-style colour scheme (6) with smoothing + snow enabled
const COLOR_SCHEME   = 6;
const OPTIONS        = "1_1"; // smooth=1, snow=1

export interface UseWeatherLayerOptions {
  viewer:          unknown | null;
  showWeatherRef:  MutableRefObject<boolean>;
  setWeatherReady: (ready: boolean) => void;
}

export function useWeatherLayer({
  viewer,
  showWeatherRef,
  setWeatherReady,
}: UseWeatherLayerOptions): MutableRefObject<unknown | null> {
  const layerRef = useRef<unknown | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const Cesium = (window as unknown as { Cesium: Record<string, unknown> }).Cesium;
    if (!Cesium) return;

    const v = viewer as {
      isDestroyed: () => boolean;
      imageryLayers: {
        addImageryProvider: (p: unknown) => unknown;
        remove: (l: unknown, destroy?: boolean) => void;
      };
    };
    if (v.isDestroyed()) return;

    const UrlTemplate = Cesium.UrlTemplateImageryProvider as new (opts: Record<string, unknown>) => unknown;

    const buildAndAdd = async () => {
      try {
        const res = await fetch(RAINVIEWER_API, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return;
        const json = await res.json() as {
          host?: string;
          radar?: { past?: Array<{ time: number; path: string }> };
        };

        const past = json.radar?.past ?? [];
        const latest = past.at(-1);
        if (!latest?.path) return;

        // Remove stale layer before adding updated one
        if (layerRef.current && !v.isDestroyed()) {
          v.imageryLayers.remove(layerRef.current, true);
          layerRef.current = null;
        }

        const tileUrl =
          `https://tilecache.rainviewer.com${latest.path}` +
          `/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/${OPTIONS}.png`;

        const provider = new UrlTemplate({
          url:            tileUrl,
          tileWidth:      TILE_SIZE,
          tileHeight:     TILE_SIZE,
          minimumLevel:   0,
          maximumLevel:   12,
          hasAlphaChannel: true,
          // Credit shown in bottom-right of globe
          credit: "Rain Viewer",
        });

        if (v.isDestroyed()) return;
        const layer = v.imageryLayers.addImageryProvider(provider) as {
          alpha: number;
          show: boolean;
        };
        layer.alpha = 0.72;
        layer.show  = showWeatherRef.current;

        layerRef.current = layer;
        setWeatherReady(true);
      } catch (err) {
        console.warn("[WEATHER] fetch failed:", err);
      }
    };

    buildAndAdd();
    timerRef.current = setInterval(buildAndAdd, REFRESH_MS);

    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (layerRef.current && !v.isDestroyed()) {
        v.imageryLayers.remove(layerRef.current as unknown, true);
        layerRef.current = null;
      }
      setWeatherReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  return layerRef;
}
