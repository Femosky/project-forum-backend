// Site metrics and ad stats run on Lagos days (WAT, UTC+1 all year, no daylight saving)
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// "2026-10-29" for the Lagos day an instant falls on
export function lagosDay(at = new Date()): string {
    return new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

// The day before or after a "YYYY-MM-DD" day
export function addDays(day: string, days: number): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// The UTC instants a Lagos day starts and ends (end exclusive), for comparing with created_at columns
export function lagosDayBounds(day: string): { start: Date; end: Date } {
    const start = new Date(Date.parse(`${day}T00:00:00Z`) - LAGOS_OFFSET_MS);
    return { start, end: new Date(start.getTime() + DAY_MS) };
}
