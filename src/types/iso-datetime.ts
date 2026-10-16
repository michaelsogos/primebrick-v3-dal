/**
 * `ISODate` / `ISOTime` — branded strings for timezone-free calendar types.
 *
 * PostgreSQL `date` ↔ `ISODate` ("YYYY-MM-DD"), `time` ↔ `ISOTime`
 * ("HH:MM:SS[.ffffff]"). String brands — NOT `Date` objects — because a
 * calendar date has no timezone: `new Date("2025-03-15")` is midnight UTC,
 * while `node-pg` parses `date` as midnight *local*, silently shifting the
 * day on JSON serialization in positive-offset timezones.
 *
 * Wire format: the literal string, unchanged end-to-end (pg → entity → JSON
 * → FE), zero parsing required anywhere — including browsers.
 */

declare const isoDateBrand: unique symbol;
declare const isoTimeBrand: unique symbol;

export type ISODate = string & { readonly [isoDateBrand]: "ISODate" };
export type ISOTime = string & { readonly [isoTimeBrand]: "ISOTime" };

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?$/;

export function isISODate(v: unknown): v is ISODate {
  return typeof v === "string" && ISO_DATE_RE.test(v);
}
export function toISODate(v: string): ISODate {
  if (!isISODate(v)) throw new Error(`Invalid ISO date (YYYY-MM-DD): ${String(v)}`);
  return v;
}
/** Zero-cost cast for trusted sources (DB rows). */
export function trustedISODate(v: string): ISODate {
  return v as ISODate;
}
/** `Date` → `ISODate` using the date's UTC calendar day. */
export function isoDateFromUTCDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10) as ISODate;
}

export function isISOTime(v: unknown): v is ISOTime {
  return typeof v === "string" && ISO_TIME_RE.test(v);
}
export function toISOTime(v: string): ISOTime {
  if (!isISOTime(v)) throw new Error(`Invalid ISO time (HH:MM:SS[.ffffff]): ${String(v)}`);
  return v;
}
/** Zero-cost cast for trusted sources (DB rows). */
export function trustedISOTime(v: string): ISOTime {
  return v as ISOTime;
}
