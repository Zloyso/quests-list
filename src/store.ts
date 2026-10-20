/**
 * Keeps lists and tasks in one JSON file inside the vault, so any vault sync tool carries them between devices.
 * Writes are serialized; if the file was changed elsewhere (sync), it is merged before writing.
 *
 * Private lists: the tasks and nested lists of every private list are stored as one AES-GCM blob in that list
 * ("sealed"), with a key derived from the password. In memory they exist only while unlocked.
 */
import { type App, normalizePath, TFolder } from 'obsidian';
import { deriveKey, KDF_ITERATIONS, newKdfParams, seal, unseal } from './crypto';
import {
	descendantIds,
	emptyData,
	mergeData,
	parseData,
	parseSealedContents,
	privateRoots,
	type QuestsData,
	type SealedBlob,
	type SecretInfo,
} from './model';

export const DATA_FILE_NAME = 'quests.json';
const ATTACHMENTS_FOLDER = 'attachments';
const FORMAT = 'quests-list';
const VERSION = 1;
const CHECK_TEXT = 'quests-list';
const CHECK_AAD = 'quests-list:check';
const MAX_WRITE_ATTEMPTS = 5;

const sealAad = (listId: string) => `quests-list:list:${listId}`;

/** The data file exists but cannot be read. Writes are refused so it is not overwritten. */
export class DataFormatError extends Error {}
export class WrongPasswordError extends Error {}
/** A change touches private lists while they are locked. */
export class LockedError extends Error {}

/** Plain serialization (no private contents). */
export function serializeData(data: QuestsData): string {
	return `${JSON.stringify(
		{ format: FORMAT, version: VERSION, lists: data.lists, tasks: data.tasks, deleted: data.deleted, secret: data.secret },
		null,
		'\t',
	)}\n`;
}

export function parseDataText(text: string): QuestsData {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new DataFormatError('Invalid JSON');
	}
	if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== FORMAT) {
		throw new DataFormatError('Unknown format');
	}
	return parseData(raw);
}

export class QuestsStore {
	data: QuestsData = emptyData();
	loaded = false;
	broken = false;
	/** PBKDF2 iterations for new passwords (lowered in tests). */
	kdfIterations = KDF_ITERATIONS;
	/** Called when private lists lock by themselves (the password was changed on another device). */
	onExternalLock: (() => void) | null = null;
	/** File text as last read or written by this device. */
	private lastText: string | null = null;
	/** Text being written right now; its "modify" event must not count as an outside change. */
	private pendingText: string | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private key: CryptoKey | null = null;
	/** `changedAt` of the password the key belongs to. */
	private keyChangedAt: number | null = null;
	/** Last plain contents and blob per private list, so unchanged lists are not re-encrypted on every save. */
	private readonly sealCache = new Map<string, { plain: string; blob: SealedBlob }>();

	constructor(
		private readonly app: App,
		private readonly getFolder: () => string,
	) {}

	get folder(): string {
		return normalizePath(this.getFolder());
	}

	get path(): string {
		return normalizePath(`${this.folder}/${DATA_FILE_NAME}`);
	}

	get attachmentsFolder(): string {
		return normalizePath(`${this.folder}/${ATTACHMENTS_FOLDER}`);
	}

	get hasPassword(): boolean {
		return this.data.secret !== null;
	}

	/** Private lists are open (the password was entered). */
	get unlocked(): boolean {
		return this.key !== null;
	}

	/** There are private lists and they are closed. */
	get locked(): boolean {
		return !this.key && privateRoots(this.data.lists).length > 0;
	}

	private enqueue<T>(job: () => Promise<T>): Promise<T> {
		const run = this.queue.then(job);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Resolves when all queued reads and writes are done. */
	idle(): Promise<void> {
		return this.enqueue(async () => undefined);
	}

	load(): Promise<void> {
		return this.enqueue(async () => {
			this.broken = false;
			// A (possibly different) file: private lists start locked.
			this.forgetKey();
			const file = this.app.vault.getFileByPath(this.path);
			if (!file) {
				this.data = emptyData();
				this.lastText = null;
				this.loaded = true;
				return;
			}
			const text = await this.app.vault.read(file);
			try {
				this.data = parseDataText(text);
				this.lastText = text;
			} catch (err) {
				this.data = emptyData();
				this.broken = true;
				throw err;
			} finally {
				this.loaded = true;
			}
		});
	}

	/**
	 * Applies a change to a copy of the data and saves it; memory is updated only if the write succeeds.
	 * If the file changes while it is being encrypted, the change is applied again to the new version.
	 */
	update(change: (data: QuestsData) => void): Promise<void> {
		return this.enqueue(async () => {
			if (this.broken) {
				throw new DataFormatError('Data file is damaged');
			}
			const vault = this.app.vault;
			for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
				const file = vault.getFileByPath(this.path);
				const current = file ? await vault.read(file) : null;
				let base = this.data;
				if (current !== null && current !== this.lastText) {
					const remote = await this.expand(parseDataText(current));
					base = mergeData(this.data, remote);
				}
				const next = structuredClone(base);
				change(next);
				const out = await this.encode(next);
				if (!file) {
					this.pendingText = out;
					await this.ensureFolder(this.folder);
					await vault.create(this.path, out);
				} else {
					let changed = false;
					await vault.process(file, (now) => {
						if (now !== current) {
							changed = true;
							return now;
						}
						this.pendingText = out;
						return out;
					});
					if (changed) {
						continue;
					}
				}
				this.data = next;
				this.lastText = out;
				this.pendingText = null;
				return;
			}
			this.pendingText = null;
			throw new Error('The data file keeps changing');
		});
	}

	/** Merges in a version of the file changed by another device. Returns true if the data changed. */
	reloadFromDisk(): Promise<boolean> {
		return this.enqueue(async () => {
			const file = this.app.vault.getFileByPath(this.path);
			if (!file) {
				return false;
			}
			const text = await this.app.vault.read(file);
			if (text === this.lastText || text === this.pendingText) {
				return false;
			}
			const remote = await this.expand(parseDataText(text));
			this.data = this.broken ? remote : mergeData(this.data, remote);
			this.broken = false;
			// Memory may now differ from disk; the next write sees `lastText` unchanged and saves the merge.
			this.lastText = text;
			return true;
		});
	}

	// ---------- Password ----------

	/** Sets the password for private lists for the first time and opens them. */
	async setPassword(password: string): Promise<void> {
		if (this.data.secret) {
			throw new Error('A password is already set');
		}
		const secret = await this.newSecret(password);
		await this.update((data) => {
			data.secret = secret.info;
		});
		this.key = secret.key;
		this.keyChangedAt = secret.info.changedAt;
	}

	/** Opens private lists. Throws WrongPasswordError. */
	unlock(password: string): Promise<void> {
		return this.enqueue(async () => {
			const secret = this.data.secret;
			if (!secret) {
				throw new Error('No password is set');
			}
			const key = await this.checkPassword(password, secret);
			this.key = key;
			this.keyChangedAt = secret.changedAt;
			this.data = await this.expand(this.data);
		});
	}

	/** Closes private lists: their contents leave memory. */
	lock(): Promise<void> {
		return this.enqueue(async () => {
			this.forgetKey();
			this.data = this.collapse(this.data);
		});
	}

	/** Re-encrypts private lists with a new password. Throws WrongPasswordError. */
	async changePassword(oldPassword: string, newPassword: string): Promise<void> {
		const secret = this.data.secret;
		if (!secret) {
			throw new Error('No password is set');
		}
		if (this.key) {
			await this.checkPassword(oldPassword, secret);
		} else {
			await this.unlock(oldPassword);
		}
		const next = await this.newSecret(newPassword);
		const previous = { key: this.key, changedAt: this.keyChangedAt };
		this.key = next.key;
		this.keyChangedAt = next.info.changedAt;
		this.sealCache.clear();
		try {
			await this.update((data) => {
				data.secret = next.info;
			});
		} catch (err) {
			this.key = previous.key;
			this.keyChangedAt = previous.changedAt;
			throw err;
		}
	}

	private async newSecret(password: string): Promise<{ key: CryptoKey; info: SecretInfo }> {
		const kdf = newKdfParams(this.kdfIterations);
		const key = await deriveKey(password, kdf);
		const sealed = await seal(key, CHECK_TEXT, CHECK_AAD);
		return { key, info: { kdf, check: sealed, changedAt: Date.now() } };
	}

	private async checkPassword(password: string, secret: SecretInfo): Promise<CryptoKey> {
		const key = await deriveKey(password, secret.kdf);
		try {
			if ((await unseal(key, secret.check, CHECK_AAD)) === CHECK_TEXT) {
				return key;
			}
		} catch {
			// Wrong key: GCM authentication fails.
		}
		throw new WrongPasswordError();
	}

	private forgetKey(): void {
		this.key = null;
		this.keyChangedAt = null;
		this.sealCache.clear();
	}

	// ---------- Encryption ----------

	/** Removes the contents of private lists from `data` (the lists themselves stay, with their blobs). */
	private collapse(data: QuestsData): QuestsData {
		const hiddenLists = new Set<string>();
		const hiddenTasks = new Set<string>();
		for (const root of privateRoots(data.lists)) {
			for (const id of descendantIds(data.lists, root.id)) {
				hiddenTasks.add(id);
				if (id !== root.id) {
					hiddenLists.add(id);
				}
			}
		}
		return {
			...data,
			lists: data.lists.filter((list) => !hiddenLists.has(list.id)),
			tasks: data.tasks.filter((task) => !hiddenTasks.has(task.listId)),
		};
	}

	/**
	 * Adds the decrypted contents of private lists. Without a key, or for a blob that does not decrypt,
	 * the list stays closed. A password changed on another device locks this one.
	 */
	private async expand(data: QuestsData): Promise<QuestsData> {
		if (!this.key) {
			return data;
		}
		if (!data.secret || data.secret.changedAt !== this.keyChangedAt) {
			this.forgetKey();
			this.data = this.collapse(this.data);
			this.onExternalLock?.();
			return data;
		}
		const listIds = new Set(data.lists.map((list) => list.id));
		const taskIds = new Set(data.tasks.map((task) => task.id));
		for (const root of privateRoots(data.lists)) {
			if (!root.sealed) {
				continue;
			}
			try {
				const plain = await unseal(this.key, root.sealed, sealAad(root.id));
				this.sealCache.set(root.id, { plain, blob: root.sealed });
				const contents = parseSealedContents(JSON.parse(plain));
				data.lists.push(...contents.lists.filter((list) => !listIds.has(list.id)));
				data.tasks.push(...contents.tasks.filter((task) => !taskIds.has(task.id)));
			} catch (err) {
				console.warn('Quests List: a private list could not be decrypted', root.id, err);
			}
		}
		return data;
	}

	/** File text for `data`: private contents are sealed into their lists. Updates the blobs in `data`. */
	private async encode(data: QuestsData): Promise<string> {
		const roots = privateRoots(data.lists);
		const rootIds = new Set(roots.map((root) => root.id));
		const hiddenLists = new Set<string>();
		const hiddenTasks = new Set<string>();
		for (const root of roots) {
			for (const id of descendantIds(data.lists, root.id)) {
				hiddenTasks.add(id);
				if (id !== root.id) {
					hiddenLists.add(id);
				}
			}
		}
		const key = this.key;
		if (!key && (data.lists.some((l) => hiddenLists.has(l.id)) || data.tasks.some((t) => hiddenTasks.has(t.listId)))) {
			// Would write private tasks in plain text, or drop them.
			throw new LockedError();
		}
		if (key) {
			for (const root of roots) {
				const scope = descendantIds(data.lists, root.id);
				const plain = JSON.stringify({
					lists: data.lists.filter((l) => scope.has(l.id) && l.id !== root.id).map((l) => ({ ...l, sealed: null })),
					tasks: data.tasks.filter((t) => scope.has(t.listId)),
				});
				const cached = this.sealCache.get(root.id);
				const blob = cached && cached.plain === plain ? cached.blob : await seal(key, plain, sealAad(root.id));
				this.sealCache.set(root.id, { plain, blob });
				if (root.sealed?.iv !== blob.iv) {
					root.sealed = blob;
					// The newest blob must win a merge with an older copy of this list.
					root.updatedAt = Math.max(Date.now(), root.updatedAt + 1);
				}
			}
		}
		for (const list of data.lists) {
			if (!rootIds.has(list.id) && list.sealed) {
				list.sealed = null;
			}
		}
		return serializeData({
			...data,
			lists: data.lists.filter((list) => !hiddenLists.has(list.id)),
			tasks: data.tasks.filter((task) => !hiddenTasks.has(task.listId)),
		});
	}

	async ensureFolder(path: string): Promise<void> {
		const vault = this.app.vault;
		let current = '';
		for (const part of normalizePath(path).split('/')) {
			current = current ? `${current}/${part}` : part;
			const existing = vault.getAbstractFileByPath(current);
			if (!existing) {
				await vault.createFolder(current);
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`Not a folder: ${current}`);
			}
		}
	}
}
