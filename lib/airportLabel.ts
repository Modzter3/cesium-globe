import type { FlightAwareAirport } from "@/types/flightAware";

/** One-line label for sidebar (city · name · ICAO). */
export function airportLabel(ap: FlightAwareAirport | null): string {
  if (!ap) return "—";
  const bits = [ap.city, ap.name, ap.code].filter(Boolean);
  return bits.length ? bits.join(" · ") : ap.code;
}
