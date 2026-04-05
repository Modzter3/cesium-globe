/** Normalized FlightAware AeroAPI flight for the aircraft sidebar. */

export interface FlightAwareAirport {
  code: string;
  name: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
}

export interface FlightAwareFlightDetail {
  faFlightId: string | null;
  ident: string | null;
  identIcao: string | null;
  identIata: string | null;
  registration: string | null;
  aircraftType: string | null;
  operator: string | null;
  flightNumber: string | null;
  origin: FlightAwareAirport | null;
  destination: FlightAwareAirport | null;
  status: string | null;
  progressPercent: number | null;
  route: string | null;
  filedAltitude: number | null;
  filedAirspeed: number | null;
  routeDistance: number | null;
  scheduledOut: string | null;
  estimatedOut: string | null;
  actualOut: string | null;
  scheduledOff: string | null;
  estimatedOff: string | null;
  actualOff: string | null;
  scheduledOn: string | null;
  estimatedOn: string | null;
  actualOn: string | null;
  scheduledIn: string | null;
  estimatedIn: string | null;
  actualIn: string | null;
  gateOrigin: string | null;
  gateDestination: string | null;
  terminalOrigin: string | null;
  terminalDestination: string | null;
  baggageClaim: string | null;
  departureDelaySec: number | null;
  arrivalDelaySec: number | null;
  diverted: boolean;
  cancelled: boolean;
  positionOnly: boolean;
  blocked: boolean;
}

export interface FlightAwareFlightResponse {
  flight: FlightAwareFlightDetail | null;
  /** How we queried FlightAware (for debugging). */
  matchedBy: "callsign" | "registration" | null;
  error: string | null;
}
