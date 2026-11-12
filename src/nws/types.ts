/** Normalized domain types. The raw NWS payload is validated and mapped in `schema.ts`. */

export const SEVERITIES = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  Extreme: 4,
  Severe: 3,
  Moderate: 2,
  Minor: 1,
  Unknown: 0,
};

export type ZoneType = "land" | "marine";

export interface Geometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
}

export interface Alert {
  id: string;
  event: string;
  messageType: string;
  severity: Severity;
  urgency: string;
  certainty: string;
  headline: string | null;
  description: string;
  instruction: string | null;
  areaDesc: string;
  /** Two-letter state / territory codes derived from the alert's UGC zones. */
  areas: string[];
  zoneType: ZoneType;
  senderName: string;
  sent: string;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  ends: string | null;
  /** Ids of earlier alerts this message updates or replaces. */
  references: string[];
  geometry: Geometry | null;
}

export interface ForecastPeriod {
  name: string;
  startTime: string;
  isDaytime: boolean;
  temperature: number | null;
  temperatureUnit: string;
  windSpeed: string | null;
  windDirection: string | null;
  precipitationChance: number | null;
  shortForecast: string;
  icon: string | null;
}

export interface Forecast {
  location: { city: string | null; state: string | null; lat: number; lon: number };
  office: string | null;
  updated: string | null;
  periods: ForecastPeriod[];
}
