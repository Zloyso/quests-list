import { http } from './obsidian-stub';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/dates';
import { createList, createTask, emptyData, type QuestsData, removeTask } from '../src/model';
import { parseSettings, type QuestsSettings } from '../src/settings';
import { CaldavClient } from '../src/sync/caldav';
import { SyncEngine } from '../src/sync/engine';
import { GoogleProvider } from '../src/sync/google';
import type { CaldavAccount, GoogleAccount } from '../src/sync/types';

const BASE = 'https://dav.test';
const CAL = `${BASE}/calendars/me/events/`;
const AUTH = `Basic ${btoa('me@test:pw')}`;

const multistatus = (responses: string) =>
	`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
const ok = (props: string) => `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A tiny CalDAV server: one principal, two collections, resources in memory. */
function fakeCaldav() {
	const resources = new Map<string, { data: string; etag: string }>();
	const log: string[] = [];
	let n = 0;
	http.handler = (req) => {
		log.push(`${req.method} ${req.url}`);
		if (req.headers?.Authorization !== AUTH) {
			return { status: 401 };
		}
		switch (req.method) {
			case 'PROPFIND':
				if (req.url === `${BASE}/`) {
					return { status: 207, text: multistatus(`<d:response><d:href>/</d:href>${ok('<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>')}</d:response>`) };
				}
				if (req.url === `${BASE}/principals/me/`) {
					return { status: 207, text: multistatus(`<d:response><d:href>/principals/me/</d:href>${ok('<c:calendar-home-set><d:href>/calendars/me/</d:href></c:calendar-home-set>')}</d:response>`) };
				}
				if (req.url === `${BASE}/calendars/me/`) {
					return {
						status: 207,
						text: multistatus(
							`<d:response><d:href>/calendars/me/</d:href>${ok('<d:resourcetype><d:collection/></d:resourcetype>')}</d:response>` +
								`<d:response><d:href>/calendars/me/events/</d:href>${ok('<d:displayname>Мои события</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>')}</d:response>` +
								`<d:response><d:href>/calendars/me/todo/</d:href>${ok('<d:displayname>Дела</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>')}</d:response>`,
						),
					};
				}
				return { status: 404 };
			case 'REPORT':
				return {
					status: 207,
					text: multistatus(
						[...resources].map(
							([href, r]) =>
								`<d:response><d:href>${new URL(href).pathname}</d:href>${ok(`<d:getetag>${r.etag}</d:getetag><c:calendar-data>${escapeXml(r.data)}</c:calendar-data>`)}</d:response>`,
						).join(''),
					),
				};
			case 'PUT': {
				const etag = `"${++n}"`;
				resources.set(req.url, { data: req.body ?? '', etag });
				return { status: 201, headers: { ETag: etag } };
			}
			case 'DELETE':
				return resources.delete(req.url) ? { status: 204 } : { status: 404 };
		}
		return { status: 405 };
	};
	return { resources, log };
}

function setup(account: CaldavAccount | GoogleAccount) {
	const settings: QuestsSettings = parseSettings({});
	settings.accounts = [account];
	const data: QuestsData = emptyData();
	const list = createList('Work', 1);
	data.lists.push(list);
	const host = {
		getSettings: () => settings,
		getData: () => data,
		saveSettings: async () => undefined,
		updateData: async (change: (d: QuestsData) => void) => {
			change(data);
			return true;
		},
		untitled: () => 'Untitled',
		onSyncStateChange: () => undefined,
	};
	return { settings, data, list, engine: new SyncEngine(host) };
}

const caldavAccount = (): CaldavAccount => ({
	id: 'cal',
	type: 'caldav',
	name: 'Yandex',
	color: 'red',
	enabled: true,
	serverUrl: BASE,
	username: 'me@test',
	password: 'pw',
	calendarUrl: CAL,
	calendarName: 'Мои события',
	push: true,
	listIds: null,
});

describe('CalDAV', () => {
	it('discovers event calendars through the principal', async () => {
		fakeCaldav();
		const calendars = await new CaldavClient(BASE, 'me@test', 'pw').discover();
		expect(calendars).toEqual([{ url: CAL, name: 'Мои события' }]);
	});

	it('reports wrong credentials', async () => {
		fakeCaldav();
		await expect(new CaldavClient(BASE, 'me@test', 'nope').discover()).rejects.toMatchObject({ status: 401 });
	});
});

describe('sync engine (CalDAV)', () => {
	const today = todayStr();
	let server: ReturnType<typeof fakeCaldav>;
	beforeEach(() => {
		server = fakeCaldav();
	});

	it('pushes tasks once and again only after a change', async () => {
		const { data, list, engine } = setup(caldavAccount());
		const task = createTask({ listId: list.id, title: 'Report', start: today });
		data.tasks.push(task);

		let report = await engine.syncAll();
		expect(report.errors).toEqual([]);
		expect(report.pushed).toBe(1);
		const href = `${CAL}quests-list-${task.id}.ics`;
		expect(server.resources.get(href)?.data).toContain('SUMMARY:Report');

		report = await engine.syncAll();
		expect(report.pushed).toBe(0);

		task.title = 'Final report';
		report = await engine.syncAll();
		expect(report.pushed).toBe(1);
		expect(server.resources.get(href)?.data).toContain('SUMMARY:Final report');
	});

	it('takes over dates moved in the calendar', async () => {
		const { data, list, engine } = setup(caldavAccount());
		const task = createTask({ listId: list.id, title: 'Trip', start: today });
		data.tasks.push(task);
		await engine.syncAll();

		const href = `${CAL}quests-list-${task.id}.ics`;
		const moved = addDays(today, 3).replace(/-/g, '');
		const movedEnd = addDays(today, 5).replace(/-/g, '');
		const resource = server.resources.get(href)!;
		resource.data = resource.data
			.replace(/DTSTART;VALUE=DATE:\d+/, `DTSTART;VALUE=DATE:${moved}`)
			.replace(/DTEND;VALUE=DATE:\d+/, `DTEND;VALUE=DATE:${movedEnd}`)
			.replace('SUMMARY:Trip', 'SUMMARY:✓ Trip to Kazan');
		resource.etag = '"edited"';

		const report = await engine.syncAll();
		expect(report.pulled).toBe(1);
		expect(report.pushed).toBe(0);
		expect(task).toMatchObject({ start: addDays(today, 3), end: addDays(today, 4), title: 'Trip to Kazan', done: true });

		// Nothing to do afterwards.
		expect((await engine.syncAll()).pushed).toBe(0);
	});

	it('lets local edits win when both sides changed', async () => {
		const { data, list, engine } = setup(caldavAccount());
		const task = createTask({ listId: list.id, title: 'Call', start: today });
		data.tasks.push(task);
		await engine.syncAll();
		const href = `${CAL}quests-list-${task.id}.ics`;
		const resource = server.resources.get(href)!;
		resource.data = resource.data.replace('SUMMARY:Call', 'SUMMARY:Call (remote)');
		task.title = 'Call (local)';

		const report = await engine.syncAll();
		expect(report.pushed).toBe(1);
		expect(task.title).toBe('Call (local)');
		expect(server.resources.get(href)?.data).toContain('SUMMARY:Call (local)');
	});

	it('removes events of deleted tasks and when push is turned off', async () => {
		const account = caldavAccount();
		const { data, list, engine } = setup(account);
		const a = createTask({ listId: list.id, title: 'A', start: today });
		const b = createTask({ listId: list.id, title: 'B', start: today });
		data.tasks.push(a, b);
		await engine.syncAll();
		expect(server.resources.size).toBe(2);

		removeTask(data, a.id);
		await engine.syncAll();
		expect([...server.resources.keys()]).toEqual([`${CAL}quests-list-${b.id}.ics`]);

		account.push = false;
		await engine.syncAll();
		expect(server.resources.size).toBe(0);
	});

	it('pushes only chosen lists', async () => {
		const account = caldavAccount();
		const { data, list, engine } = setup(account);
		const other = createList('Home', 2);
		data.lists.push(other);
		data.tasks.push(createTask({ listId: list.id, title: 'Work task', start: today }));
		data.tasks.push(createTask({ listId: other.id, title: 'Home task', start: today }));
		account.listIds = [other.id];
		await engine.syncAll();
		expect([...server.resources.values()].map((r) => /SUMMARY:(.*)/.exec(r.data)?.[1]?.trim())).toEqual(['Home task']);
	});

	it('does not re-send events that another device already sent', async () => {
		const { data, list, engine, settings } = setup(caldavAccount());
		data.tasks.push(createTask({ listId: list.id, title: 'Shared', start: today }));
		await engine.syncAll();
		// A second device: same data, no sync state.
		settings.syncState = {};
		const puts = server.log.filter((l) => l.startsWith('PUT')).length;
		const report = await engine.syncAll();
		expect(report.pushed).toBe(0);
		expect(server.log.filter((l) => l.startsWith('PUT')).length).toBe(puts);
	});

	it('loads other events for display and records errors', async () => {
		const { settings, engine } = setup(caldavAccount());
		const day = today.replace(/-/g, '');
		server.resources.set(`${CAL}meeting.ics`, {
			etag: '"m"',
			data: ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:meeting', 'SUMMARY:Meeting', `DTSTART;VALUE=DATE:${day}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
		});
		await engine.syncAll();
		expect(engine.events().map((e) => e.title)).toEqual(['Meeting']);
		expect(settings.status.cal?.error).toBeNull();

		(settings.accounts[0] as CaldavAccount).password = 'wrong';
		const report = await engine.syncAll();
		expect(report.errors).toHaveLength(1);
		expect(settings.status.cal?.error).toBe('Unauthorized');
		// Events from the last good sync stay visible.
		expect(engine.events()).toHaveLength(1);
	});
});

describe('Google provider', () => {
	const account: GoogleAccount = {
		id: 'g',
		type: 'google',
		name: 'Google',
		color: 'blue',
		enabled: true,
		clientId: 'cid',
		clientSecret: 'secret',
		refreshToken: 'refresh-1',
		calendarId: 'primary',
		calendarName: 'Me',
		push: true,
		listIds: null,
	};

	it('lists events, keeps task events apart and creates missing events', async () => {
		const calls: string[] = [];
		const events = new Map<string, unknown>();
		http.handler = (req) => {
			calls.push(`${req.method} ${req.url.split('?')[0]}`);
			if (req.url === 'https://oauth2.googleapis.com/token') {
				expect(req.body).toContain('grant_type=refresh_token');
				return { status: 200, text: JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
			}
			expect(req.headers?.Authorization).toBe('Bearer tok');
			const path = req.url.replace('https://www.googleapis.com/calendar/v3/calendars/primary/events', '');
			if (req.method === 'GET') {
				return {
					status: 200,
					text: JSON.stringify({
						items: [
							{ id: 'abc', summary: 'Lunch', start: { dateTime: '2026-10-20T12:00:00+03:00' }, end: { dateTime: '2026-10-20T13:00:00+03:00' } },
							{ id: 'ql0123456789abcdef0123', summary: 'Task', start: { date: '2026-10-21' }, end: { date: '2026-10-22' }, etag: '"e"' },
							{ id: 'x', status: 'cancelled' },
						],
					}),
				};
			}
			if (req.method === 'PUT') {
				return events.has(path) ? { status: 200, text: JSON.stringify({ etag: '"u"' }) } : { status: 404 };
			}
			if (req.method === 'POST') {
				const body = JSON.parse(req.body ?? '{}') as { id: string };
				events.set(`/${body.id}`, body);
				return { status: 200, text: JSON.stringify({ etag: '"n"' }) };
			}
			return { status: 500 };
		};
		const provider = new GoogleProvider(account);
		const result = await provider.list(new Date('2026-10-01'), new Date('2026-11-01'));
		expect(result.events.map((e) => e.title)).toEqual(['Lunch']);
		expect(result.tasks.get('0123456789abcdef0123')).toMatchObject({ title: 'Task', time: { allDay: true, start: '2026-10-21', end: '2026-10-22' } });

		const ref = await provider.upsert({
			taskId: 'ffffffffffffffffffff',
			title: 'New',
			description: '',
			time: { allDay: true, start: '2026-10-25', end: '2026-10-26' },
		});
		expect(ref).toEqual({ href: 'qlffffffffffffffffffff', etag: '"n"' });
		expect(calls.filter((c) => !c.includes('token'))).toEqual([
			'GET https://www.googleapis.com/calendar/v3/calendars/primary/events',
			'PUT https://www.googleapis.com/calendar/v3/calendars/primary/events/qlffffffffffffffffffff',
			'POST https://www.googleapis.com/calendar/v3/calendars/primary/events',
		]);
	});

	it('reports a revoked sign-in as an auth error', async () => {
		http.handler = () => ({ status: 400, text: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) });
		await expect(new GoogleProvider({ ...account, refreshToken: 'revoked' }).list(new Date(), new Date())).rejects.toMatchObject({ status: 401 });
	});
});
