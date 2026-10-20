/**
 * Low-level cryptography: PBKDF2-SHA256 key derivation and AES-256-GCM sealing.
 * Uses only the Web Crypto API, which is available on desktop and mobile.
 */

export const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface KdfParams {
	name: 'PBKDF2';
	hash: 'SHA-256';
	iterations: number;
	salt: string;
}

export interface Sealed {
	iv: string;
	data: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function encode(text: string): Uint8Array<ArrayBuffer> {
	const encoded = encoder.encode(text);
	const bytes = new Uint8Array(encoded.length);
	bytes.set(encoded);
	return bytes;
}

export function newKdfParams(iterations = KDF_ITERATIONS): KdfParams {
	return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(randomBytes(SALT_BYTES)) };
}

/** Derives a non-extractable AES-GCM key. The password is NFC-normalized so it matches across keyboards. */
export async function deriveKey(password: string, params: KdfParams): Promise<CryptoKey> {
	const baseKey = await crypto.subtle.importKey('raw', encode(password.normalize('NFC')), 'PBKDF2', false, [
		'deriveKey',
	]);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: params.hash, iterations: params.iterations, salt: fromBase64(params.salt) },
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

export async function seal(key: CryptoKey, plaintext: string, associatedData: string): Promise<Sealed> {
	const iv = randomBytes(IV_BYTES);
	const cipher = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encode(associatedData) },
		key,
		encode(plaintext),
	);
	return { iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

/** Throws when the key is wrong or the data was tampered with (GCM authentication fails). */
export async function unseal(key: CryptoKey, sealed: Sealed, associatedData: string): Promise<string> {
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: encode(associatedData) },
		key,
		fromBase64(sealed.data),
	);
	return decoder.decode(plain);
}
