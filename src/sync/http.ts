import { requestUrl } from 'obsidian';
import { SyncError } from './types';

export interface HttpResponse {
	status: number;
	text: string;
	headers: Record<string, string>;
}

/** requestUrl without CORS limits; never throws on HTTP errors, only on network failures. */
export async function http(options: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
}): Promise<HttpResponse> {
	try {
		const response = await requestUrl({
			url: options.url,
			method: options.method ?? 'GET',
			headers: options.headers,
			body: options.body,
			contentType: options.contentType,
			throw: false,
		});
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(response.headers ?? {})) {
			headers[key.toLowerCase()] = value;
		}
		let text = '';
		try {
			text = response.text;
		} catch {
			// Binary or empty body.
		}
		return { status: response.status, text, headers };
	} catch (err) {
		throw new SyncError(err instanceof Error ? err.message : String(err));
	}
}

export function base64Utf8(text: string): string {
	let binary = '';
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Error with a short server explanation when one is available. */
export function httpError(action: string, response: HttpResponse): SyncError {
	let detail = '';
	try {
		const json = JSON.parse(response.text) as { error?: { message?: string } | string; error_description?: string };
		detail = json.error_description ?? (typeof json.error === 'string' ? json.error : (json.error?.message ?? ''));
	} catch {
		detail = response.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
	}
	return new SyncError(`${action}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`, response.status);
}

/** webcal:// links are plain https. */
export function normalizeFeedUrl(url: string): string {
	return url.trim().replace(/^webcals?:\/\//i, 'https://');
}
