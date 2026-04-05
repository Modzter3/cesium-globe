/** Display / AIS-shaped vessel record used by the globe UI and mock layer */
export interface VesselData {
  mmsi: string;
  name: string;
  callsign: string;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  heading: number;
  shipType: number;
  destination: string;
  draught: number;
  length: number;
  width: number;
}
