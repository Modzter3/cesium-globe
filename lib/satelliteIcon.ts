/**
 * Returns a base64-encoded SVG data URI for a satellite billboard.
 * The icon is a small satellite body with two solar panels and a dish.
 */
export function satelliteSvgUri(color = "#00ddff"): string {
  const body = color;
  const panel = "#2255cc";
  const panelBorder = color;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="-14 -14 28 28">
  <rect x="-4" y="-4" width="8" height="8" fill="${body}" stroke="#001133" stroke-width="0.8" rx="0.5"/>
  <rect x="-13" y="-2" width="8" height="4" fill="${panel}" stroke="${panelBorder}" stroke-width="0.5"/>
  <rect x="5" y="-2" width="8" height="4" fill="${panel}" stroke="${panelBorder}" stroke-width="0.5"/>
  <line x1="-5" y1="-4" x2="-13" y2="-4" stroke="${panelBorder}" stroke-width="0.4"/>
  <line x1="5" y1="-4" x2="13" y2="-4" stroke="${panelBorder}" stroke-width="0.4"/>
  <line x1="0" y1="-4" x2="0" y2="-9" stroke="${body}" stroke-width="0.6"/>
  <ellipse cx="0" cy="-11" rx="3" ry="2" fill="none" stroke="${body}" stroke-width="0.7"/>
  <line x1="0" y1="-11" x2="0" y2="-9" stroke="${body}" stroke-width="0.5"/>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Returns a color for the satellite billboard based on orbital inclination (degrees). */
export function satColorFromInclination(incDeg: number): string {
  if (incDeg > 85) return "#ff6644";  // polar / sun-sync → orange-red
  if (incDeg > 60) return "#88ffcc";  // high-inclination (ISS ~51.6° handled above 50)
  if (incDeg > 45) return "#00ff88";  // mid-inclination (ISS)
  if (incDeg < 5)  return "#ffdd00";  // GEO / equatorial → yellow
  return "#00ddff";                   // general LEO → cyan
}
