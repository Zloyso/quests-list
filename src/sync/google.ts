/**
 * Google Calendar through its REST API.
 * Sign-in uses OAuth 2.0 for desktop apps (PKCE + loopback redirect), with the user's own OAuth client.
 */
import { Platform } from 'obsidian';
import { base64Url, http, httpError } from './http';
import { displayRange } from './ical';
import {
	type CalendarEvent,
	type CalendarProvider,
	type EventPayload,
	type EventTime,
	type GoogleAccount,
	type ListResult,
	type RemoteRef,
	type RemoteTaskEvent,
	SyncError,
} from './types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ');
const SIGN_IN_TIMEOUT = 5 * 60_000;
/** Event ids made from tasks: "ql" + task id (Google allows a–v and 0–9). */
const TASK_EVENT_RE = /^ql([0-9a-f]{20})$/;

export class SignInCancelled extends Error {}

const accessTokens = new Map<string, { token: string; expires: number }>();

function randomString(bytes: number): string {
	const data = new Uint8Array(bytes);
	crypto.getRandomValues(data);
	return base64Url(data);
}

async function tokenRequest(params: Record<string, string>) {
	const response = await http({
		url: TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams(params).toString(),
	});
	if (response.status !== 200) {
		throw httpError('OAuth', response);
	}
	return JSON.parse(response.text) as { access_token: string; expires_in: number; refresh_token?: string };
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Quests List</title>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center">
<div><h2>Quests List</h2><p>Готово, можно вернуться в Obsidian.<br>Done, you can return to Obsidian.</p></div></body>`;

/**
 * Opens Google sign-in in the browser and returns a refresh token. Desktop only.
 * `signal` aborts waiting (e.g. when the dialog is closed).
 */
export async function googleSignIn(clientId: string, clientSecret: string, signal?: AbortSignal): Promise<string> {
	if (!Platform.isDesktopApp) {
		throw new SyncError('Google sign-in is available on desktop only');
	}
	// Node's http module exists only in desktop Obsidian, so it is loaded here, after the platform check.
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	const { createServer } = require('http') as typeof import('http');
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const verifier = randomString(48);
	const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
	const state = randomString(16);

	try {
		const code = await new Promise<string>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new SignInCancelled()), SIGN_IN_TIMEOUT);
			signal?.addEventListener('abort', () => {
				window.clearTimeout(timer);
				reject(new SignInCancelled());
			});
			server.on('request', (req, res) => {
				const url = new URL(req.url ?? '/', redirectUri);
				const code = url.searchParams.get('code');
				const error = url.searchParams.get('error');
				if (!code && !error) {
					res.writeHead(404);
					res.end();
					return;
				}
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(DONE_PAGE);
				window.clearTimeout(timer);
				if (error || url.searchParams.get('state') !== state || !code) {
					reject(new SyncError(error ?? 'Sign-in failed'));
				} else {
					resolve(code);
				}
			});
			const params = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: 'code',
				scope: SCOPES,
				access_type: 'offline',
				prompt: 'consent',
				code_challenge: challenge,
				code_challenge_method: 'S256',
				state,
			});
			window.open(`${AUTH_URL}?${params.toString()}`);
		});
		const tokens = await tokenRequest({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code',
			code_verifier: verifier,
		});
		if (!tokens.refresh_token) {
			throw new SyncError('Google did not return a refresh token');
		}
		accessTokens.set(tokens.refresh_token, { token: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 });
		return tokens.refresh_token;
	} finally {
		server.close();
	}
}

type Credentials = Pick<GoogleAccount, 'clientId' | 'clientSecret' | 'refreshToken'>;

async function accessToken(account: Credentials, force = false): Promise<string> {
	if (!account.refreshToken) {
		throw new SyncError('Not signed in to Google', 401);
	}
	const cached = accessTokens.get(account.refreshToken);
	if (cached && !force && cached.expires - 60_000 > Date.now()) {
		return cached.token;
	}
	const tokens = await tokenRequest({
		client_id: account.clientId,
		client_secret: account.clientSecret,
		refresh_token: account.refreshToken,
		grant_type: 'refresh_token',
	}).catch((err: unknown) => {
		// invalid_grant: the token was revoked or expired.
		throw err instanceof SyncError && err.status === 400 ? new SyncError(err.message, 401) : err;
	});
	accessTokens.set(account.refreshToken, { token: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 });
	return tokens.access_token;
}

async function api(account: Credentials, method: string, path: string, body?: unknown) {
	const send = async (force: boolean) =>
		http({
			url: API + path,
			method,
			headers: { Authorization: `Bearer ${await accessToken(account, force)}` },
			contentType: body === undefined ? undefined : 'application/json',
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	let response = await send(false);
	if (response.status === 401) {
		response = await send(true);
	}
	return response;
}

export interface GoogleCalendarInfo {
	id: string;
	name: string;
	primary: boolean;
}

export async function googleCalendars(account: Credentials): Promise<GoogleCalendarInfo[]> {
	const response = await api(account, 'GET', '/users/me/calendarList?minAccessRole=writer');
	if (response.status !== 200) {
		throw httpError('calendarList', response);
	}
	const json = JSON.parse(response.text) as { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[] };
	return (json.items ?? []).map((item) => ({
		id: item.id,
		name: item.summaryOverride ?? item.summary ?? item.id,
		primary: item.primary === true,
	}));
}

interface GoogleEvent {
	id: string;
	status?: string;
	summary?: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	etag?: string;
	start?: { date?: string; dateTime?: string };
	end?: { date?: string; dateTime?: string };
}

function eventTime(event: GoogleEvent): EventTime | null {
	if (event.start?.date) {
		return { allDay: true, start: event.start.date, end: event.end?.date ?? event.start.date };
	}
	if (event.start?.dateTime) {
		const start = Date.parse(event.start.dateTime);
		const end = event.end?.dateTime ? Date.parse(event.end.dateTime) : start;
		return Number.isNaN(start) ? null : { allDay: false, start, end: Math.max(start, end) };
	}
	return null;
}

export class GoogleProvider implements CalendarProvider {
	constructor(private readonly account: GoogleAccount) {}

	private get calendarPath(): string {
		return `/calendars/${encodeURIComponent(this.account.calendarId)}/events`;
	}

	async list(from: Date, to: Date): Promise<ListResult> {
		const result: ListResult = { events: [], tasks: new Map<string, RemoteTaskEvent>() };
		let pageToken = '';
		do {
			const params = new URLSearchParams({
				timeMin: from.toISOString(),
				timeMax: to.toISOString(),
				singleEvents: 'true',
				maxResults: '2500',
			});
			if (pageToken) {
				params.set('pageToken', pageToken);
			}
			const response = await api(this.account, 'GET', `${this.calendarPath}?${params.toString()}`);
			if (response.status !== 200) {
				throw httpError('events.list', response);
			}
			const json = JSON.parse(response.text) as { items?: GoogleEvent[]; nextPageToken?: string };
			for (const item of json.items ?? []) {
				const time = eventTime(item);
				if (item.status === 'cancelled' || !time) {
					continue;
				}
				const taskId = TASK_EVENT_RE.exec(item.id)?.[1];
				if (taskId) {
					result.tasks.set(taskId, { ref: { href: item.id, etag: item.etag }, title: item.summary ?? '', time });
					continue;
				}
				const range = displayRange(time);
				const event: CalendarEvent = {
					key: `${this.account.id}:${item.id}`,
					accountId: this.account.id,
					title: item.summary || '—',
					allDay: time.allDay,
					start: range.start,
					end: range.end,
					location: item.location ?? '',
					description: item.description ?? '',
					url: item.htmlLink ?? '',
				};
				result.events.push(event);
			}
			pageToken = json.nextPageToken ?? '';
		} while (pageToken);
		return result;
	}

	async upsert(payload: EventPayload): Promise<RemoteRef> {
		const id = `ql${payload.taskId}`;
		const { time } = payload;
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const body = {
			id,
			summary: payload.title,
			description: payload.description,
			status: 'confirmed',
			transparency: 'transparent',
			start: time.allDay ? { date: time.start } : { dateTime: new Date(time.start).toISOString(), timeZone },
			end: time.allDay ? { date: time.end } : { dateTime: new Date(time.end).toISOString(), timeZone },
		};
		const path = `${this.calendarPath}/${id}`;
		let response = await api(this.account, 'PUT', path, body);
		if (response.status === 404) {
			response = await api(this.account, 'POST', this.calendarPath, body);
			if (response.status === 409) {
				// The id belongs to a deleted event; updating it brings it back.
				response = await api(this.account, 'PUT', path, body);
			}
		}
		if (response.status !== 200) {
			throw httpError('events.update', response);
		}
		const json = JSON.parse(response.text) as GoogleEvent;
		return { href: id, etag: json.etag };
	}

	async remove(taskId: string): Promise<void> {
		const response = await api(this.account, 'DELETE', `${this.calendarPath}/ql${taskId}`);
		if (response.status >= 300 && response.status !== 404 && response.status !== 410) {
			throw httpError('events.delete', response);
		}
	}
}
