/** Orbital data returned by /api/satellites (OMM JSON format from CelesTrak). */
export interface SatelliteOMM {
  OBJECT_NAME: string;
  NORAD_CAT_ID: string | number;
  EPOCH: string;
  MEAN_MOTION: number | string;
  ECCENTRICITY: number | string;
  INCLINATION: number | string;
  RA_OF_ASC_NODE: number | string;
  ARG_OF_PERICENTER: number | string;
  MEAN_ANOMALY: number | string;
  BSTAR: number | string;
  MEAN_MOTION_DOT: number | string;
  MEAN_MOTION_DDOT: number | string;
  ELEMENT_SET_NO: number | string;
  [key: string]: unknown;
}

/** Rich satellite record stored in the hook's data ref, exposed for click-selection. */
export interface SatelliteInfo {
  noradId: string;
  name: string;
  /** Orbital inclination in degrees. */
  inclination: number;
  /** Orbital period in minutes (1440 / mean_motion_rev_per_day). */
  periodMin: number;
  /** Current altitude in km (computed at time of selection). */
  altKm: number;
  /** Current velocity magnitude in km/s (computed at time of selection). */
  velKms: number;
  /** TLE epoch string. */
  epoch: string;
}
