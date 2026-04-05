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

export function airplaneSvgUri(color: string, headingDeg: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="rotate(${headingDeg}, 16, 16)">
      <polygon points="16,2 20,24 16,20 12,24" fill="${color}" stroke="#000" stroke-width="1.2"/>
      <polygon points="4,18 16,14 28,18 16,16" fill="${color}" stroke="#000" stroke-width="0.8"/>
      <polygon points="10,26 16,23 22,26 16,25" fill="${color}" stroke="#000" stroke-width="0.6"/>
    </g>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
