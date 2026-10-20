/**
 * Task dates are local wall-clock strings: "YYYY-MM-DD" (a whole day) or "YYYY-MM-DDTHH:mm" (with a time).
 * Strings in these formats sort chronologically, so plain string comparison works.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function isValidDateValue(value: unknown): value is string {
	if (typeof value !== 'string' || !(DATE_RE.test(value) || DATE_TIME_RE.test(value))) {
		return false;
	}
	const d = parseLocal(value);
	return !Number.isNaN(d.getTime()) && toDateStr(d) === value.slice(0, 10);
}

export function toDateStr(d: Date): string {
	return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toDateTimeStr(d: Date): string {
	return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayStr(now = new Date()): string {
	return toDateStr(now);
}

export function datePart(value: string): string {
	return value.slice(0, 10);
}

export function timePart(value: string): string | null {
	return value.length > 10 ? value.slice(11, 16) : null;
}

export function withTime(date: string, time: string | null): string {
	return time ? `${date}T${time}` : date;
}

/** Parses a task date as local time. A date without time means midnight. */
export function parseLocal(value: string): Date {
	const y = Number(value.slice(0, 4));
	const m = Number(value.slice(5, 7));
	const d = Number(value.slice(8, 10));
	const time = timePart(value);
	const h = time ? Number(time.slice(0, 2)) : 0;
	const min = time ? Number(time.slice(3, 5)) : 0;
	return new Date(y, m - 1, d, h, min);
}

export function addDays(date: string, days: number): string {
	const d = parseLocal(datePart(date));
	d.setDate(d.getDate() + days);
	return toDateStr(d);
}

/** Whole days from a to b (both "YYYY-MM-DD"), safe across DST changes. */
export function daysBetween(a: string, b: string): number {
	const ua = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
	const ub = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
	return Math.round((ub - ua) / 86_400_000);
}

/** Moves a date value by whole days, keeping its time. */
export function shiftDays(value: string, days: number): string {
	return withTime(addDays(datePart(value), days), timePart(value));
}

export function startOfMonth(date: string): string {
	return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: string, months: number): string {
	const d = parseLocal(startOfMonth(date));
	d.setMonth(d.getMonth() + months);
	return toDateStr(d);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
	return parseLocal(date).getDay();
}

export function formatDateValue(value: string, now = new Date()): string {
	const d = parseLocal(value);
	const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
	if (d.getFullYear() !== now.getFullYear()) {
		options.year = 'numeric';
	}
	if (timePart(value)) {
		options.hour = '2-digit';
		options.minute = '2-digit';
	}
	return d.toLocaleString(undefined, options);
}

export function formatTime(value: string): string {
	return parseLocal(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatMonthTitle(date: string): string {
	const text = parseLocal(date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
	return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

export function formatLongDate(date: string): string {
	const text = parseLocal(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
	return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** Short weekday names starting from `weekStart` (0 = Sunday, 1 = Monday). */
export function weekdayNames(weekStart: number): string[] {
	const names: string[] = [];
	// 2023-01-01 was a Sunday.
	for (let i = 0; i < 7; i++) {
		const d = new Date(2023, 0, 1 + ((weekStart + i) % 7));
		names.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
	}
	return names;
}

/**
 * Milliseconds since epoch for a wall-clock time in an IANA time zone.
 * Returns null when the zone is unknown to Intl.
 */
export function zonedTimeToMs(
	parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
	timeZone: string,
): number | null {
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
		});
	} catch {
		return null;
	}
	const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	const offsetAt = (ms: number) => {
		const values: Record<string, number> = {};
		for (const part of format.formatToParts(new Date(ms))) {
			if (part.type !== 'literal') {
				values[part.type] = Number(part.value);
			}
		}
		const asUtc = Date.UTC(
			values.year ?? 0,
			(values.month ?? 1) - 1,
			values.day ?? 1,
			values.hour ?? 0,
			values.minute ?? 0,
			values.second ?? 0,
		);
		return asUtc - ms;
	};
	// Two passes settle the offset around DST transitions.
	let guess = wall - offsetAt(wall);
	guess = wall - offsetAt(guess);
	return guess;
}
