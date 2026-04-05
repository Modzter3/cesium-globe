export type ConflictCategory =
  | "Battles"
  | "Explosions/Remote violence"
  | "Violence against civilians"
  | "Protests"
  | "Riots"
  | "Strategic developments"
  | string;

export const CONFLICT_COLORS: Record<string, string> = {
  "Battles":                      "#ff3333",
  "Explosions/Remote violence":   "#ff7700",
  "Violence against civilians":   "#cc0044",
  "Protests":                     "#ffdd00",
  "Riots":                        "#ff9900",
  "Strategic developments":       "#aa55ff",
};

const DEFAULT_CONFLICT_COLOR = "#ffffff";

export function conflictColor(eventType: string): string {
  return CONFLICT_COLORS[eventType] ?? DEFAULT_CONFLICT_COLOR;
}

/** Point radius in pixels; scales with fatality count. */
export function conflictPixelSize(fatalities: number): number {
  if (fatalities === 0) return 5;
  if (fatalities < 5)   return 7;
  if (fatalities < 20)  return 9;
  if (fatalities < 100) return 12;
  return 16;
}

/** Short readable label for each ACLED event type. */
export const CONFLICT_TYPE_LABELS: Record<string, string> = {
  "Battles":                      "BATTLE",
  "Explosions/Remote violence":   "EXPLOSION",
  "Violence against civilians":   "ATROCITY",
  "Protests":                     "PROTEST",
  "Riots":                        "RIOT",
  "Strategic developments":       "INTEL",
};

export function conflictTypeLabel(eventType: string): string {
  return CONFLICT_TYPE_LABELS[eventType] ?? eventType.toUpperCase();
}
