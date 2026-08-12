// Force UTC so the local-Date methods used inside getWeekDates (getDate /
// setDate) agree with the UTC methods used by getCurrentWeekStart/getTodayDate.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getScrapeDates, getWeekStartForDate } from '../../../src/utils/date.js';

describe('getWeekStartForDate', () => {
  // 2026-03-25 is a Wednesday.
  it('returns the same date when given a Wednesday', () => {
    expect(getWeekStartForDate('2026-03-25')).toBe('2026-03-25');
  });

  it('rolls back to the prior Wednesday for a later weekday (Friday)', () => {
    expect(getWeekStartForDate('2026-03-27')).toBe('2026-03-25');
  });

  it('wraps the negative offset for a Sunday (day 0)', () => {
    expect(getWeekStartForDate('2026-03-29')).toBe('2026-03-25');
  });

  it('rolls back across a month boundary (Monday in March → late February)', () => {
    // 2026-03-02 is a Monday; offset = 1 - 3 = -2 → +7 → 5 → Feb 25 (Wednesday).
    expect(getWeekStartForDate('2026-03-02')).toBe('2026-02-25');
  });

  it('zero-pads single-digit months and days', () => {
    // 2026-03-04 is a Wednesday; expect a padded result, not '2026-3-4'.
    expect(getWeekStartForDate('2026-03-04')).toBe('2026-03-04');
  });
});

describe('getScrapeDates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to weekly mode (current Wednesday, 7 days)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z')); // Wednesday
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dates = getScrapeDates();

    expect(dates).toEqual([
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("'from_today' starts at today for the requested number of days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getScrapeDates('from_today', 3)).toEqual(['2026-03-25', '2026-03-26', '2026-03-27']);
  });

  it("'from_today_limited' runs from today until Tuesday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T12:00:00Z')); // Saturday
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Saturday → daysUntilTuesday = 3 → totalDays = 4.
    expect(getScrapeDates('from_today_limited')).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ]);
  });

  it("'from_today_limited' caps the day count at the explicit numDays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T12:00:00Z')); // Saturday (4 days until+incl Tuesday)
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getScrapeDates('from_today_limited', 2)).toEqual(['2026-03-28', '2026-03-29']);
  });

  it("'from_today_limited' yields a single day when today is Tuesday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00Z')); // Tuesday
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getScrapeDates('from_today_limited')).toEqual(['2026-03-24']);
  });

  it('clamps numDays above 14 down to 14 and warns', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dates = getScrapeDates('from_today', 20);

    expect(dates).toHaveLength(14);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('out of range'));
  });

  it('clamps numDays below 1 up to 1 and warns', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dates = getScrapeDates('from_today', 0);

    expect(dates).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('out of range'));
  });
});
