// time.ts — normalizing time input
//
// Time zones: there is no time zone parameter, and `location` is not one.
// Latitude/longitude place the sun in the sky; they say nothing about which
// clock the input is on. A `Date` is an absolute instant, so the solar
// position derived from it is correct wherever the code runs. Everything else
// is read against the host's local time zone:
//
//   - an ISO string with no offset ("2026-07-26T14:30") is parsed as the
//     host's local time, not the observation site's
//   - time-of-day is taken with getHours(), i.e. the host's clock
//
// So to render 14:30 *in Tokyo* from a machine in London, state the offset:
// "2026-07-26T14:30+09:00", or pass a Date built from an unambiguous instant.

/**
 * A time specification.
 * - `number` … a time of day, 0..24 (14.5 = 14:30)
 * - `Date`   … a specific moment. Pass latitude/longitude alongside it to get the real solar position
 * - `string` … `"14:30"` or an ISO string like `"2026-07-26T14:30+09:00"`
 *
 * Strings without a UTC offset resolve against the host's time zone. See the
 * note at the top of this file.
 */
export type TimeInput = number | Date | string;

/** Interpret the input as a Date if possible (null for a dateless spec like `"14:30"`) */
export function toDate(t: TimeInput): Date | null {
  if (t instanceof Date) return Number.isNaN(t.getTime()) ? null : t;
  if (typeof t === 'string' && /\d{4}-\d{2}-\d{2}/.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Reduce a time input to a real number 0..24 */
export function toTimeOfDay(t: TimeInput): number {
  if (typeof t === 'number') return ((t % 24) + 24) % 24;
  const d = toDate(t);
  if (d) return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  if (typeof t === 'string') {
    const m = /^(\d{1,2})(?::(\d{2}))?/.exec(t.trim());
    if (m) return ((Number(m[1]) + Number(m[2] ?? 0) / 60) % 24 + 24) % 24;
  }
  return 12;
}

/** Format a 0..24 time of day as `"14:30"` */
export function formatTod(tod: number): string {
  const t = ((tod % 24) + 24) % 24;
  const h = Math.floor(t);
  const m = Math.floor((t - h) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
}
