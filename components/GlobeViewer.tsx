"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type ImageryMode = "satellite" | "osm" | "dark";

interface CoordState {
  lat: string;
  lon: string;
  alt: string;
}

const CESIUM_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWEzYTYzMi1iYTMyLTQ5MjctYmEwMy05NGY1ZmQ5NGY0NzQiLCJpZCI6NDEzNTkzLCJpYXQiOjE3NzUyODI2Mjl9._sdtsqjhWpRKOwWKY7gMjh4fohPNRpz_WtaoTdgOHC4";

const CESIUM_VERSION = "1.127";
const CESIUM_CDN = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium`;

// ── Inline SVG icons ───────────────────────────────────────────
const SatelliteIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 7 9 3 5 7l4 4" />
    <path d="m17 11 4 4-4 4-4-4" />
    <path d="m8 12 4 4 6-6-4-4Z" />
    <path d="m16 8 3-3" />
    <path d="M9 21a6 6 0 0 0-6-6" />
  </svg>
);

const MapIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const HomeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

// Load a script tag and resolve when done
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// Load a stylesheet
function loadCSS(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

// ── Component ──────────────────────────────────────────────────
export default function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlerRef = useRef<any>(null);

  const [mode, setMode] = useState<ImageryMode>("satellite");
  const [coords, setCoords] = useState<CoordState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Init ─────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;

    const init = async () => {
      try {
        // Load Cesium CSS + JS from CDN
        loadCSS(`${CESIUM_CDN}/Widgets/widgets.css`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).CESIUM_BASE_URL = `${CESIUM_CDN}/`;
        await loadScript(`${CESIUM_CDN}/Cesium.js`);

        if (!active || !containerRef.current) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Cesium = (window as any).Cesium;
        Cesium.Ion.defaultAccessToken = CESIUM_TOKEN;

        const baseLayer = Cesium.ImageryLayer.fromProviderAsync(
          Cesium.IonImageryProvider.fromAssetId(2)
        );

        const viewer = new Cesium.Viewer(containerRef.current, {
          terrain: Cesium.Terrain.fromWorldTerrain(),
          baseLayer,
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          sceneModePicker: false,
          selectionIndicator: false,
          timeline: false,
          navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
        });

        viewer.scene.globe.enableLighting = true;
        viewer.scene.fog.enabled = true;
        if (viewer.scene.skyAtmosphere) {
          viewer.scene.skyAtmosphere.show = true;
        }

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(-98.5, 39.5, 8_000_000),
          duration: 0,
        });

        viewerRef.current = viewer;
        if (active) setReady(true);

        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        handlerRef.current = handler;

        handler.setInputAction(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e: any) => {
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
          },
          Cesium.ScreenSpaceEventType.MOUSE_MOVE
        );
      } catch (err) {
        console.error(err);
        if (active) setError("Failed to load CesiumJS. Check your connection.");
      }
    };

    init();

    return () => {
      active = false;
      handlerRef.current?.destroy();
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy();
      }
    };
  }, []);

  // ── Imagery switcher ─────────────────────────────────────────
  const switchImagery = useCallback(
    async (newMode: ImageryMode) => {
      if (!viewerRef.current || newMode === mode) return;
      setMode(newMode);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Cesium = (window as any).Cesium;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const layers = viewerRef.current.scene.imageryLayers as any;
      layers.removeAll();

      if (newMode === "satellite") {
        layers.add(
          Cesium.ImageryLayer.fromProviderAsync(
            Cesium.IonImageryProvider.fromAssetId(2)
          )
        );
      } else if (newMode === "osm") {
        layers.add(
          new Cesium.ImageryLayer(
            new Cesium.OpenStreetMapImageryProvider({
              url: "https://tile.openstreetmap.org/",
            })
          )
        );
      } else {
        layers.add(
          Cesium.ImageryLayer.fromProviderAsync(
            Cesium.IonImageryProvider.fromAssetId(3812)
          )
        );
      }
    },
    [mode]
  );

  // ── Fly home ─────────────────────────────────────────────────
  const flyHome = useCallback(() => {
    if (!viewerRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Cesium = (window as any).Cesium;
    viewerRef.current.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(-98.5, 39.5, 8_000_000),
      duration: 1.5,
    });
  }, []);

  // ── Render ───────────────────────────────────────────────────
  return (
    <>
      <div id="cesiumContainer" ref={containerRef} />

      <header className="hud">
        <div className="hud-logo">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none"
            aria-label="Globe logo" xmlns="http://www.w3.org/2000/svg">
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
        <div style={{
          position: "fixed", inset: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          color: "#f87171", fontSize: "1rem", background: "#0b0e14"
        }}>
          {error}
        </div>
      )}

      {ready && (
        <nav className="controls" aria-label="Map controls">
          <button
            className={`ctrl-btn${mode === "satellite" ? " active" : ""}`}
            onClick={() => switchImagery("satellite")}
            aria-pressed={mode === "satellite"}
          >
            <SatelliteIcon />
            Satellite
          </button>
          <div className="ctrl-divider" role="separator" />
          <button
            className={`ctrl-btn${mode === "osm" ? " active" : ""}`}
            onClick={() => switchImagery("osm")}
            aria-pressed={mode === "osm"}
          >
            <MapIcon />
            Streets
          </button>
          <div className="ctrl-divider" role="separator" />
          <button
            className={`ctrl-btn${mode === "dark" ? " active" : ""}`}
            onClick={() => switchImagery("dark")}
            aria-pressed={mode === "dark"}
          >
            <MoonIcon />
            Night
          </button>
          <div className="ctrl-divider" role="separator" />
          <button className="ctrl-btn" onClick={flyHome} aria-label="Fly home">
            <HomeIcon />
            Reset
          </button>
        </nav>
      )}

      {coords && (
        <div className="coords" aria-live="polite" aria-atomic="true">
          {coords.lat}° N &nbsp; {coords.lon}° E
          <br />
          {coords.alt} km altitude
        </div>
      )}
    </>
  );
}
