/** Shared styling for aircraft billboards and HUD (altitude bands in meters). */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cesium is loaded from CDN at runtime
export function altColor(Cesium: any, altM: number): any {
  if (altM < 3000) return Cesium.Color.YELLOW;
  if (altM < 9000) return Cesium.Color.CYAN;
  return Cesium.Color.fromCssColorString("#cc88ff");
}

export function altColorCss(altM: number): string {
  if (altM < 3000) return "#ffff00";
  if (altM < 9000) return "#00ffff";
  return "#cc88ff";
}

/**
 * Top-down aircraft silhouette, nose at top (heading 0 = north).
 * Rendered on a 48×48 canvas; displayed at 36×36 px in Cesium.
 * A 1.5 px drop-shadow layer is drawn first so the icon pops against
 * any background colour.
 */
export function airplaneSvgUri(color: string, headingDeg: number): string {
  const shadow  = "rgba(0,0,0,0.55)";
  const outline = "rgba(0,0,0,0.9)";
  // shadow offset
  const so = 1.5;
  const cx = 24, cy = 24;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <g transform="rotate(${headingDeg},${cx},${cy})">
    <!-- drop shadow -->
    <ellipse cx="${cx+so}" cy="${cy+so}" rx="3" ry="14" fill="${shadow}"/>
    <path d="M${21+so},${19+so} L${4+so},${27+so} L${4+so},${30+so} L${21+so},${25+so} Z" fill="${shadow}"/>
    <path d="M${27+so},${19+so} L${44+so},${27+so} L${44+so},${30+so} L${27+so},${25+so} Z" fill="${shadow}"/>
    <path d="M${21+so},${36+so} L${13+so},${41+so} L${13+so},${42+so} L${21+so},${38.5+so} Z" fill="${shadow}"/>
    <path d="M${27+so},${36+so} L${35+so},${41+so} L${35+so},${42+so} L${27+so},${38.5+so} Z" fill="${shadow}"/>
    <!-- left wing (swept) -->
    <path d="M21,19 L4,27 L4,30 L21,25 Z"
          fill="${color}" stroke="${outline}" stroke-width="0.8" stroke-linejoin="round"/>
    <!-- right wing -->
    <path d="M27,19 L44,27 L44,30 L27,25 Z"
          fill="${color}" stroke="${outline}" stroke-width="0.8" stroke-linejoin="round"/>
    <!-- fuselage -->
    <ellipse cx="${cx}" cy="${cy}" rx="3" ry="14"
             fill="${color}" stroke="${outline}" stroke-width="1.3"/>
    <!-- left H-stab -->
    <path d="M21,36 L13,41 L13,42 L21,38.5 Z"
          fill="${color}" stroke="${outline}" stroke-width="0.6" stroke-linejoin="round"/>
    <!-- right H-stab -->
    <path d="M27,36 L35,41 L35,42 L27,38.5 Z"
          fill="${color}" stroke="${outline}" stroke-width="0.6" stroke-linejoin="round"/>
    <!-- nose highlight -->
    <ellipse cx="${cx}" cy="11.5" rx="1.8" ry="2.2" fill="rgba(255,255,255,0.75)"/>
  </g>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
