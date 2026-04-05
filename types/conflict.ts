/** Raw event record returned by the ACLED read API. */
export interface AcledRawEvent {
  event_id_cnty: string;
  event_date: string;
  event_type: string;
  sub_event_type: string;
  actor1: string;
  actor2: string;
  country: string;
  admin1?: string;
  admin2?: string;
  location?: string;
  latitude: string | number;
  longitude: string | number;
  fatalities: string | number;
  notes?: string;
  source?: string;
}

/** Cleaned conflict event used by the hook and sidebar. */
export interface ConflictEvent {
  id: string;
  date: string;
  eventType: string;
  subEventType: string;
  actor1: string;
  actor2: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  fatalities: number;
  notes: string;
  source: string;
}
