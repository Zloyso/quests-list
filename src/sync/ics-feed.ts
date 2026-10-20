import { http, httpError, normalizeFeedUrl } from './http';
import { parseIcs } from './ical';
import type { CalendarProvider, IcsAccount, ListResult } from './types';

/** Read-only calendar from an .ics link (Google "secret address", Yandex export link, Outlook, iCloud…). */
export class IcsFeedProvider implements CalendarProvider {
	constructor(private readonly account: IcsAccount) {}

	async list(from: Date, to: Date): Promise<ListResult> {
		const response = await http({ url: normalizeFeedUrl(this.account.url) });
		if (response.status !== 200) {
			throw httpError('GET', response);
		}
		const result = parseIcs(response.text, this.account.id, from, to);
		// Events made from our own tasks are left out: the calendar already shows those tasks.
		return { events: result.events, tasks: new Map() };
	}
}
