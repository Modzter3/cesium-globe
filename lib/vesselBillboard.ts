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

/**
 * Ship hull silhouette — bow at top, stern at bottom (north in image space).
 * Cesium rotates the billboard by heading via billboard.rotation + alignedAxis.
 * Rendered on a 48×48 canvas; displayed at 28×36 px in Cesium.
 */
export function vesselArrowSvgUri(colorCss: string): string {
  const outline = "rgba(0,0,0,0.9)";
  const shadow  = "rgba(0,0,0,0.5)";
  const so = 1.5; // shadow offset

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <!-- drop shadow -->
  <path d="M${24+so},${5+so}
           C${29+so},${11+so} ${32+so},${19+so} ${32+so},${30+so}
           L${32+so},${43+so} L${24+so},${39+so} L${16+so},${43+so}
           L${16+so},${30+so}
           C${16+so},${19+so} ${19+so},${11+so} ${24+so},${5+so} Z"
        fill="${shadow}"/>
  <!-- hull -->
  <path d="M24,5
           C29,11 32,19 32,30
           L32,43 L24,39 L16,43
           L16,30
           C16,19 19,11 24,5 Z"
        fill="${colorCss}" stroke="${outline}" stroke-width="1.3" stroke-linejoin="round"/>
  <!-- superstructure / bridge block -->
  <rect x="19.5" y="25" width="9" height="8" rx="1.2"
        fill="rgba(0,0,0,0.28)" stroke="${outline}" stroke-width="0.7"/>
  <!-- bow highlight (fresnel sheen) -->
  <path d="M24,6 C25.5,10 26.5,15 26,20 L22,20 C21.5,15 22.5,10 24,6 Z"
        fill="rgba(255,255,255,0.32)"/>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
