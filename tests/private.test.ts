import { describe, expect, it } from 'vitest';
import { todayStr } from '../src/dates';
import { createList, createTask, moveList, privateScope } from '../src/model';
import { parseSettings } from '../src/settings';
import { LockedError, QuestsStore, WrongPasswordError } from '../src/store';
import { SyncEngine } from '../src/sync/engine';
import type { CaldavAccount, CalendarProvider } from '../src/sync/types';
import { createApp } from './fake-app';

const PATH = 'Quests/quests.json';
const fileText = (app: ReturnType<typeof createApp>) => app.files.get(PATH)!.text;

function newStore(app: ReturnType<typeof createApp>) {
	const store = new QuestsStore(app as never, () => 'Quests');
	store.kdfIterations = 1000; // fast for tests
	return store;
}

/** A vault with a public list and a private list "Health" holding a secret task. */
async function setup() {
	const app = createApp();
	const store = newStore(app);
	await store.load();
	const work = createList('Work', 1);
	const health = createList('Health', 2);
	const nested = createList('Doctors', 1, health.id);
	await store.update((d) => {
		d.lists.push(work, health, nested);
		d.tasks.push(
			createTask({ listId: work.id, title: 'Public task' }),
			createTask({ listId: health.id, title: 'Secret diagnosis' }),
			createTask({ listId: nested.id, title: 'Call Dr. House' }),
		);
	});
	await store.setPassword('correct horse');
	await store.update((d) => {
		const list = d.lists.find((l) => l.id === health.id)!;
		list.private = true;
		list.updatedAt = Date.now();
	});
	return { app, store, work, health, nested };
}

describe('private lists: storage', () => {
	it('keeps private tasks and nested lists out of the file', async () => {
		const { app, store } = await setup();
		const text = fileText(app);
		expect(text).toContain('Public task');
		expect(text).toContain('Health');
		expect(text).not.toContain('Secret diagnosis');
		expect(text).not.toContain('Doctors');
		expect(text).not.toContain('Dr. House');
		expect(text).not.toContain('correct horse');
		// Still visible in memory while open.
		expect(store.data.tasks.map((t) => t.title).sort()).toEqual(['Call Dr. House', 'Public task', 'Secret diagnosis']);
	});

	it('locks and unlocks', async () => {
		const { app, store } = await setup();
		await store.lock();
		expect(store.locked).toBe(true);
		expect(store.data.tasks.map((t) => t.title)).toEqual(['Public task']);
		expect(store.data.lists.map((l) => l.name)).toEqual(['Work', 'Health']);

		await expect(store.unlock('wrong')).rejects.toBeInstanceOf(WrongPasswordError);
		expect(store.locked).toBe(true);

		await store.unlock('correct horse');
		expect(store.data.tasks.map((t) => t.title).sort()).toEqual(['Call Dr. House', 'Public task', 'Secret diagnosis']);

		// A fresh start (another session) begins locked and opens with the password.
		const other = newStore(app);
		await other.load();
		expect(other.locked).toBe(true);
		await other.unlock('correct horse');
		expect(other.data.lists.map((l) => l.name).sort()).toEqual(['Doctors', 'Health', 'Work']);
	});

	it('saves public changes while locked without losing private tasks', async () => {
		const { app, store, work } = await setup();
		await store.lock();
		await store.update((d) => d.tasks.push(createTask({ listId: work.id, title: 'Added while locked' })));
		const other = newStore(app);
		await other.load();
		await other.unlock('correct horse');
		expect(other.data.tasks.map((t) => t.title).sort()).toEqual(['Added while locked', 'Call Dr. House', 'Public task', 'Secret diagnosis']);
	});

	it('refuses to put something into a closed private list', async () => {
		const { store, work, health } = await setup();
		await store.lock();
		await expect(store.update((d) => moveList(d, work.id, health.id, null))).rejects.toBeInstanceOf(LockedError);
		expect(store.data.lists.find((l) => l.id === work.id)?.parentId).toBeNull();
	});

	it('merges edits of the same private list from two devices', async () => {
		const { app, store, health } = await setup();
		const phone = newStore(app);
		await phone.load();
		await phone.unlock('correct horse');

		// Desktop edits one private task, the phone (with the old file) adds another.
		await store.update((d) => {
			const task = d.tasks.find((t) => t.title === 'Secret diagnosis')!;
			task.title = 'Diagnosis: fine';
			task.updatedAt = Date.now() + 10;
		});
		await phone.update((d) => d.tasks.push(createTask({ listId: health.id, title: 'Buy vitamins' })));

		await store.reloadFromDisk();
		const titles = store.data.tasks.map((t) => t.title).sort();
		expect(titles).toEqual(['Buy vitamins', 'Call Dr. House', 'Diagnosis: fine', 'Public task']);
		expect(fileText(app)).not.toContain('vitamins');
	});

	it('keeps the newest private contents when a locked device writes', async () => {
		const { app, store, work } = await setup();
		const laptop = newStore(app);
		await laptop.load(); // locked, holds the current blob

		await store.update((d) => {
			d.tasks.find((t) => t.title === 'Secret diagnosis')!.title = 'Updated secret';
		});
		// The locked laptop saves an unrelated change from its older copy.
		await laptop.update((d) => d.tasks.push(createTask({ listId: work.id, title: 'Laptop task' })));

		const check = newStore(app);
		await check.load();
		await check.unlock('correct horse');
		expect(check.data.tasks.map((t) => t.title).sort()).toEqual(['Call Dr. House', 'Laptop task', 'Public task', 'Updated secret']);
	});

	it('changes the password and locks other devices that still use the old one', async () => {
		const { app, store } = await setup();
		const phone = newStore(app);
		await phone.load();
		await phone.unlock('correct horse');
		let lockedElsewhere = false;
		phone.onExternalLock = () => {
			lockedElsewhere = true;
		};

		await expect(store.changePassword('nope', 'battery staple')).rejects.toBeInstanceOf(WrongPasswordError);
		await store.changePassword('correct horse', 'battery staple');

		await phone.reloadFromDisk();
		expect(lockedElsewhere).toBe(true);
		expect(phone.locked).toBe(true);
		expect(phone.data.tasks.map((t) => t.title)).toEqual(['Public task']);
		await expect(phone.unlock('correct horse')).rejects.toBeInstanceOf(WrongPasswordError);
		await phone.unlock('battery staple');
		expect(phone.data.tasks).toHaveLength(3);
	});

	it('makes a list public again', async () => {
		const { app, store, health } = await setup();
		await store.update((d) => {
			const list = d.lists.find((l) => l.id === health.id)!;
			list.private = false;
			list.sealed = null;
		});
		expect(fileText(app)).toContain('Secret diagnosis');
		expect(privateScope(store.data.lists).size).toBe(0);
	});
});

describe('private lists: calendar sync', () => {
	it('never sends private tasks and removes events of lists that became private', async () => {
		const { store, work, health } = await setup();
		await store.update((d) => {
			d.lists.find((l) => l.id === health.id)!.private = false;
		});
		const pushed = new Map<string, string>();
		const provider: CalendarProvider = {
			list: async () => ({ events: [], tasks: new Map() }),
			upsert: async (payload) => {
				pushed.set(payload.taskId, payload.title);
				return {};
			},
			remove: async (taskId) => {
				pushed.delete(taskId);
			},
		};
		const account: CaldavAccount = {
			id: 'acc', type: 'caldav', name: 'Cal', color: 'red', enabled: true, serverUrl: '', username: '', password: '',
			calendarUrl: '', calendarName: '', push: true, listIds: null,
		};
		const settings = parseSettings({});
		settings.accounts = [account];
		const engine = new SyncEngine({
			getSettings: () => settings,
			getData: () => store.data,
			saveSettings: async () => undefined,
			updateData: async () => true,
			untitled: () => 'Untitled',
			onSyncStateChange: () => undefined,
		});
		await engine.syncAccount(account, undefined, provider);
		expect([...pushed.values()].sort()).toEqual(['Call Dr. House', 'Public task', 'Secret diagnosis']);

		await store.update((d) => {
			d.lists.find((l) => l.id === health.id)!.private = true;
		});
		await engine.syncAccount(account, undefined, provider);
		expect([...pushed.values()]).toEqual(['Public task']);

		// While locked, nothing changes either.
		await store.lock();
		await engine.syncAccount(account, undefined, provider);
		expect([...pushed.values()]).toEqual(['Public task']);
		expect(store.data.tasks.some((t) => t.listId === work.id && t.start === todayStr())).toBe(true);
	});
});
