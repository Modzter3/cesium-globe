"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type ImageryMode = "satellite" | "osm" | "dark";

interface CoordState {
  lat: string;
  lon: string;
  alt: string;
}

interface FlightInfo {
  icao: string;
  callsign: string;
  country: string;
  altitude: number;
  velocity: number;
  heading: number;
}

const CESIUM_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWEzYTYzMi1iYTMyLTQ5MjctYmEwMy05NGY1ZmQ5NGY0NzQiLCJpZCI6NDEzNTkzLCJpYXQiOjE3NzUyODI2Mjl9._sdtsqjhWpRKOwWKY7gMjh4fohPNRpz_WtaoTdgOHC4";

const CESIUM_VERSION = "1.127";
const CESIUM_CDN = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium`;

const POLL_INTERVAL_MS = 10_000;

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
const PlaneIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 2c-2-2-4-2-5.5-.5L10 5 1.8 6.2c-.5.1-.7.6-.4 1L4 10l2 2-2 2-2.5.4c-.4.1-.6.6-.3.9L4 18l2 2 .4-2.5L9 15l2 2 3 2c.4.3.9.1 1-.4z" />
  </svg>
);

// ── Helpers ───────────────────────────────────────────────────
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
function loadCSS(href: string): void {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href;
  document.head.appendChild(l);
}

// Color airplane by altitude: low=yellow, mid=cyan, high=magenta
function altColor(Cesium: any, altM: number): any {
  if (altM < 3000) return Cesium.Color.YELLOW;
  if (altM < 9000) return Cesium.Color.CYAN;
  return Cesium.Color.fromCssColorString("#cc88ff");
}

// Build a tiny airplane SVG as a data-URI canvas for Cesium billboard
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

// ── Component ──────────────────────────────────────────────────
export default function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const handlerRef = useRef<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Map icao24 → Cesium Entity
  const entitiesRef = useRef<Map<string, any>>(new Map());

  const [mode, setMode] = useState<ImageryMode>("satellite");
  const [coords, setCoords] = useState<CoordState | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flightCount, setFlightCount] = useState(0);
  const [selectedFlight, setSelectedFlight] = useState<FlightInfo | null>(null);
  const [showFlights, setShowFlights] = useState(true);
  const showFlightsRef = useRef(true);

  // ── Fetch + update airplane entities ─────────────────────────
  const updateFlights = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    const Cesium = (window as any).Cesium;

    try {
      const res = await fetch("/api/flights");
      if (!res.ok) return;
      const data = await res.json();
      // adsb.fi / readsb format: { ac: [ { hex, flight, lat, lon, alt_baro, gs, track, ... } ] }
      const aircraft: any[] = data.ac ?? data.states ?? [];

      const seen = new Set<string>();

      for (const ac of aircraft) {
        // Support both adsb.fi (object) and OpenSky (array) formats
        const isArray = Array.isArray(ac);
        const icao: string = isArray ? ac[0] : (ac.hex ?? "");
        const callsign: string = isArray
          ? ((ac[1] ?? "").trim() || icao)
          : ((ac.flight ?? "").trim() || icao);
        const lon: number | null = isArray ? ac[5] : ac.lon;
        const lat: number | null = isArray ? ac[6] : ac.lat;
        // alt_baro can be "ground" string in adsb.fi
        const rawAlt = isArray ? ac[7] : ac.alt_baro;
        const onGround: boolean = isArray ? ac[8] : (rawAlt === "ground" || ac.on_ground === true);
        const altFt: number = (typeof rawAlt === "number") ? rawAlt : 3000;
        const altM = altFt * 0.3048; // feet → meters
        const velocity: number = isArray ? (ac[9] ?? 0) : (ac.gs ?? 0); // knots in adsb.fi
        const heading: number = isArray ? (ac[10] ?? 0) : (ac.track ?? 0);
        const country: string = isArray ? (ac[2] ?? "") : "";

        if (lon == null || lat == null || onGround) continue;

        const color = altColor(Cesium, altM);
        const colorCss = altM < 3000 ? "#ffff00" : altM < 9000 ? "#00ffff" : "#cc88ff";

        seen.add(icao);

        const position = Cesium.Cartesian3.fromDegrees(lon, lat, altM);

        if (entitiesRef.current.has(icao)) {
          // Update existing entity
          const entity = entitiesRef.current.get(icao)!;
          entity.position = position;
          entity.billboard.image = airplaneSvgUri(colorCss, heading);
          entity.billboard.show = showFlightsRef.current;
          entity.label.show = showFlightsRef.current;
          entity.properties.altitude._value = altM;
          entity.properties.velocity._value = velocity;
          entity.properties.heading._value = heading;
        } else {
          // Create new entity
          const entity = viewer.entities.add({
            id: icao,
            position,
            billboard: {
              image: airplaneSvgUri(colorCss, heading),
              width: 28,
              height: 28,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              show: showFlightsRef.current,
              sizeInMeters: false,
            },
            label: {
              text: callsign,
              font: "11px monospace",
              fillColor: color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -20),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              show: showFlightsRef.current,
              translucencyByDistance: new Cesium.NearFarScalar(1e5, 1.0, 2e6, 0.0),
            },
            properties: {
              icao,
              callsign,
              country,
              altitude: altM,
              velocity,
              heading,
            },
          });
          entitiesRef.current.set(icao, entity);
        }
      }

      // Remove stale entities
      for (const [icao, entity] of entitiesRef.current) {
        if (!seen.has(icao)) {
          viewer.entities.remove(entity);
          entitiesRef.current.delete(icao);
        }
      }

      setFlightCount(seen.size);
    } catch (e) {
      console.warn("[flights] update error", e);
    }
  }, []);

  // ── Init ─────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;

    const init = async () => {
      try {
        loadCSS(`${CESIUM_CDN}/Widgets/widgets.css`);
        (window as any).CESIUM_BASE_URL = `${CESIUM_CDN}/`;
        await loadScript(`${CESIUM_CDN}/Cesium.js`);
        if (!active || !containerRef.current) return;

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
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;

        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(-98.5, 39.5, 8_000_000),
          duration: 0,
        });

        viewerRef.current = viewer;
        if (active) setReady(true);

        // Coordinate readout on mouse move
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

        // Click on airplane to show info
        handler.setInputAction((e: any) => {
          const picked = viewer.scene.pick(e.position);
          if (Cesium.defined(picked) && picked.id) {
            const entity = picked.id;
            const p = entity.properties;
            if (p && p.icao) {
              setSelectedFlight({
                icao: p.icao._value ?? p.icao,
                callsign: p.callsign._value ?? p.callsign,
                country: p.country._value ?? p.country,
                altitude: Math.round((p.altitude._value ?? 0)),
                velocity: Math.round((p.velocity._value ?? 0) * 1.94384), // m/s → knots
                heading: Math.round(p.heading._value ?? 0),
              });
            } else {
              setSelectedFlight(null);
            }
          } else {
            setSelectedFlight(null);
          }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Initial fetch + start polling
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
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy();
      }
    };
  }, [updateFlights]);

  // ── Toggle flights visibility ──────────────────────────────
  const toggleFlights = useCallback(() => {
    const next = !showFlightsRef.current;
    showFlightsRef.current = next;
    setShowFlights(next);
    for (const entity of entitiesRef.current.values()) {
      entity.billboard.show = next;
      entity.label.show = next;
    }
  }, []);

  // ── Imagery switcher ─────────────────────────────────────────
  const switchImagery = useCallback(async (newMode: ImageryMode) => {
    if (!viewerRef.current || newMode === mode) return;
    setMode(newMode);
    const Cesium = (window as any).Cesium;
    const layers = viewerRef.current.scene.imageryLayers as any;
    layers.removeAll();
    if (newMode === "satellite") {
      layers.add(Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2)));
    } else if (newMode === "osm") {
      layers.add(new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })));
    } else {
      layers.add(Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(3812)));
    }
  }, [mode]);

  // ── Fly home ─────────────────────────────────────────────────
  const flyHome = useCallback(() => {
    if (!viewerRef.current) return;
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
          color: "#f87171", fontSize: "1rem", background: "#0b0e14",
        }}>
          {error}
        </div>
      )}

      {ready && (
        <nav className="controls" aria-label="Map controls">
          <button className={`ctrl-btn${mode === "satellite" ? " active" : ""}`}
            onClick={() => switchImagery("satellite")} aria-pressed={mode === "satellite"}>
            <SatelliteIcon />Satellite
          </button>
          <div className="ctrl-divider" role="separator" />
          <button className={`ctrl-btn${mode === "osm" ? " active" : ""}`}
            onClick={() => switchImagery("osm")} aria-pressed={mode === "osm"}>
            <MapIcon />Streets
          </button>
          <div className="ctrl-divider" role="separator" />
          <button className={`ctrl-btn${mode === "dark" ? " active" : ""}`}
            onClick={() => switchImagery("dark")} aria-pressed={mode === "dark"}>
            <MoonIcon />Night
          </button>
          <div className="ctrl-divider" role="separator" />
          <button className="ctrl-btn" onClick={flyHome} aria-label="Fly home">
            <HomeIcon />Reset
          </button>
          <div className="ctrl-divider" role="separator" />
          <button className={`ctrl-btn${!showFlights ? " active" : ""}`}
            onClick={toggleFlights} aria-pressed={!showFlights}>
            <PlaneIcon />{showFlights ? "Hide" : "Show"} Planes
          </button>
        </nav>
      )}

      {ready && flightCount > 0 && (
        <div className="flight-counter">
          ✈ {flightCount} aircraft live
        </div>
      )}

      {selectedFlight && (
        <div className="flight-card">
          <div className="flight-card-close" onClick={() => setSelectedFlight(null)}>✕</div>
          <div className="flight-card-callsign">{selectedFlight.callsign}</div>
          <div className="flight-card-row"><span>ICAO</span><span>{selectedFlight.icao}</span></div>
          <div className="flight-card-row"><span>Country</span><span>{selectedFlight.country}</span></div>
          <div className="flight-card-row"><span>Altitude</span><span>{selectedFlight.altitude.toLocaleString()} m</span></div>
          <div className="flight-card-row"><span>Speed</span><span>{selectedFlight.velocity} kts</span></div>
          <div className="flight-card-row"><span>Heading</span><span>{selectedFlight.heading}°</span></div>
        </div>
      )}

      {coords && (
        <div className="coords" aria-live="polite" aria-atomic="true">
          {coords.lat}° N &nbsp; {coords.lon}° E<br />
          {coords.alt} km altitude
        </div>
      )}
    </>
  );
}
