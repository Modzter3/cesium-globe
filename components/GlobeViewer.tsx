"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useMockVesselLayer } from "@/hooks/useMockVesselLayer";
import { shipColorCss, shipTypeLabel } from "@/lib/vesselBillboard";
import type { VesselData } from "@/types/vessel";

type ImageryMode = "satellite" | "osm" | "dark" | "viirs" | "sentinel2" | "modis";

interface CoordState {
  lat: string;
  lon: string;
  alt: string;
}

interface AircraftData {
  icao: string;
  callsign: string;
  registration: string;
  type: string;
  typeDesc: string;
  operator: string;
  altFt: number;
  altM: number;
  speedKts: number;
  heading: number;
  verticalRate: number; // ft/min
  squawk: string;
  lat: number;
  lon: number;
  emergency: string;
}

const CESIUM_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWEzYTYzMi1iYTMyLTQ5MjctYmEwMy05NGY1ZmQ5NGY0NzQiLCJpZCI6NDEzNTkzLCJpYXQiOjE3NzUyODI2Mjl9._sdtsqjhWpRKOwWKY7gMjh4fohPNRpz_WtaoTdgOHC4";

const CESIUM_VERSION = "1.127";
const CESIUM_CDN = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium`;
const POLL_INTERVAL_MS = 10_000;
const MOCK_VESSEL_TICK_MS = 2000;

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

function altColor(Cesium: any, altM: number): any {
  if (altM < 3000) return Cesium.Color.YELLOW;
  if (altM < 9000) return Cesium.Color.CYAN;
  return Cesium.Color.fromCssColorString("#cc88ff");
}

function altColorCss(altM: number): string {
  if (altM < 3000) return "#ffff00";
  if (altM < 9000) return "#00ffff";
  return "#cc88ff";
}

function airplaneSvgUri(color: string, headingDeg: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="rotate(${headingDeg}, 16, 16)">
      <polygon points="16,2 20,24 16,20 12,24" fill="${color}" stroke="#000" stroke-width="1.2"/>
      <polygon points="4,18 16,14 28,18 16,16" fill="${color}" stroke="#000" stroke-width="0.8"/>
      <polygon points="10,26 16,23 22,26 16,25" fill="${color}" stroke="#000" stroke-width="0.6"/>
    </g>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function parseAircraft(ac: any): AircraftData | null {
  const isArray = Array.isArray(ac);
  const icao: string = isArray ? ac[0] : (ac.hex ?? "");
  const callsign: string = isArray ? ((ac[1] ?? "").trim() || icao) : ((ac.flight ?? "").trim() || icao);
  const lon: number | null = isArray ? ac[5] : ac.lon;
  const lat: number | null = isArray ? ac[6] : ac.lat;
  const rawAlt = isArray ? ac[7] : ac.alt_baro;
  const onGround: boolean = isArray ? ac[8] : (rawAlt === "ground" || ac.on_ground === true);
  if (lon == null || lat == null || onGround) return null;
  const altFt: number = typeof rawAlt === "number" ? rawAlt : 3000;
  const altM = altFt * 0.3048;
  const speedKts: number = isArray ? (ac[9] ?? 0) : (ac.gs ?? 0);
  const heading: number = isArray ? (ac[10] ?? 0) : (ac.track ?? 0);
  const verticalRate: number = ac.baro_rate ?? ac.geom_rate ?? 0;
  return {
    icao,
    callsign,
    registration: ac.r ?? "",
    type: ac.t ?? "",
    typeDesc: ac.desc ?? "",
    operator: ac.ownOp ?? "",
    altFt,
    altM,
    speedKts: Math.round(speedKts),
    heading: Math.round(heading),
    verticalRate: Math.round(verticalRate),
    squawk: ac.squawk ?? "",
    lat,
    lon,
    emergency: ac.emergency && ac.emergency !== "none" ? ac.emergency : "",
  };
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const entitiesRef = useRef<Map<string, any>>(new Map());
  const aircraftDataRef = useRef<Map<string, AircraftData>>(new Map());

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

  // ── Fetch + update ────────────────────────────────────────────
  const updateFlights = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const Cesium = (window as any).Cesium;

    try {
      const res = await fetch("/api/flights");
      if (!res.ok) return;
      const data = await res.json();
      const rawList: any[] = data.ac ?? data.states ?? [];
      const seen = new Set<string>();

      for (const raw of rawList) {
        const ac = parseAircraft(raw);
        if (!ac) continue;
        seen.add(ac.icao);
        aircraftDataRef.current.set(ac.icao, ac);
        const color = altColorCss(ac.altM);
        const position = Cesium.Cartesian3.fromDegrees(ac.lon, ac.lat, ac.altM);

        if (entitiesRef.current.has(ac.icao)) {
          const entity = entitiesRef.current.get(ac.icao)!;
          entity.position = position;
          entity.billboard.image = airplaneSvgUri(color, ac.heading);
          entity.billboard.show = showFlightsRef.current;
          entity.label.show = showFlightsRef.current;
        } else {
          const entity = viewer.entities.add({
            id: ac.icao,
            position,
            billboard: {
              image: airplaneSvgUri(color, ac.heading),
              width: 28, height: 28,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              show: showFlightsRef.current,
              sizeInMeters: false,
            },
            label: {
              text: ac.callsign,
              font: "10px monospace",
              fillColor: altColor(Cesium, ac.altM),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -22),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              show: showFlightsRef.current,
              translucencyByDistance: new Cesium.NearFarScalar(1e5, 1.0, 2e6, 0.0),
            },
          });
          entitiesRef.current.set(ac.icao, entity);
        }
      }

      for (const [icao, entity] of entitiesRef.current) {
        if (!seen.has(icao)) {
          viewer.entities.remove(entity);
          entitiesRef.current.delete(icao);
          aircraftDataRef.current.delete(icao);
        }
      }

      setFlightCount(seen.size);
      const now = new Date();
      setLastUpdate(`${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}Z`);

      // Refresh selected panel if it's still in the feed
      setSelectedAc(prev => {
        if (!prev) return null;
        return aircraftDataRef.current.get(prev.icao) ?? null;
      });

    } catch (e) {
      console.warn("[flights] update error", e);
    }
  }, []);

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
            } else if (!entityId.startsWith("trail_")) {
              const ac = aircraftDataRef.current.get(entityId);
              if (ac) { setSelectedAc(ac); setSelectedVessel(null); }
            }
          } else {
            setSelectedAc(null);
            setSelectedVessel(null);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        await updateFlights();
        pollRef.current = setInterval(updateFlights, POLL_INTERVAL_MS);

      } catch (err) {
        console.error(err);
        if (active) setError("Failed to initialise globe.");
      }
    };

    init();
    return () => {
      active = false;
      if (pollRef.current) clearInterval(pollRef.current);
      handlerRef.current?.destroy();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) viewerRef.current.destroy();
    };
  }, [updateFlights]);

  const toggleFlights = useCallback(() => {
    const next = !showFlightsRef.current;
    showFlightsRef.current = next;
    setShowFlights(next);
    for (const entity of entitiesRef.current.values()) {
      entity.billboard.show = next;
      entity.label.show = next;
    }
  }, []);

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

      {/* Coords */}
      {coords && (
        <div className="coords">
          {coords.lat}° N &nbsp; {coords.lon}° E<br />{coords.alt} km alt
        </div>
      )}
    </>
  );
}
