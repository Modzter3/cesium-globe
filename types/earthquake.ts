/** Cleaned earthquake record from the USGS GeoJSON feed. */
export interface EarthquakeData {
  id: string;
  time: number;    // unix ms timestamp
  mag: number;
  magType: string; // e.g. "mww", "ml"
  place: string;   // e.g. "10km NNE of Ridgecrest, CA"
  lat: number;
  lon: number;
  depth: number;   // km below surface
  url: string;     // full USGS event page URL
  tsunami: number; // 1 = potentially tsunamigenic
}
