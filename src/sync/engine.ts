/**
 * Calendar sync.
 * - Every account: events are loaded for display.
 * - CalDAV/Google with "push": tasks are written as events. When an event made from a task is moved or renamed
 *   in the calendar (and the task was not changed here since), the task takes over the new dates and title.
 */
import { addMonths, parseLocal, startOfMonth, todayStr } from '../dates';
import { privateScope, type QuestsData, type Task } from '../model';
import type { QuestsSettings, SyncRecord } from '../settings';
import { CaldavProvider } from './caldav';
import { GoogleProvider } from './google';
import { IcsFeedProvider } from './ics-feed';
import { eventKey, payloadHash, taskDatesFromTime, taskTitleFromEvent, taskToPayload } from './ical';
import { type CalendarAccount, type CalendarEvent, type CalendarProvider, supportsPush, SyncError } from './types';

const MAX_CACHED_EVENTS = 5000;

export interface SyncHost {
	getSettings(): QuestsSettings;
	getData(): QuestsData;
	saveSettings(): Promise<void>;
	updateData(change: (data: QuestsData) => void): Promise<boolean>;
	untitled(): string;
	onSyncStateChange(): void;
}

export function providerFor(account: CalendarAccount): CalendarProvider {
	switch (account.type) {
		case 'ics':
			return new IcsFeedProvider(account);
		case 'caldav':
			return new CaldavProvider(account);
		case 'google':
			return new GoogleProvider(account);
	}
}

/** The window of events loaded from calendars. */
export function syncRange(today = todayStr()): { from: Date; to: Date } {
	const first = startOfMonth(today);
	return { from: parseLocal(addMonths(first, -2)), to: parseLocal(addMonths(first, 13)) };
}

export interface SyncReport {
	errors: { account: CalendarAccount; error: unknown }[];
	pushed: number;
	pulled: number;
}

interface TaskUpdate {
	id: string;
	start: string;
	end: string | null;
	title: string;
	done: boolean;
}

export class SyncEngine {
	running = false;
	private current: Promise<SyncReport> | null = null;
	private again = false;

	constructor(private readonly host: SyncHost) {}

	/** Events of enabled accounts from the last sync. */
	events(): CalendarEvent[] {
		const { accounts, eventCache } = this.host.getSettings();
		return accounts.filter((a) => a.enabled).flatMap((a) => eventCache[a.id] ?? []);
	}

	/** Syncs all enabled accounts. A call during a running sync schedules one more run afterwards. */
	syncAll(): Promise<SyncReport> {
		if (this.current) {
			this.again = true;
			return this.current;
		}
		this.running = true;
		this.host.onSyncStateChange();
		this.current = (async () => {
			const report: SyncReport = { errors: [], pushed: 0, pulled: 0 };
			try {
				do {
					this.again = false;
					for (const account of this.host.getSettings().accounts.filter((a) => a.enabled)) {
						try {
							await this.syncAccount(account, report);
						} catch (error) {
							report.errors.push({ account, error });
							this.setStatus(account, error);
						}
					}
					await this.host.saveSettings();
				} while (this.again);
			} finally {
				this.current = null;
				this.running = false;
				this.host.onSyncStateChange();
			}
			return report;
		})();
		return this.current;
	}

	private setStatus(account: CalendarAccount, error: unknown): void {
		const status = this.host.getSettings().status;
		const previous = status[account.id];
		status[account.id] = error
			? { lastSync: previous?.lastSync ?? 0, error: error instanceof Error ? error.message : JSON.stringify(error) }
			: { lastSync: Date.now(), error: null };
	}

	/** Drops everything stored for an account that was removed. */
	forget(accountId: string): void {
		const settings = this.host.getSettings();
		delete settings.syncState[accountId];
		delete settings.status[accountId];
		delete settings.eventCache[accountId];
	}

	async syncAccount(
		account: CalendarAccount,
		report: SyncReport = { errors: [], pushed: 0, pulled: 0 },
		provider: CalendarProvider = providerFor(account),
	): Promise<void> {
		const settings = this.host.getSettings();
		const { from, to } = syncRange();
		const remote = await provider.list(from, to);
		settings.eventCache[account.id] = remote.events.slice(0, MAX_CACHED_EVENTS);

		if (supportsPush(account) && provider.upsert && provider.remove) {
			const state = (settings.syncState[account.id] ??= {});
			const data = this.host.getData();
			// Tasks of private lists never leave the vault.
			const hidden = privateScope(data.lists);
			const eligible = account.push
				? data.tasks.filter(
						(task) => !hidden.has(task.listId) && (account.listIds === null || account.listIds.includes(task.listId)),
					)
				: [];
			const eligibleIds = new Set(eligible.map((task) => task.id));
			const updates: TaskUpdate[] = [];
			const untitled = this.host.untitled();

			for (const task of eligible) {
				const payload = taskToPayload(task, untitled);
				const hash = payloadHash(payload);
				const key = eventKey(payload.title, payload.time);
				const prev: SyncRecord | undefined = state[task.id];
				const found = remote.tasks.get(task.id);
				const foundKey = found ? eventKey(found.title, found.time) : null;

				if (found && foundKey !== null && prev && foundKey !== prev.key && hash === prev.hash) {
					// Changed in the calendar only: take the calendar's version.
					const dates = taskDatesFromTime(found.time);
					const named = taskTitleFromEvent(found.title);
					const update: TaskUpdate = {
						id: task.id,
						...dates,
						title: !task.title.trim() && named.title === untitled ? task.title : named.title,
						done: named.done,
					};
					updates.push(update);
					const updated: Task = { ...task, ...update };
					state[task.id] = { hash: payloadHash(taskToPayload(updated, untitled)), key: foundKey, ref: found.ref };
					report.pulled++;
					continue;
				}
				if (!prev && found && foundKey === key) {
					// Already there (e.g. pushed from another device).
					state[task.id] = { hash, key, ref: found.ref };
					continue;
				}
				if (!prev || prev.hash !== hash) {
					const ref = await provider.upsert(payload, found?.ref ?? prev?.ref);
					state[task.id] = { hash, key, ref };
					report.pushed++;
				} else if (found) {
					prev.ref = found.ref;
				}
			}

			// Tasks removed, moved to a list that is not synced, or push turned off.
			for (const [taskId, record] of Object.entries(state)) {
				if (!eligibleIds.has(taskId)) {
					await provider.remove(taskId, record.ref);
					delete state[taskId];
				}
			}
			// Task events left behind by tasks removed on another device.
			for (const [taskId, found] of remote.tasks) {
				if (!eligibleIds.has(taskId) && !state[taskId] && data.deleted[taskId] !== undefined) {
					await provider.remove(taskId, found.ref);
				}
			}

			if (updates.length) {
				const ok = await this.host.updateData((d) => {
					for (const update of updates) {
						const task = d.tasks.find((t) => t.id === update.id);
						if (!task) {
							continue;
						}
						if (task.done !== update.done) {
							task.doneAt = update.done ? Date.now() : null;
						}
						task.start = update.start;
						task.end = update.end;
						task.title = update.title;
						task.done = update.done;
						task.updatedAt = Date.now();
					}
				});
				if (!ok) {
					throw new SyncError('Could not save tasks');
				}
			}
		}
		this.setStatus(account, null);
	}
}
