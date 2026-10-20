/** iCalendar (RFC 5545): reading feeds and CalDAV resources, writing task events. */
import ICAL from 'ical.js';
import { addDays, datePart, parseLocal, timePart, toDateStr, toDateTimeStr, zonedTimeToMs } from '../dates';
import type { Task } from '../model';
import type { EventPayload, EventTime, ListResult, RemoteRef, RemoteTaskEvent } from './types';

/** Task events get UIDs like "quests-list-<task id>"; no "@" so the UID can also be the CalDAV file name. */
export const TASK_UID_PREFIX = 'quests-list-';
/** Marks finished tasks in outside calendars. */
export const DONE_PREFIX = '✓ ';
/** Guard against endless recurrence rules. */
const MAX_OCCURRENCES = 5000;
const HOUR = 3_600_000;

type ICalTime = InstanceType<typeof ICAL.Time>;
type ICalComponent = InstanceType<typeof ICAL.Component>;

// ---------- Tasks <-> event timing ----------

export function taskEventTime(task: Pick<Task, 'start' | 'end'>): EventTime {
	const startDate = datePart(task.start);
	if (!timePart(task.start)) {
		const endDate = task.end && datePart(task.end) > startDate ? datePart(task.end) : startDate;
		return { allDay: true, start: startDate, end: addDays(endDate, 1) };
	}
	const start = parseLocal(task.start).getTime();
	let end = 0;
	if (task.end) {
		end = parseLocal(timePart(task.end) ? task.end : `${datePart(task.end)}T23:59`).getTime();
	}
	if (end <= start) {
		end = start + HOUR;
	}
	return { allDay: false, start, end };
}

export function taskToPayload(task: Task, untitled: string): EventPayload {
	return {
		taskId: task.id,
		title: (task.done ? DONE_PREFIX : '') + (task.title.trim() || untitled),
		description: task.notes,
		time: taskEventTime(task),
	};
}

/** Task start/end for event timing (the reverse of taskEventTime). */
export function taskDatesFromTime(time: EventTime): { start: string; end: string | null } {
	if (time.allDay) {
		const last = addDays(time.end, -1);
		return { start: time.start, end: last > time.start ? last : null };
	}
	const start = toDateTimeStr(new Date(time.start));
	const end = toDateTimeStr(new Date(time.end));
	return { start, end: end > start ? end : null };
}

/** Title and done state for an event title. */
export function taskTitleFromEvent(title: string): { title: string; done: boolean } {
	return title.startsWith(DONE_PREFIX) ? { title: title.slice(DONE_PREFIX.length), done: true } : { title, done: false };
}

/** Compact comparable form of an event's title and timing. */
export function eventKey(title: string, time: EventTime): string {
	return JSON.stringify([title, time.allDay, time.start, time.end]);
}

export function payloadHash(payload: EventPayload): string {
	const text = JSON.stringify([payload.title, payload.description, payload.time]);
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36) + text.length.toString(36);
}

export function taskIdFromUid(uid: string): string | null {
	return uid.startsWith(TASK_UID_PREFIX) ? uid.slice(TASK_UID_PREFIX.length) || null : null;
}

/** Event timing to the values shown in the calendar. */
export function displayRange(time: EventTime): { start: string; end: string } {
	if (time.allDay) {
		const last = addDays(time.end, -1);
		return { start: time.start, end: last > time.start ? last : time.start };
	}
	return { start: toDateTimeStr(new Date(time.start)), end: toDateTimeStr(new Date(time.end)) };
}

function timeBounds(time: EventTime): [number, number] {
	return time.allDay ? [parseLocal(time.start).getTime(), parseLocal(time.end).getTime()] : [time.start, time.end];
}

// ---------- Parsing ----------

function timeToMs(t: ICalTime, tzid: string | null): number {
	if (tzid && t.zone?.tzid === 'floating') {
		const ms = zonedTimeToMs(t, tzid);
		if (ms !== null) {
			return ms;
		}
	}
	return t.toJSDate().getTime();
}

function dateOf(t: ICalTime): string {
	return `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

function toEventTime(start: ICalTime, end: ICalTime | null, tzid: string | null): EventTime {
	if (start.isDate) {
		const s = dateOf(start);
		let e = end ? (end.isDate ? dateOf(end) : toDateStr(end.toJSDate())) : addDays(s, 1);
		if (e <= s) {
			e = addDays(s, 1);
		}
		return { allDay: true, start: s, end: e };
	}
	const s = timeToMs(start, tzid);
	const e = end ? timeToMs(end, tzid) : s;
	return { allDay: false, start: s, end: Math.max(s, e) };
}

function textValue(component: ICalComponent, name: string): string {
	const value = component.getFirstPropertyValue(name);
	return typeof value === 'string' ? value : '';
}

function tzidOf(component: ICalComponent): string | null {
	const tzid = component.getFirstProperty('dtstart')?.getParameter('tzid');
	return typeof tzid === 'string' && tzid ? tzid : null;
}

function rootComponents(text: string): ICalComponent[] {
	const jcal: unknown = ICAL.parse(text);
	// Several VCALENDARs in one file come back as an array of jCal arrays.
	const list = Array.isArray(jcal) && Array.isArray(jcal[0]) ? (jcal as unknown[]) : [jcal];
	return list.map((item) => new ICAL.Component(item as never));
}

/**
 * Reads events from iCalendar text. Recurring events are expanded within [from, to).
 * Events created from tasks are returned separately in `tasks`, tagged with `ref`.
 */
export function parseIcs(text: string, accountId: string, from: Date, to: Date, ref: RemoteRef = {}): ListResult {
	const result: ListResult = { events: [], tasks: new Map<string, RemoteTaskEvent>() };
	const fromMs = from.getTime();
	const toMs = to.getTime();

	for (const root of rootComponents(text)) {
		const vevents = root.getAllSubcomponents('vevent');
		const exceptions = new Map<string, ICalComponent[]>();
		const masters: ICalComponent[] = [];
		for (const vevent of vevents) {
			const uid = textValue(vevent, 'uid');
			if (vevent.hasProperty('recurrence-id')) {
				exceptions.set(uid, [...(exceptions.get(uid) ?? []), vevent]);
			} else {
				masters.push(vevent);
			}
		}
		// Exceptions whose master is not in this file are shown as plain events.
		const masterUids = new Set(masters.map((m) => textValue(m, 'uid')));
		for (const [uid, list] of exceptions) {
			if (!masterUids.has(uid)) {
				masters.push(...list);
				exceptions.delete(uid);
			}
		}

		for (const vevent of masters) {
			if (textValue(vevent, 'status').toUpperCase() === 'CANCELLED' || !vevent.hasProperty('dtstart')) {
				continue;
			}
			const uid = textValue(vevent, 'uid');
			const tzid = tzidOf(vevent);
			const event = new ICAL.Event(vevent, { exceptions: exceptions.get(uid) ?? [] });

			const taskId = taskIdFromUid(uid);
			if (taskId) {
				result.tasks.set(taskId, { ref, title: event.summary ?? '', time: toEventTime(event.startDate, event.endDate, tzid) });
				continue;
			}

			const push = (item: InstanceType<typeof ICAL.Event>, time: EventTime) => {
				const [s, e] = timeBounds(time);
				// Zero-length events still count on the day they happen.
				if (s >= toMs || (e <= fromMs && !(e === s && s >= fromMs))) {
					return;
				}
				const range = displayRange(time);
				result.events.push({
					key: `${accountId}:${uid}:${time.allDay ? time.start : String(time.start)}`,
					accountId,
					title: item.summary || '—',
					allDay: time.allDay,
					start: range.start,
					end: range.end,
					location: item.location ?? '',
					description: item.description ?? '',
					url: textValue(item.component, 'url'),
				});
			};

			if (!event.isRecurring()) {
				push(event, toEventTime(event.startDate, event.endDate, tzid));
				continue;
			}
			const iterator = event.iterator();
			for (let i = 0, next = iterator.next(); next && i < MAX_OCCURRENCES; i++, next = iterator.next()) {
				const details = event.getOccurrenceDetails(next);
				const time = toEventTime(details.startDate, details.endDate, tzid);
				if (timeBounds(time)[0] >= toMs) {
					break;
				}
				if (textValue(details.item.component, 'status').toUpperCase() === 'CANCELLED') {
					continue;
				}
				push(details.item, time);
			}
		}
	}
	return result;
}

// ---------- Writing ----------

function escapeText(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line to 75 octets as RFC 5545 requires, without splitting UTF-8 characters. */
export function foldLine(line: string): string {
	const encoder = new TextEncoder();
	const parts: string[] = [];
	let current = '';
	let size = 0;
	for (const char of line) {
		const charSize = encoder.encode(char).length;
		const limit = parts.length ? 74 : 75;
		if (size + charSize > limit) {
			parts.push(current);
			current = '';
			size = 0;
		}
		current += char;
		size += charSize;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

function utcStamp(ms: number): string {
	return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsDate(date: string): string {
	return date.replace(/-/g, '');
}

export function taskUid(taskId: string): string {
	return TASK_UID_PREFIX + taskId;
}

export function buildIcs(payload: EventPayload, now = Date.now()): string {
	const { time } = payload;
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Quests List//Obsidian//EN',
		'CALSCALE:GREGORIAN',
		'BEGIN:VEVENT',
		`UID:${taskUid(payload.taskId)}`,
		`DTSTAMP:${utcStamp(now)}`,
		`LAST-MODIFIED:${utcStamp(now)}`,
		...(time.allDay
			? [`DTSTART;VALUE=DATE:${icsDate(time.start)}`, `DTEND;VALUE=DATE:${icsDate(time.end)}`]
			: [`DTSTART:${utcStamp(time.start)}`, `DTEND:${utcStamp(time.end)}`]),
		`SUMMARY:${escapeText(payload.title)}`,
		...(payload.description ? [`DESCRIPTION:${escapeText(payload.description)}`] : []),
		'TRANSP:TRANSPARENT',
		'END:VEVENT',
		'END:VCALENDAR',
	];
	return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
