import { z } from "zod";
import { SEVERITIES, type Alert, type Forecast, type Severity } from "./types.ts";

/**
 * Validation for the parts of the NWS GeoJSON we rely on. Schemas are deliberately lenient
 * (unknown keys pass through, most fields are nullable) — a public API that adds a field
 * shouldn't take the service down, but a payload missing an id or event should be rejected.
 */

const nullableString = z.string().nullish().transform((v) => v ?? null);

const geometrySchema = z
  .object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: z.unknown() })
  .nullish()
  .catch(null); // Unknown geometry types (e.g. Point) are dropped, not fatal.

const alertPropertiesSchema = z.object({
  id: z.string().min(1),
  event: z.string().min(1),
  messageType: z.string().default("Alert"),
  severity: z.string().nullish(),
  urgency: z.string().nullish(),
  certainty: z.string().nullish(),
  headline: nullableString,
  description: nullableString,
  instruction: nullableString,
  areaDesc: z.string().default(""),
  senderName: z.string().default("National Weather Service"),
  sent: z.string(),
  effective: nullableString,
  onset: nullableString,
  expires: nullableString,
  ends: nullableString,
  geocode: z.object({ UGC: z.array(z.string()).default([]) }).partial().nullish(),
  references: z.array(z.object({ identifier: z.string().optional() })).default([]),
});

export const alertCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  updated: z.string().optional(),
  features: z.array(
    z.object({
      geometry: geometrySchema,
      properties: z.unknown(),
    }),
  ),
});

/** U.S. states, DC and territories that appear as UGC zone prefixes. */
const AREA_CODES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY " +
    "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP"
  ).split(" "),
);

/** Marine zone prefixes: coastal waters, the Great Lakes and offshore areas. */
const MARINE_PREFIXES = new Set("AM AN GM LC LE LH LM LO LS PH PK PM PS PZ SL".split(" "));

export function areasFromUgc(ugc: readonly string[]): { areas: string[]; zoneType: "land" | "marine" } {
  const areas = new Set<string>();
  let marine = false;
  for (const code of ugc) {
    const prefix = code.slice(0, 2).toUpperCase();
    if (MARINE_PREFIXES.has(prefix)) marine = true;
    else if (AREA_CODES.has(prefix)) areas.add(prefix);
  }
  return { areas: [...areas].sort(), zoneType: areas.size === 0 && marine ? "marine" : "land" };
}

function toSeverity(value: string | null | undefined): Severity {
  return (SEVERITIES as readonly string[]).includes(value ?? "") ? (value as Severity) : "Unknown";
}

export interface ParseResult {
  alerts: Alert[];
  /** Features that failed validation; logged by the caller instead of failing the whole poll. */
  rejected: number;
  updated: string | null;
}

export function parseAlertCollection(json: unknown): ParseResult {
  const collection = alertCollectionSchema.parse(json);
  const alerts: Alert[] = [];
  let rejected = 0;

  for (const feature of collection.features) {
    const parsed = alertPropertiesSchema.safeParse(feature.properties);
    if (!parsed.success) {
      rejected++;
      continue;
    }
    const p = parsed.data;
    const { areas, zoneType } = areasFromUgc(p.geocode?.UGC ?? []);
    alerts.push({
      id: p.id,
      event: p.event,
      messageType: p.messageType,
      severity: toSeverity(p.severity),
      urgency: p.urgency ?? "Unknown",
      certainty: p.certainty ?? "Unknown",
      headline: p.headline,
      description: p.description ?? "",
      instruction: p.instruction,
      areaDesc: p.areaDesc,
      areas,
      zoneType,
      senderName: p.senderName,
      sent: p.sent,
      effective: p.effective,
      onset: p.onset,
      expires: p.expires,
      ends: p.ends,
      references: p.references.flatMap((r) => (r.identifier ? [r.identifier] : [])),
      geometry: feature.geometry ?? null,
    });
  }

  return { alerts, rejected, updated: collection.updated ?? null };
}

export const pointSchema = z.object({
  properties: z.object({
    forecast: z.string().nullable(),
    gridId: nullableString,
    relativeLocation: z
      .object({ properties: z.object({ city: nullableString, state: nullableString }) })
      .nullish(),
  }),
});

export const forecastSchema = z.object({
  properties: z.object({
    updateTime: nullableString,
    periods: z.array(
      z.object({
        name: z.string(),
        startTime: z.string(),
        isDaytime: z.boolean(),
        temperature: z.number().nullable(),
        temperatureUnit: z.string().default("F"),
        windSpeed: nullableString,
        windDirection: nullableString,
        probabilityOfPrecipitation: z.object({ value: z.number().nullable() }).nullish(),
        shortForecast: z.string(),
        icon: nullableString,
      }),
    ),
  }),
});

export function toForecast(
  point: z.infer<typeof pointSchema>,
  forecast: z.infer<typeof forecastSchema>,
  lat: number,
  lon: number,
): Forecast {
  const rel = point.properties.relativeLocation?.properties;
  return {
    location: { city: rel?.city ?? null, state: rel?.state ?? null, lat, lon },
    office: point.properties.gridId,
    updated: forecast.properties.updateTime,
    periods: forecast.properties.periods.map((p) => ({
      name: p.name,
      startTime: p.startTime,
      isDaytime: p.isDaytime,
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      windSpeed: p.windSpeed,
      windDirection: p.windDirection,
      precipitationChance: p.probabilityOfPrecipitation?.value ?? null,
      shortForecast: p.shortForecast,
      icon: p.icon,
    })),
  };
}
