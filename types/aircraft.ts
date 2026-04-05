export interface AircraftData {
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
  verticalRate: number;
  squawk: string;
  lat: number;
  lon: number;
  emergency: string;
}
