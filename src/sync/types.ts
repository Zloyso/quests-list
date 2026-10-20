import type { ListColor } from '../model';

export type AccountType = 'ics' | 'caldav' | 'google';

interface BaseAccount {
	id: string;
	type: AccountType;
	name: string;
	color: ListColor;
	enabled: boolean;
}

/** Read-only subscription to an iCalendar (.ics) link. */
export interface IcsAccount extends BaseAccount {
	type: 'ics';
	url: string;
}

interface PushOptions {
	/** Send tasks to this calendar as events. */
	push: boolean;
	/** Lists whose tasks are sent; null = all lists. */
	listIds: string[] | null;
}

/** Yandex Calendar, iCloud, Nextcloud, Fastmail and other CalDAV servers. */
export interface CaldavAccount extends BaseAccount, PushOptions {
	type: 'caldav';
	serverUrl: string;
	username: string;
	password: string;
	calendarUrl: string;
	calendarName: string;
}

export interface GoogleAccount extends BaseAccount, PushOptions {
	type: 'google';
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	calendarId: string;
	calendarName: string;
}

export type CalendarAccount = IcsAccount | CaldavAccount | GoogleAccount;

/** An event from an outside calendar, ready to show. */
export interface CalendarEvent {
	/** Unique per occurrence. */
	key: string;
	accountId: string;
	title: string;
	allDay: boolean;
	/** Task-style local values: "YYYY-MM-DD" for all-day events, "YYYY-MM-DDTHH:mm" otherwise. */
	start: string;
	/** Inclusive last day for all-day events; end time otherwise. */
	end: string;
	location: string;
	description: string;
	url: string;
}

/**
 * Event timing in a form that survives a round trip through any calendar.
 * All-day: dates with an exclusive end. Timed: epoch milliseconds.
 */
export type EventTime = { allDay: true; start: string; end: string } | { allDay: false; start: number; end: number };

/** What a task looks like as an event. */
export interface EventPayload {
	taskId: string;
	title: string;
	description: string;
	time: EventTime;
}

/** Where an event lives on the server. */
export interface RemoteRef {
	href?: string;
	etag?: string;
}

/** One of our task events as found on the server. */
export interface RemoteTaskEvent {
	ref: RemoteRef;
	title: string;
	time: EventTime;
}

export interface ListResult {
	/** Events to show (task events excluded). */
	events: CalendarEvent[];
	/** Task events found on the server, by task id. */
	tasks: Map<string, RemoteTaskEvent>;
}

export interface CalendarProvider {
	list(from: Date, to: Date): Promise<ListResult>;
	upsert?(payload: EventPayload, ref: RemoteRef | undefined): Promise<RemoteRef>;
	remove?(taskId: string, ref: RemoteRef | undefined): Promise<void>;
}

export class SyncError extends Error {
	constructor(
		message: string,
		readonly status = 0,
	) {
		super(message);
	}
}

export function supportsPush(account: CalendarAccount): account is CaldavAccount | GoogleAccount {
	return account.type === 'caldav' || account.type === 'google';
}
