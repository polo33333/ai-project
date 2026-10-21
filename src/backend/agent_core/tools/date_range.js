'use strict';

const definition = {
  name: 'resolve_date_range',
  description: 'Resolve calendar day/week/month/quarter/year ranges in an IANA timezone. offset -1 means previous period, 0 current period. count includes consecutive periods ending at the selected period. Returns date-only start inclusive/end exclusive for SQL date filters; these are local calendar dates, not UTC instants. Weeks start Monday. No database access.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['unit'],
    properties: {
      unit: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
      offset: { type: 'integer', minimum: -1200, maximum: 1200 },
      count: { type: 'integer', minimum: 1, maximum: 120 },
      timezone: { type: 'string', minLength: 1, maxLength: 100 }
    }
  }
};

function resolve({ unit, offset = 0, count = 1, timezone = 'Asia/Ho_Chi_Minh' }, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const part = name => Number(parts.find(item => item.type === name).value);
  const anchor = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  if (unit === 'week') anchor.setUTCDate(anchor.getUTCDate() - (anchor.getUTCDay() + 6) % 7);
  if (['month', 'quarter', 'year'].includes(unit)) anchor.setUTCDate(1);
  if (unit === 'quarter') anchor.setUTCMonth(Math.floor(anchor.getUTCMonth() / 3) * 3);
  if (unit === 'year') anchor.setUTCMonth(0);
  const shift = periods => {
    const date = new Date(anchor);
    if (unit === 'day' || unit === 'week') date.setUTCDate(date.getUTCDate() + periods * (unit === 'week' ? 7 : 1));
    else date.setUTCMonth(date.getUTCMonth() + periods * ({ month: 1, quarter: 3, year: 12 }[unit]));
    return date.toISOString().slice(0, 10);
  };
  return { start: shift(offset - count + 1), end: shift(offset + 1), timezone, unit, offset, count,
    startInclusive: true, endExclusive: true, resolvedAt: now.toISOString() };
}

module.exports = { definition, resolve };
