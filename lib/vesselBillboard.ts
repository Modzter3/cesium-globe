// Ship type category label (AIS-style type codes)
export function shipTypeLabel(type: number): string {
  if (type >= 60 && type <= 69) return "PASSENGER";
  if (type >= 70 && type <= 79) return "CARGO";
  if (type >= 80 && type <= 89) return "TANKER";
  if (type === 30) return "FISHING";
  if (type === 36 || type === 37) return "SAILING";
  if (type >= 50 && type <= 59) return "SPECIAL";
  if (type >= 20 && type <= 29) return "WIG";
  return "VESSEL";
}

export function shipColorCss(type: number): string {
  if (type >= 70 && type <= 79) return "#ffa500";
  if (type >= 80 && type <= 89) return "#ff4444";
  if (type >= 60 && type <= 69) return "#44aaff";
  if (type === 30) return "#44ff88";
  return "#ffffff";
}

/** Upward-pointing arrow (north in image space); heading via Cesium billboard.rotation + alignedAxis */
export function vesselArrowSvgUri(colorCss: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <polygon points="16,5 27,27 16,19 5,27" fill="${colorCss}" stroke="#0a0a0a" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
