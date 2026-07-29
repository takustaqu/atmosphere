import { describe, expect, it } from 'vitest';
import { formatTod, toDate, toTimeOfDay } from '../src/time';

describe('toTimeOfDay', () => {
  it('a number is a time of day, wrapped into 0..24', () => {
    expect(toTimeOfDay(14.5)).toBe(14.5);
    expect(toTimeOfDay(25)).toBe(1);
    expect(toTimeOfDay(-1)).toBe(23);
    expect(toTimeOfDay(24)).toBe(0);
    expect(toTimeOfDay(0)).toBe(0);
  });

  it('a "HH:MM" string is parsed as a clock reading', () => {
    expect(toTimeOfDay('14:30')).toBe(14.5);
    expect(toTimeOfDay('7')).toBe(7);
    expect(toTimeOfDay(' 06:15 ')).toBeCloseTo(6.25, 12);
  });

  it('a Date is read against the host clock, via getHours()', () => {
    // built from local components, so getHours() is 14 wherever this runs
    expect(toTimeOfDay(new Date(2026, 6, 26, 14, 30))).toBe(14.5);
  });

  it('an ISO string with an offset is converted to the host clock first', () => {
    const iso = '2026-07-26T14:30+09:00';
    const d = new Date(iso);
    expect(toTimeOfDay(iso)).toBeCloseTo(d.getHours() + d.getMinutes() / 60, 12);
  });

  it('seconds count too', () => {
    expect(toTimeOfDay(new Date(2026, 6, 26, 1, 0, 36))).toBeCloseTo(1.01, 12);
  });

  it('unparseable input falls back to noon', () => {
    expect(toTimeOfDay('tea time')).toBe(12);
    expect(toTimeOfDay('')).toBe(12);
    expect(toTimeOfDay(new Date('not a date'))).toBe(12);
  });
});

describe('toDate', () => {
  it('a valid Date passes straight through', () => {
    const d = new Date('2026-07-26T14:30+09:00');
    expect(toDate(d)).toBe(d);
  });

  it('an Invalid Date becomes null', () => {
    expect(toDate(new Date('not a date'))).toBeNull();
  });

  it('a dateless clock reading has no Date', () => {
    expect(toDate('14:30')).toBeNull();
    expect(toDate(14.5)).toBeNull();
  });

  it('an ISO string is parsed', () => {
    const iso = '2026-07-26T14:30+09:00';
    const d = toDate(iso);
    expect(d).toBeInstanceOf(Date);
    expect(d!.getTime()).toBe(Date.parse(iso));
  });

  it('a date-shaped but impossible string becomes null', () => {
    expect(toDate('2026-13-45')).toBeNull();
  });
});

describe('formatTod', () => {
  it('formats a fractional hour as a clock reading', () => {
    expect(formatTod(14.5)).toBe('14:30');
    expect(formatTod(0)).toBe('0:00');
  });

  it('pads the minutes to two digits (the hour is left unpadded)', () => {
    expect(formatTod(14.125)).toBe('14:07');
    expect(formatTod(5.5)).toBe('5:30');
  });

  it('wraps values outside 0..24', () => {
    expect(formatTod(24)).toBe('0:00');
    expect(formatTod(25.5)).toBe('1:30');
    expect(formatTod(-1)).toBe('23:00');
  });
});
