"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import { conflictColor, conflictPixelSize } from "@/lib/conflictStyle";
import type { ConflictEvent } from "@/types/conflict";

const REFRESH_MS    = 15 * 60 * 1000; // GDELT publishes every 15 minutes
const PULSE_SPEED   = 1.8;           // radians per second
const PULSE_AMP     = 1.8;           // max extra px on pulse

export interface UseConflictLayerOptions {
  viewer: unknown | null;
  showConflictsRef:    MutableRefObject<boolean>;
  conflictEntitiesRef: MutableRefObject<Map<string, unknown>>;
  conflictDataRef:     MutableRefObject<Map<string, ConflictEvent>>;
  setConflictCount:    (n: number) => void;
  setConflictError:    (e: string | null) => void;
  setSelectedConflict: Dispatch<SetStateAction<ConflictEvent | null>>;
  setFeedEvents?:      (events: ConflictEvent[]) => void;
  days?: number;
}

/**
 * Fetches conflict events from /api/conflicts (GDELT or ACLED) and renders
 * them as pulsing Cesium PointGraphics — sized by fatalities, colored by event type.
 */
export function useConflictLayer({
  viewer,
  showConflictsRef,
  conflictEntitiesRef,
  conflictDataRef,
  setConflictCount,
  setConflictError,
  setSelectedConflict,
  setFeedEvents,
  days = 7,
}: UseConflictLayerOptions): void {
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

    // ── Cesium aliases ─────────────────────────────────────────────────
    const Cartesian3 = Cesium.Cartesian3 as {
      fromDegrees: (lon: number, lat: number, alt?: number) => unknown;
    };
    const Color = Cesium.Color as {
      fromCssColorString: (s: string) => {
        withAlpha: (a: number) => unknown;
      };
    };
    const CallbackProperty = Cesium.CallbackProperty as new (
      cb: () => unknown,
      isConst: boolean,
    ) => unknown;
    const HeightReference = Cesium.HeightReference as { CLAMP_TO_GROUND: unknown };
    const NearFarScalar   = Cesium.NearFarScalar   as new (
      a: number, b: number, c: number, d: number,
    ) => unknown;
    const VerticalOrigin  = Cesium.VerticalOrigin  as { BOTTOM: unknown };
    const Cartesian2      = Cesium.Cartesian2       as new (x: number, y: number) => unknown;
    const LabelStyle      = Cesium.LabelStyle       as { FILL_AND_OUTLINE: unknown };

    // ── Helpers ────────────────────────────────────────────────────────
    function removeAll() {
      if (!v.isDestroyed()) {
        for (const e of conflictEntitiesRef.current.values()) v.entities.remove(e);
      }
      conflictEntitiesRef.current.clear();
      conflictDataRef.current.clear();
    }

    function addEntity(ev: ConflictEvent) {
      if (conflictEntitiesRef.current.has(ev.id)) return;
      const color   = conflictColor(ev.eventType);
      const base    = conflictPixelSize(ev.fatalities);
      const show    = showConflictsRef.current;
      const cesColor = Color.fromCssColorString(color);

      // Pulsing size callback
      const sizeCb = new CallbackProperty(() => {
        const t = (performance.now() / 1000) * PULSE_SPEED;
        return base + (Math.sin(t) * 0.5 + 0.5) * PULSE_AMP;
      }, false);

      const e = v.entities.add({
        id: `conflict_${ev.id}`,
        position: Cartesian3.fromDegrees(ev.lon, ev.lat, 0),
        point: {
          pixelSize:       sizeCb,
          color:           cesColor.withAlpha(0.85),
          outlineColor:    cesColor.withAlpha(0.3),
          outlineWidth:    3,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          show,
          scaleByDistance: new NearFarScalar(1e4, 1.5, 5e6, 0.6),
          disableDepthTestDistance: 1e10,
        },
        label: ev.fatalities > 0 ? {
          text:         `${ev.fatalities}`,
          font:         "bold 10px monospace",
          fillColor:    (Cesium.Color as { WHITE: unknown }).WHITE,
          outlineColor: (Cesium.Color as { BLACK: unknown }).BLACK,
          outlineWidth: 2,
          style:          LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:    new Cartesian2(0, -(base + 8)),
          verticalOrigin: VerticalOrigin.BOTTOM,
          show,
          translucencyByDistance: new NearFarScalar(5e4, 1.0, 3e6, 0.0),
        } : undefined,
      });

      conflictEntitiesRef.current.set(ev.id, e);
      conflictDataRef.current.set(ev.id, ev);
    }

    // ── Fetch + apply ──────────────────────────────────────────────────
    const fetchAndApply = async () => {
      if (v.isDestroyed()) return;
      try {
        const res = await fetch(`/api/conflicts?days=${days}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(25_000),
        });
        const data = (await res.json()) as {
          events?: ConflictEvent[];
          error?: string;
          hint?: string;
          count?: number;
        };

        if (data.error) {
          setConflictError(data.error);
          if (data.error.startsWith("gdelt_failed")) return;
        } else {
          setConflictError(null);
        }

        const events = data.events ?? [];
        removeAll();
        for (const ev of events) {
          if (v.isDestroyed()) break;
          addEntity(ev);
        }
        setConflictCount(events.length);
        setFeedEvents?.(events);
      } catch (err) {
        console.warn("[CONFLICT] fetch failed:", err);
      }
    };

    fetchAndApply();
    timerRef.current = setInterval(fetchAndApply, REFRESH_MS);

    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      removeAll();
      setConflictCount(0);
      setConflictError(null);
      setSelectedConflict(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, days]);
}
