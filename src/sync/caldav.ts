/** Minimal CalDAV (RFC 4791) client: calendar discovery, reading events, writing task events. */
import { base64Utf8, http, httpError, type HttpResponse } from './http';
import { buildIcs, parseIcs, taskUid } from './ical';
import {
	type CaldavAccount,
	type CalendarProvider,
	type EventPayload,
	type ListResult,
	type RemoteRef,
	type RemoteTaskEvent,
	SyncError,
} from './types';

const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';

export interface CaldavCalendar {
	url: string;
	name: string;
}

interface DavResponse {
	href: string;
	/** Properties from the 200 propstat, by local name. */
	props: Map<string, Element>;
}

function ensureSlash(url: string): string {
	return url.endsWith('/') ? url : `${url}/`;
}

function parseMultistatus(text: string, baseUrl: string): DavResponse[] {
	const doc = new DOMParser().parseFromString(text, 'application/xml');
	if (doc.getElementsByTagName('parsererror').length) {
		throw new SyncError('Invalid server response');
	}
	const result: DavResponse[] = [];
	for (const response of Array.from(doc.getElementsByTagNameNS(DAV, 'response'))) {
		const hrefEl = Array.from(response.children).find((el) => el.localName === 'href');
		if (!hrefEl?.textContent) {
			continue;
		}
		const props = new Map<string, Element>();
		for (const propstat of Array.from(response.getElementsByTagNameNS(DAV, 'propstat'))) {
			const status = propstat.getElementsByTagNameNS(DAV, 'status')[0]?.textContent ?? '';
			if (!/\s2\d\d\s/.test(` ${status} `)) {
				continue;
			}
			const prop = propstat.getElementsByTagNameNS(DAV, 'prop')[0];
			for (const child of Array.from(prop?.children ?? [])) {
				props.set(child.localName, child);
			}
		}
		result.push({ href: new URL(hrefEl.textContent.trim(), baseUrl).href, props });
	}
	return result;
}

function childHref(el: Element | undefined, baseUrl: string): string | null {
	const href = el ? Array.from(el.getElementsByTagNameNS(DAV, 'href'))[0]?.textContent?.trim() : null;
	return href ? new URL(href, baseUrl).href : null;
}

export class CaldavClient {
	constructor(
		private readonly serverUrl: string,
		private readonly username: string,
		private readonly password: string,
	) {}

	private async request(method: string, url: string, body?: string, extra: Record<string, string> = {}): Promise<HttpResponse> {
		const response = await http({
			url,
			method,
			body,
			headers: {
				Authorization: `Basic ${base64Utf8(`${this.username}:${this.password}`)}`,
				...(body ? { 'Content-Type': extra['Content-Type'] ?? 'application/xml; charset=utf-8' } : {}),
				...extra,
			},
		});
		if (response.status === 401) {
			throw new SyncError('Unauthorized', response.status);
		}
		return response;
	}

	private async propfind(url: string, depth: '0' | '1', props: string): Promise<DavResponse[]> {
		const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`;
		const response = await this.request('PROPFIND', url, body, { Depth: depth });
		if (response.status !== 207) {
			throw httpError('PROPFIND', response);
		}
		return parseMultistatus(response.text, url);
	}

	private async findHref(url: string, prop: string, propXml: string): Promise<string | null> {
		try {
			const [first] = await this.propfind(url, '0', propXml);
			return childHref(first?.props.get(prop), url);
		} catch (err) {
			if (err instanceof SyncError && err.status === 401) {
				throw err;
			}
			return null;
		}
	}

	/** Lists calendars that can hold events. */
	async discover(): Promise<CaldavCalendar[]> {
		const base = ensureSlash(this.serverUrl.trim());
		const principal =
			(await this.findHref(base, 'current-user-principal', '<d:current-user-principal/>')) ??
			(await this.findHref(new URL('/.well-known/caldav', base).href, 'current-user-principal', '<d:current-user-principal/>'));
		const home = (principal && (await this.findHref(principal, 'calendar-home-set', '<c:calendar-home-set/>'))) ?? base;

		const responses = await this.propfind(
			ensureSlash(home),
			'1',
			'<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/>',
		);
		const calendars: CaldavCalendar[] = [];
		for (const response of responses) {
			const types = Array.from(response.props.get('resourcetype')?.children ?? []).map((el) => el.localName);
			if (!types.includes('calendar')) {
				continue;
			}
			const components = Array.from(response.props.get('supported-calendar-component-set')?.children ?? []).map((el) =>
				(el.getAttribute('name') ?? '').toUpperCase(),
			);
			if (components.length && !components.includes('VEVENT')) {
				continue;
			}
			const name = response.props.get('displayname')?.textContent?.trim() || decodeURIComponent(response.href.split('/').filter(Boolean).pop() ?? '');
			calendars.push({ url: response.href, name });
		}
		return calendars;
	}

	async report(calendarUrl: string, from: Date, to: Date, withRange = true): Promise<{ href: string; etag: string; data: string }[]> {
		const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
		const range = withRange ? `<c:time-range start="${stamp(from)}" end="${stamp(to)}"/>` : '';
		const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${range}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
		const url = ensureSlash(calendarUrl);
		const response = await this.request('REPORT', url, body, { Depth: '1' });
		if (response.status !== 207) {
			if (withRange && response.status >= 400 && response.status !== 404) {
				// Some servers reject time-range filters; read everything instead.
				return this.report(calendarUrl, from, to, false);
			}
			throw httpError('REPORT', response);
		}
		return parseMultistatus(response.text, url)
			.map((r) => ({
				href: r.href,
				etag: r.props.get('getetag')?.textContent?.trim() ?? '',
				data: r.props.get('calendar-data')?.textContent ?? '',
			}))
			.filter((r) => r.data.includes('BEGIN:VCALENDAR'));
	}

	async put(url: string, ics: string): Promise<string | undefined> {
		const response = await this.request('PUT', url, ics, { 'Content-Type': 'text/calendar; charset=utf-8' });
		if (response.status < 200 || response.status >= 300) {
			throw httpError('PUT', response);
		}
		return response.headers.etag;
	}

	async delete(url: string): Promise<void> {
		const response = await this.request('DELETE', url);
		if (response.status >= 300 && response.status !== 404 && response.status !== 410) {
			throw httpError('DELETE', response);
		}
	}
}

export class CaldavProvider implements CalendarProvider {
	private readonly client: CaldavClient;

	constructor(private readonly account: CaldavAccount) {
		this.client = new CaldavClient(account.serverUrl, account.username, account.password);
	}

	async list(from: Date, to: Date): Promise<ListResult> {
		const result: ListResult = { events: [], tasks: new Map<string, RemoteTaskEvent>() };
		for (const item of await this.client.report(this.account.calendarUrl, from, to)) {
			try {
				const parsed = parseIcs(item.data, this.account.id, from, to, { href: item.href, etag: item.etag });
				result.events.push(...parsed.events);
				for (const [id, task] of parsed.tasks) {
					result.tasks.set(id, task);
				}
			} catch (err) {
				console.warn('Quests List: skipped an unreadable event', item.href, err);
			}
		}
		return result;
	}

	private hrefFor(taskId: string): string {
		return new URL(`${taskUid(taskId)}.ics`, ensureSlash(this.account.calendarUrl)).href;
	}

	async upsert(payload: EventPayload, ref: RemoteRef | undefined): Promise<RemoteRef> {
		const href = ref?.href ?? this.hrefFor(payload.taskId);
		const etag = await this.client.put(href, buildIcs(payload));
		return { href, etag };
	}

	async remove(taskId: string, ref: RemoteRef | undefined): Promise<void> {
		await this.client.delete(ref?.href ?? this.hrefFor(taskId));
	}
}
