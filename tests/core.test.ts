import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isValidDateValue, parseLocal, shiftDays, zonedTimeToMs } from '../src/dates';
import {
	createList,
	createTask,
	descendantIds,
	emptyData,
	listPath,
	listTree,
	moveList,
	resolveParents,
	isForToday,
	isOverdue,
	isUpcoming,
	mergeData,
	parseData,
	type QuestsData,
	removeList,
	removeTask,
	renamePaths,
	reorder,
	sortTasks,
} from '../src/model';
import { parseSettings } from '../src/settings';
import { DataFormatError, parseDataText, QuestsStore, serializeData } from '../src/store';
import { buildIcs, foldLine, parseIcs, taskDatesFromTime, taskEventTime, taskToPayload } from '../src/sync/ical';
import { createApp, tick } from './fake-app';

describe('dates', () => {
	it('validates date values', () => {
		expect(isValidDateValue('2026-10-20')).toBe(true);
		expect(isValidDateValue('2026-10-20T09:30')).toBe(true);
		expect(isValidDateValue('2026-02-30')).toBe(false);
		expect(isValidDateValue('20.10.2026')).toBe(false);
		expect(isValidDateValue(null)).toBe(false);
	});

	it('does day arithmetic across months and DST', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(daysBetween('2026-03-25', '2026-04-05')).toBe(11);
		expect(shiftDays('2026-10-30T23:15', 3)).toBe('2026-11-02T23:15');
	});

	it('converts wall time in a named zone', () => {
		const moscow = zonedTimeToMs({ year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0 }, 'Europe/Moscow');
		expect(new Date(moscow ?? 0).toISOString()).toBe('2026-07-01T09:00:00.000Z');
		const ny = zonedTimeToMs({ year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 }, 'America/New_York');
		expect(new Date(ny ?? 0).toISOString()).toBe('2026-01-15T17:00:00.000Z');
		expect(zonedTimeToMs({ year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, 'Not/AZone')).toBeNull();
	});
});

describe('model', () => {
	const items = (...orders: number[]) => orders.map((order, i) => ({ id: String.fromCharCode(97 + i), order }));

	it('reorders by changing only the moved item', () => {
		const list = items(1, 2, 3);
		expect(reorder(list, 'c', 'a')).toEqual(['c']);
		expect(list.find((i) => i.id === 'c')?.order).toBe(0);
		list.sort((x, y) => x.order - y.order);
		expect(reorder(list, 'a', null)).toEqual(['a']);
		expect(list.find((i) => i.id === 'a')?.order).toBe(3);
	});

	it('does nothing when the position does not change', () => {
		const list = items(1, 2, 3);
		expect(reorder(list, 'b', 'c')).toEqual([]);
		expect(reorder(list, 'c', null)).toEqual([]);
	});

	it('renumbers when there is no room between neighbours', () => {
		const list = items(1, 1, 2);
		const changed = reorder(list, 'c', 'b');
		expect(changed.length).toBe(3);
		expect([...list].sort((x, y) => x.order - y.order).map((i) => i.id)).toEqual(['a', 'c', 'b']);
	});

	it('sorts tasks without a due date last', () => {
		const a = createTask({ listId: 'l', title: 'A', end: null });
		const b = createTask({ listId: 'l', title: 'B', end: '2026-10-25' });
		const c = createTask({ listId: 'l', title: 'C', end: '2026-10-21' });
		expect(sortTasks([a, b, c], 'end').map((t) => t.title)).toEqual(['C', 'B', 'A']);
		expect(sortTasks([b, c, a], 'title').map((t) => t.title)).toEqual(['A', 'B', 'C']);
	});

	it('classifies tasks by date', () => {
		const today = '2026-10-20';
		expect(isForToday(createTask({ listId: 'l', title: '', start: '2026-10-18' }), today)).toBe(true);
		expect(isForToday(createTask({ listId: 'l', title: '', start: '2026-10-21' }), today)).toBe(false);
		expect(isUpcoming(createTask({ listId: 'l', title: '', start: '2026-10-27' }), today)).toBe(true);
		expect(isUpcoming(createTask({ listId: 'l', title: '', start: '2026-10-28' }), today)).toBe(false);
		expect(isOverdue(createTask({ listId: 'l', title: '', start: '2026-10-01', end: '2026-10-19' }), today)).toBe(true);
		expect(isOverdue(createTask({ listId: 'l', title: '', start: '2026-10-01', end: '2026-10-19', done: true }), today)).toBe(false);
	});

	const baseData = (): QuestsData => {
		const data = emptyData();
		const list = createList('Work', 1);
		data.lists.push(list);
		data.tasks.push(createTask({ listId: list.id, title: 'One', updatedAt: 100 }));
		return data;
	};

	it('merges by newest edit per item', () => {
		const local = baseData();
		const remote = structuredClone(local);
		local.tasks[0]!.title = 'Local';
		local.tasks[0]!.updatedAt = 200;
		remote.tasks[0]!.title = 'Remote';
		remote.tasks[0]!.updatedAt = 300;
		remote.tasks.push(createTask({ listId: remote.lists[0]!.id, title: 'New remote' }));
		const merged = mergeData(local, remote);
		expect(merged.tasks.map((t) => t.title).sort()).toEqual(['New remote', 'Remote']);
	});

	it('keeps removals unless the item was edited afterwards', () => {
		const local = baseData();
		const remote = structuredClone(local);
		removeTask(local, local.tasks[0]!.id);
		expect(mergeData(local, remote).tasks).toEqual([]);

		remote.tasks[0]!.updatedAt = Date.now() + 1000;
		expect(mergeData(local, remote).tasks.length).toBe(1);
	});

	it('drops tasks of a removed list', () => {
		const local = baseData();
		const remote = structuredClone(local);
		removeList(local, local.lists[0]!.id);
		const merged = mergeData(local, remote);
		expect(merged.lists).toEqual([]);
		expect(merged.tasks).toEqual([]);
	});

	it('parses stored data defensively', () => {
		const data = parseData({
			lists: [{ id: 'l1', name: 'A', color: 'teal', sort: 'weird' }, { name: 'no id' }],
			tasks: [
				{ id: 't1', listId: 'l1', title: 'ok', start: '2026-10-20', end: 'bad', attachments: ['a.png', 3] },
				{ id: 't2', listId: 'missing', title: 'orphan' },
			],
			deleted: { x: 5, y: 'no' },
		});
		expect(data.lists).toHaveLength(1);
		expect(data.lists[0]).toMatchObject({ color: null, sort: 'manual' });
		expect(data.tasks).toHaveLength(1);
		expect(data.tasks[0]).toMatchObject({ end: null, attachments: ['a.png'] });
		expect(data.deleted).toEqual({ x: 5 });
	});

	it('follows renamed files and folders', () => {
		const data = baseData();
		data.tasks[0]!.attachments = ['Quests/attachments/a.png', 'Other/b.pdf'];
		data.tasks[0]!.links = ['Notes/Plan.md'];
		expect(renamePaths(data, 'Notes/Plan.md', 'Notes/Big plan.md')).toBe(true);
		expect(renamePaths(data, 'Quests', 'Tasks')).toBe(true);
		expect(data.tasks[0]!.links).toEqual(['Notes/Big plan.md']);
		expect(data.tasks[0]!.attachments).toEqual(['Tasks/attachments/a.png', 'Other/b.pdf']);
		expect(renamePaths(data, 'Nope', 'X')).toBe(false);
	});
});

describe('settings', () => {
	it('ignores invalid values and unknown accounts', () => {
		const s = parseSettings({
			weekStart: 3,
			syncIntervalMinutes: -5,
			accounts: [{ id: 'a', type: 'ics', url: 'https://x' }, { id: 'b', type: 'smoke' }],
			syncState: { a: {}, zzz: {} },
		});
		expect(s.weekStart).toBe(1);
		expect(s.syncIntervalMinutes).toBe(0);
		expect(s.accounts.map((a) => a.id)).toEqual(['a']);
		expect(Object.keys(s.syncState)).toEqual(['a']);
	});
});

describe('task <-> event timing', () => {
	it('maps all-day tasks to exclusive end dates', () => {
		expect(taskEventTime({ start: '2026-10-20', end: null })).toEqual({ allDay: true, start: '2026-10-20', end: '2026-10-21' });
		expect(taskEventTime({ start: '2026-10-20', end: '2026-10-22' })).toEqual({ allDay: true, start: '2026-10-20', end: '2026-10-23' });
		// An end before the start is ignored.
		expect(taskEventTime({ start: '2026-10-20', end: '2026-10-10' })).toEqual({ allDay: true, start: '2026-10-20', end: '2026-10-21' });
	});

	it('maps timed tasks', () => {
		const start = parseLocal('2026-10-20T10:00').getTime();
		expect(taskEventTime({ start: '2026-10-20T10:00', end: null })).toEqual({ allDay: false, start, end: start + 3_600_000 });
		expect(taskEventTime({ start: '2026-10-20T10:00', end: '2026-10-20' })).toEqual({
			allDay: false,
			start,
			end: parseLocal('2026-10-20T23:59').getTime(),
		});
	});

	it('round-trips dates', () => {
		for (const task of [
			{ start: '2026-10-20', end: null },
			{ start: '2026-10-20', end: '2026-10-25' },
			{ start: '2026-10-20T10:00', end: '2026-10-21T12:30' },
		]) {
			expect(taskDatesFromTime(taskEventTime(task))).toEqual(task);
		}
	});
});

describe('iCalendar', () => {
	const from = new Date('2026-09-01T00:00:00Z');
	const to = new Date('2027-01-01T00:00:00Z');

	it('folds long lines on character boundaries', () => {
		const line = `SUMMARY:${'я'.repeat(60)}`;
		const folded = foldLine(line);
		for (const part of folded.split('\r\n')) {
			expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
		}
		expect(folded.replace(/\r\n /g, '')).toBe(line);
	});

	it('writes task events that read back the same', () => {
		const task = createTask({ listId: 'l', title: 'Купить, молоко; хлеб', notes: 'line 1\nline 2', start: '2026-10-20T10:00', end: '2026-10-20T11:30' });
		const payload = taskToPayload(task, 'Untitled');
		const ics = buildIcs(payload);
		expect(ics).toContain('SUMMARY:Купить\\, молоко\\; хлеб');
		const parsed = parseIcs(ics, 'acc', from, to, { href: 'h' });
		expect(parsed.events).toEqual([]);
		expect(parsed.tasks.get(task.id)).toEqual({ ref: { href: 'h' }, title: payload.title, time: payload.time });
	});

	it('expands recurring events with exceptions and time zones', () => {
		const ics = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VTIMEZONE',
			'TZID:Europe/Moscow',
			'BEGIN:STANDARD',
			'TZOFFSETFROM:+0300',
			'TZOFFSETTO:+0300',
			'TZNAME:MSK',
			'DTSTART:19700101T000000',
			'END:STANDARD',
			'END:VTIMEZONE',
			'BEGIN:VEVENT',
			'UID:weekly',
			'SUMMARY:Standup',
			'DTSTART;TZID=Europe/Moscow:20261005T100000',
			'DTEND;TZID=Europe/Moscow:20261005T103000',
			'RRULE:FREQ=WEEKLY;COUNT=4',
			'EXDATE;TZID=Europe/Moscow:20261012T100000',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:weekly',
			'RECURRENCE-ID;TZID=Europe/Moscow:20261019T100000',
			'SUMMARY:Standup (moved)',
			'DTSTART;TZID=Europe/Moscow:20261019T150000',
			'DTEND;TZID=Europe/Moscow:20261019T153000',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:gone',
			'STATUS:CANCELLED',
			'SUMMARY:Cancelled',
			'DTSTART;VALUE=DATE:20261010',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		const { events } = parseIcs(ics, 'acc', from, to);
		const utc = events.map((e) => [e.title, new Date(parseLocal(e.start)).toISOString()]);
		expect(utc).toEqual([
			['Standup', '2026-10-05T07:00:00.000Z'],
			['Standup (moved)', '2026-10-19T12:00:00.000Z'],
			['Standup', '2026-10-26T07:00:00.000Z'],
		]);
	});

	it('uses IANA zone names even without VTIMEZONE and reads all-day events', () => {
		const ics = [
			'BEGIN:VCALENDAR',
			'BEGIN:VEVENT',
			'UID:a',
			'SUMMARY:Call',
			'DTSTART;TZID=Asia/Tokyo:20261020T090000',
			'DTEND;TZID=Asia/Tokyo:20261020T100000',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:b',
			'SUMMARY:Trip',
			'DTSTART;VALUE=DATE:20261101',
			'DTEND;VALUE=DATE:20261104',
			'LOCATION:Kazan',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:c',
			'SUMMARY:Too late',
			'DTSTART;VALUE=DATE:20270301',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		const { events } = parseIcs(ics, 'acc', from, to);
		expect(events).toHaveLength(2);
		expect(new Date(parseLocal(events[0]!.start)).toISOString()).toBe('2026-10-20T00:00:00.000Z');
		expect(events[1]).toMatchObject({ title: 'Trip', allDay: true, start: '2026-11-01', end: '2026-11-03', location: 'Kazan' });
	});
});

describe('store', () => {
	const folder = 'Quests';

	it('creates the file on the first change and merges outside changes', async () => {
		const app = createApp();
		const store = new QuestsStore(app as never, () => folder);
		await store.load();
		const list = createList('A', 1);
		await store.update((d) => d.lists.push(list));
		expect(app.files.has('Quests/quests.json')).toBe(true);

		// Another device adds a task to the file.
		const remote = structuredClone(store.data);
		remote.tasks.push(createTask({ listId: list.id, title: 'From phone' }));
		app.externalWrite('Quests/quests.json', serializeData(remote));
		// A local change made before the reload still keeps the remote task.
		await store.update((d) => d.tasks.push(createTask({ listId: list.id, title: 'From desktop' })));
		expect(store.data.tasks.map((t) => t.title).sort()).toEqual(['From desktop', 'From phone']);
		expect(parseDataText(app.files.get('Quests/quests.json')!.text).tasks).toHaveLength(2);
	});

	it('reports its own writes as no change', async () => {
		const app = createApp();
		const store = new QuestsStore(app as never, () => folder);
		await store.load();
		await store.update((d) => d.lists.push(createList('A', 1)));
		await store.update((d) => d.lists.push(createList('B', 2)));
		expect(await store.reloadFromDisk()).toBe(false);
	});

	it('refuses to overwrite a damaged file', async () => {
		const app = createApp();
		app.externalWrite('Quests/quests.json', '{ not json');
		const store = new QuestsStore(app as never, () => folder);
		await expect(store.load()).rejects.toBeInstanceOf(DataFormatError);
		expect(store.broken).toBe(true);
		await expect(store.update((d) => d.lists.push(createList('A', 1)))).rejects.toBeInstanceOf(DataFormatError);
		expect(app.files.get('Quests/quests.json')!.text).toBe('{ not json');
		await tick();
	});

	it('leaves memory unchanged when a write fails', async () => {
		const app = createApp();
		const store = new QuestsStore(app as never, () => folder);
		await store.load();
		await store.update((d) => d.lists.push(createList('A', 1)));
		app.vault.process = async () => {
			throw new Error('disk full');
		};
		await expect(store.update((d) => d.lists.push(createList('B', 2)))).rejects.toThrow('disk full');
		expect(store.data.lists.map((l) => l.name)).toEqual(['A']);
	});
});

describe('nested lists', () => {
	const setup = () => {
		const data = emptyData();
		const work = createList('Work', 1);
		const projectA = createList('Project A', 1, work.id);
		const projectB = createList('Project B', 2, work.id);
		const design = createList('Design', 1, projectA.id);
		const home = createList('Home', 2);
		data.lists.push(work, projectA, projectB, design, home);
		return { data, work, projectA, projectB, design, home };
	};

	it('builds the tree in display order', () => {
		const { data } = setup();
		expect(listTree(data.lists, false).map((n) => `${'-'.repeat(n.depth)}${n.list.name}`)).toEqual([
			'Work',
			'-Project A',
			'--Design',
			'-Project B',
			'Home',
		]);
		expect(listTree(data.lists, true).map((n) => n.list.name)).toEqual(['Home', 'Work', 'Project A', 'Design', 'Project B']);
	});

	it('finds nested lists and paths', () => {
		const { data, work, projectA, design } = setup();
		expect([...descendantIds(data.lists, work.id)].length).toBe(4);
		expect(descendantIds(data.lists, projectA.id)).toEqual(new Set([projectA.id, design.id]));
		expect(listPath(data.lists, design.id)).toEqual(['Work', 'Project A', 'Design']);
	});

	it('moves lists inside others and refuses loops', () => {
		const { data, work, projectA, design, home } = setup();
		expect(moveList(data, home.id, projectA.id, design.id)).toBe(true);
		expect(listTree(data.lists, false).map((n) => n.list.name)).toEqual(['Work', 'Project A', 'Home', 'Design', 'Project B']);
		expect(moveList(data, work.id, design.id, null)).toBe(false);
		expect(moveList(data, projectA.id, null, work.id)).toBe(true);
		expect(listTree(data.lists, false).map((n) => `${n.depth}${n.list.name}`)).toEqual(['0Project A', '1Home', '1Design', '0Work', '1Project B']);
	});

	it('treats loops and missing parents from a merge as top level', () => {
		const { data, work, projectA } = setup();
		work.parentId = projectA.id;
		const orphan = createList('Orphan', 9, 'gone');
		data.lists.push(orphan);
		const parents = resolveParents(data.lists);
		expect(parents.get(work.id)).toBeNull();
		expect(parents.get(projectA.id)).toBeNull();
		expect(parents.get(orphan.id)).toBeNull();
		expect(listTree(data.lists, false)).toHaveLength(data.lists.length);
	});

	it('removes a list with everything nested in it', () => {
		const { data, work, projectA, design, home } = setup();
		data.tasks.push(createTask({ listId: design.id, title: 'deep' }), createTask({ listId: home.id, title: 'keep' }));
		removeList(data, projectA.id);
		expect(data.lists.map((l) => l.name)).toEqual(['Work', 'Project B', 'Home']);
		expect(data.tasks.map((t) => t.title)).toEqual(['keep']);
		expect(data.deleted).toHaveProperty(design.id);
		expect(work.parentId).toBeNull();
	});

	it('keeps the parent when parsing and merging', () => {
		const { data, projectA } = setup();
		const parsed = parseData(JSON.parse(JSON.stringify(data)));
		expect(parsed.lists.find((l) => l.id === projectA.id)?.parentId).toBe(projectA.parentId);
		const remote = structuredClone(data);
		const moved = remote.lists.find((l) => l.id === projectA.id)!;
		moved.parentId = null;
		moved.updatedAt = Date.now() + 1000;
		expect(mergeData(data, remote).lists.find((l) => l.id === projectA.id)?.parentId).toBeNull();
	});
});
