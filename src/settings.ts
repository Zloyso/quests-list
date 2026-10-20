import type { Language } from './i18n';
import { LIST_COLORS, type ListColor, TASK_SORTS, type TaskSort } from './model';
import type { CalendarAccount, CalendarEvent, RemoteRef } from './sync/types';

/** What was last sent to (or seen in) an outside calendar for one task. */
export interface SyncRecord {
	/** Hash of the last pushed event, to tell local edits apart. */
	hash: string;
	/** eventKey() of the event as last pushed or seen, to tell edits made in the calendar apart. */
	key: string;
	ref: RemoteRef;
}

export interface AccountStatus {
	lastSync: number;
	error: string | null;
}

export interface QuestsSettings {
	language: Language;
	/** Data folder relative to the vault root. Must not start with a dot, or sync tools skip it. */
	folder: string;
	/** 0 = Sunday, 1 = Monday */
	weekStart: 0 | 1;
	listsByName: boolean;
	/** Sort for "All", "Today" and "Upcoming". */
	smartSort: TaskSort;
	accounts: CalendarAccount[];
	/** 0 = only by hand */
	syncIntervalMinutes: number;
	/** Private lists close after this much inactivity; 0 = only when Obsidian closes. */
	privateAutoLockMinutes: number;
	syncState: Record<string, Record<string, SyncRecord>>;
	status: Record<string, AccountStatus>;
	/** Last loaded events, shown until the next sync. */
	eventCache: Record<string, CalendarEvent[]>;
}

export const DEFAULT_SETTINGS: QuestsSettings = {
	language: 'auto',
	folder: 'Quests',
	weekStart: 1,
	listsByName: false,
	smartSort: 'start',
	accounts: [],
	syncIntervalMinutes: 15,
	privateAutoLockMinutes: 10,
	syncState: {},
	status: {},
	eventCache: {},
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const obj = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null);

function parseAccount(raw: unknown): CalendarAccount | null {
	const o = obj(raw);
	if (!o || typeof o.id !== 'string' || !o.id) {
		return null;
	}
	const base = {
		id: o.id,
		name: str(o.name) || 'Calendar',
		color: LIST_COLORS.includes(o.color as ListColor) ? (o.color as ListColor) : 'blue',
		enabled: o.enabled !== false,
	};
	const push = {
		push: o.push === true,
		listIds: Array.isArray(o.listIds) ? o.listIds.filter((id): id is string => typeof id === 'string') : null,
	};
	switch (o.type) {
		case 'ics':
			return { ...base, type: 'ics', url: str(o.url) };
		case 'caldav':
			return {
				...base,
				...push,
				type: 'caldav',
				serverUrl: str(o.serverUrl),
				username: str(o.username),
				password: str(o.password),
				calendarUrl: str(o.calendarUrl),
				calendarName: str(o.calendarName),
			};
		case 'google':
			return {
				...base,
				...push,
				type: 'google',
				clientId: str(o.clientId),
				clientSecret: str(o.clientSecret),
				refreshToken: str(o.refreshToken),
				calendarId: str(o.calendarId),
				calendarName: str(o.calendarName),
			};
		default:
			return null;
	}
}

/** Builds settings from stored data, ignoring unknown keys and invalid values. */
export function parseSettings(raw: unknown): QuestsSettings {
	const data = obj(raw) ?? {};
	const d = DEFAULT_SETTINGS;
	const accounts = (Array.isArray(data.accounts) ? data.accounts : [])
		.map(parseAccount)
		.filter((a): a is CalendarAccount => a !== null);
	const ids = new Set(accounts.map((a) => a.id));
	const perAccount = <T>(value: unknown): Record<string, T> => {
		const result: Record<string, T> = {};
		for (const [id, item] of Object.entries(obj(value) ?? {})) {
			if (ids.has(id) && item !== null && typeof item === 'object') {
				result[id] = item as T;
			}
		}
		return result;
	};
	return {
		language: data.language === 'auto' || data.language === 'en' || data.language === 'ru' ? data.language : d.language,
		folder: typeof data.folder === 'string' && data.folder.trim() ? data.folder.trim() : d.folder,
		weekStart: data.weekStart === 0 ? 0 : 1,
		listsByName: data.listsByName === true,
		smartSort: TASK_SORTS.includes(data.smartSort as TaskSort) ? (data.smartSort as TaskSort) : d.smartSort,
		accounts,
		syncIntervalMinutes: clampInt(data.syncIntervalMinutes, 0, 1440, d.syncIntervalMinutes),
		privateAutoLockMinutes: clampInt(data.privateAutoLockMinutes, 0, 1440, d.privateAutoLockMinutes),
		syncState: perAccount<Record<string, SyncRecord>>(data.syncState),
		status: perAccount<AccountStatus>(data.status),
		eventCache: perAccount<CalendarEvent[]>(data.eventCache),
	};
}
