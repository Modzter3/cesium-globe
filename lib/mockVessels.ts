import type { VesselData } from "@/types/vessel";

/** Simulated ship for the mock tracking layer */
export interface MockVessel {
  id: string;
  latitude: number;
  longitude: number;
  /** Speed over ground, knots */
  speed: number;
  /** True heading, degrees (0 = north, 90 = east) */
  heading: number;
}

const MOCK_SHIP_TYPES = [30, 60, 70, 80, 71] as const;

const SEED: MockVessel[] = [
  { id: "MV-ARCTIC", latitude: 40.7128, longitude: -74.006, speed: 14, heading: 95 },
  { id: "SS-BALTIC", latitude: 59.3293, longitude: 18.0686, speed: 18, heading: 220 },
  { id: "MV-CORAL", latitude: 25.7617, longitude: -80.1918, speed: 11, heading: 310 },
  { id: "MV-DENALI", latitude: 47.6062, longitude: -122.3321, speed: 9, heading: 45 },
  { id: "SS-EUROPA", latitude: 51.5074, longitude: -0.1278, speed: 16, heading: 270 },
  { id: "MV-FJORD", latitude: 60.3913, longitude: 5.3221, speed: 20, heading: 180 },
  { id: "MV-GULF", latitude: 29.7604, longitude: -95.3698, speed: 12, heading: 125 },
  { id: "SS-HARBOR", latitude: 33.749, longitude: -118.2637, speed: 8, heading: 350 },
  { id: "MV-INDUS", latitude: -33.8688, longitude: 151.2093, speed: 15, heading: 40 },
  { id: "MV-JADE", latitude: 1.3521, longitude: 103.8198, speed: 22, heading: 285 },
  { id: "SS-KESTREL", latitude: 35.6762, longitude: 139.6503, speed: 17, heading: 155 },
  { id: "MV-LUNA", latitude: -22.9068, longitude: -43.1729, speed: 13, heading: 90 },
  { id: "MV-MISTRAL", latitude: 48.8566, longitude: 2.3522, speed: 10, heading: 330 },
  { id: "SS-NORTHSTAR", latitude: 64.1466, longitude: -21.9426, speed: 19, heading: 200 },
  { id: "MV-ORION", latitude: -36.8485, longitude: 174.7633, speed: 14, heading: 60 },
];

function wrapLon(lon: number): number {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function clampLat(lat: number): number {
  return Math.max(-85, Math.min(85, lat));
}

/**
 * Advance positions by dead reckoning (knots, nautical miles, spherical correction for lon).
 */
export function advanceMockVessels(vessels: MockVessel[], dtSeconds: number): MockVessel[] {
  const dtHours = dtSeconds / 3600;
  return vessels.map((v) => {
    const distanceNm = v.speed * dtHours;
    const h = (v.heading * Math.PI) / 180;
    const latRad = (v.latitude * Math.PI) / 180;
    const dlat = (distanceNm * Math.cos(h)) / 60;
    const dlon = (distanceNm * Math.sin(h)) / (60 * Math.max(0.2, Math.cos(latRad)));
    let lat = clampLat(v.latitude + dlat);
    let lon = wrapLon(v.longitude + dlon);
    // Gentle course variation so tracks are not perfectly straight
    const turn = (Math.sin((v.id.length + lat * 100) * 0.01) * 2.5 * dtSeconds) / 30;
    let heading = (v.heading + turn + 360) % 360;
    return { ...v, latitude: lat, longitude: lon, heading };
  });
}

export function createInitialMockVessels(): MockVessel[] {
  return SEED.map((s) => ({ ...s }));
}

export function mockVesselToVesselData(v: MockVessel, index: number): VesselData {
  const shipType = MOCK_SHIP_TYPES[index % MOCK_SHIP_TYPES.length];
  return {
    mmsi: v.id,
    name: v.id.replace(/-/g, " "),
    callsign: "",
    lat: v.latitude,
    lon: v.longitude,
    sog: v.speed,
    cog: v.heading,
    heading: v.heading,
    shipType,
    destination: "SIMULATED",
    draught: 0,
    length: 0,
    width: 0,
  };
}
