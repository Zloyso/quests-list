import type { KdfParams } from './crypto';
import { addDays, datePart, isValidDateValue, todayStr } from './dates';

export const LIST_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'] as const;
export type ListColor = (typeof LIST_COLORS)[number];

export type TaskSort = 'manual' | 'start' | 'end' | 'title' | 'created';
export const TASK_SORTS: TaskSort[] = ['manual', 'start', 'end', 'title', 'created'];

export interface TaskList {
	id: string;
	name: string;
	color: ListColor | null;
	/** Obsidian (Lucide) icon id; null = the default list icon. */
	icon: string | null;
	/** Enclosing list; null = top level. */
	parentId: string | null;
	/** Private: its tasks and nested lists are stored encrypted and shown only after the password is entered. */
	private: boolean;
	/** Encrypted contents of a private list, as last saved. */
	sealed: SealedBlob | null;
	order: number;
	sort: TaskSort;
	createdAt: number;
	updatedAt: number;
}

export interface Task {
	id: string;
	listId: string;
	title: string;
	/** Markdown; [[links]] work like in notes. */
	notes: string;
	/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", local time; null = no start date. Both dates are optional. */
	start: string | null;
	end: string | null;
	done: boolean;
	doneAt: number | null;
	/** Vault paths of attached files. */
	attachments: string[];
	/** Vault paths of linked notes. */
	links: string[];
	order: number;
	createdAt: number;
	updatedAt: number;
}

export interface QuestsData {
	lists: TaskList[];
	tasks: Task[];
	/** Ids of removed lists and tasks with removal time, so a sync merge does not bring them back. */
	deleted: Record<string, number>;
	/** Password parameters for private lists; null until a password is set. */
	secret: SecretInfo | null;
}

export interface SealedBlob {
	iv: string;
	data: string;
}

export interface SecretInfo {
	kdf: KdfParams;
	/** A known text sealed with the key, to check the password. */
	check: SealedBlob;
	/** When the password was set or changed; another value on disk means it changed on another device. */
	changedAt: number;
}

export type TaskFilter = { kind: 'all' } | { kind: 'today' } | { kind: 'upcoming' } | { kind: 'list'; id: string };

/** Tombstones older than this are dropped. */
const TOMBSTONE_TTL = 180 * 86_400_000;

export function emptyData(): QuestsData {
	return { lists: [], tasks: [], deleted: {}, secret: null };
}

/** 20 hex characters. Hex keeps ids valid as Google Calendar event ids and in file names. */
export function newId(): string {
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const DEFAULT_LIST_ICON = 'list';

export function listIcon(list: Pick<TaskList, 'icon'>): string {
	return list.icon ?? DEFAULT_LIST_ICON;
}

export function createList(name: string, order: number, parentId: string | null = null): TaskList {
	const now = Date.now();
	return {
		id: newId(),
		name,
		color: null,
		icon: null,
		parentId,
		private: false,
		sealed: null,
		order,
		sort: 'manual',
		createdAt: now,
		updatedAt: now,
	};
}

export function createTask(fields: Partial<Task> & { listId: string; title: string }): Task {
	const now = Date.now();
	return {
		id: newId(),
		notes: '',
		start: null,
		end: null,
		done: false,
		doneAt: null,
		attachments: [],
		links: [],
		order: 0,
		createdAt: now,
		updatedAt: now,
		...fields,
	};
}

export function nextOrder(items: { order: number }[]): number {
	return items.reduce((max, item) => Math.max(max, item.order), 0) + 1;
}

export function firstOrder(items: { order: number }[]): number {
	return items.reduce((min, item) => Math.min(min, item.order), 1) - 1;
}

/**
 * Moves `id` so that it comes right before `beforeId` (or last when null) in `sorted`.
 * Only the moved item gets a new order unless there is no room left, then all are renumbered.
 * Returns the ids whose order changed.
 */
export function reorder<T extends { id: string; order: number }>(sorted: T[], id: string, beforeId: string | null): string[] {
	const moving = sorted.find((item) => item.id === id);
	if (!moving || id === beforeId) {
		return [];
	}
	const rest = sorted.filter((item) => item.id !== id);
	const index = beforeId === null ? rest.length : rest.findIndex((item) => item.id === beforeId);
	if (index < 0 || index === sorted.indexOf(moving)) {
		return [];
	}
	return placeItem(rest, moving, beforeId);
}

/**
 * Gives `moving` an order that puts it before `beforeId` (or last when null) among `others`, which are sorted
 * and do not include it. Renumbers everything only when there is no room. Returns the ids whose order changed.
 */
export function placeItem<T extends { id: string; order: number }>(others: T[], moving: T, beforeId: string | null): string[] {
	const found = beforeId === null ? -1 : others.findIndex((item) => item.id === beforeId);
	const index = found < 0 ? others.length : found;
	const prev = others[index - 1];
	const next = others[index];
	let order: number | null;
	if (prev && next) {
		order = (prev.order + next.order) / 2;
		if (!(order > prev.order && order < next.order)) {
			order = null;
		}
	} else if (prev) {
		order = prev.order + 1;
	} else if (next) {
		order = next.order - 1;
	} else {
		order = 0;
	}
	if (order !== null) {
		moving.order = order;
		return [moving.id];
	}
	const all = [...others];
	all.splice(index, 0, moving);
	all.forEach((item, i) => {
		item.order = i + 1;
	});
	return all.map((item) => item.id);
}

const collator = () => new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function sortLists(lists: TaskList[], byName: boolean): TaskList[] {
	const c = collator();
	return [...lists].sort((a, b) => (byName ? c.compare(a.name, b.name) : 0) || a.order - b.order || a.createdAt - b.createdAt);
}

export function sortTasks(tasks: Task[], sort: TaskSort, listOrder?: Map<string, number>): Task[] {
	const c = collator();
	const manual = (a: Task, b: Task) =>
		(listOrder ? (listOrder.get(a.listId) ?? 0) - (listOrder.get(b.listId) ?? 0) : 0) ||
		a.order - b.order ||
		a.createdAt - b.createdAt;
	const compare: Record<TaskSort, (a: Task, b: Task) => number> = {
		manual,
		// Tasks without the date go last.
		start: (a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999') || manual(a, b),
		end: (a, b) =>
			(a.end ?? '9999').localeCompare(b.end ?? '9999') || (a.start ?? '9999').localeCompare(b.start ?? '9999') || manual(a, b),
		title: (a, b) => c.compare(a.title, b.title) || manual(a, b),
		created: (a, b) => b.createdAt - a.createdAt,
	};
	return [...tasks].sort(compare[sort]);
}

export function sameFilter(a: TaskFilter, b: TaskFilter): boolean {
	return a.kind === b.kind && (a.kind !== 'list' || (b.kind === 'list' && a.id === b.id));
}

export function hasDates(task: Pick<Task, 'start' | 'end'>): boolean {
	return task.start !== null || task.end !== null;
}

/** First day the task is active ("YYYY-MM-DD"): its start, or its due date when there is no start. Null without dates. */
export function firstDay(task: Pick<Task, 'start' | 'end'>): string | null {
	const value = task.start ?? task.end;
	return value ? datePart(value) : null;
}

/** Last day the task is active ("YYYY-MM-DD"). Null without dates. */
export function lastDay(task: Pick<Task, 'start' | 'end'>): string | null {
	const first = firstDay(task);
	if (!first) {
		return null;
	}
	const end = task.end ? datePart(task.end) : first;
	return end < first ? first : end;
}

export function isOverdue(task: Task, today = todayStr()): boolean {
	return !task.done && task.end !== null && datePart(task.end) < today;
}

/** Open tasks that have started (or are due) by today, including overdue ones. Tasks without dates are not here. */
export function isForToday(task: Task, today = todayStr()): boolean {
	const first = firstDay(task);
	return !task.done && first !== null && first <= today;
}

export const UPCOMING_DAYS = 7;

export function isUpcoming(task: Task, today = todayStr()): boolean {
	const first = firstDay(task);
	return !task.done && first !== null && first > today && first <= addDays(today, UPCOMING_DAYS);
}

export function matchesFilter(task: Task, filter: TaskFilter, today = todayStr()): boolean {
	switch (filter.kind) {
		case 'all':
			return true;
		case 'today':
			return isForToday(task, today);
		case 'upcoming':
			return isUpcoming(task, today);
		case 'list':
			return task.listId === filter.id;
	}
}

export function matchesQuery(task: Task, query: string): boolean {
	const q = query.trim().toLocaleLowerCase();
	if (!q) {
		return true;
	}
	return [task.title, task.notes, ...task.links, ...task.attachments].some((text) => text.toLocaleLowerCase().includes(q));
}

/** True when the task covers `date` ("YYYY-MM-DD"). */
export function coversDate(task: Task, date: string): boolean {
	const first = firstDay(task);
	const last = lastDay(task);
	return first !== null && last !== null && first <= date && date <= last;
}

export function removeTask(data: QuestsData, id: string): void {
	data.tasks = data.tasks.filter((task) => task.id !== id);
	data.deleted[id] = Date.now();
}

/** Removes a list together with its nested lists and all their tasks. */
export function removeList(data: QuestsData, id: string): void {
	const now = Date.now();
	const ids = descendantIds(data.lists, id);
	for (const task of data.tasks) {
		if (ids.has(task.listId)) {
			data.deleted[task.id] = now;
		}
	}
	data.tasks = data.tasks.filter((task) => !ids.has(task.listId));
	data.lists = data.lists.filter((list) => !ids.has(list.id));
	for (const listId of ids) {
		data.deleted[listId] = now;
	}
}

// ---------- Nested lists ----------

/** Parent of every list. A missing parent or a loop (possible after a sync merge) counts as top level. */
export function resolveParents(lists: TaskList[]): Map<string, string | null> {
	const ids = new Set(lists.map((list) => list.id));
	const raw = new Map<string, string | null>(
		lists.map((list) => [list.id, list.parentId && list.parentId !== list.id && ids.has(list.parentId) ? list.parentId : null]),
	);
	const result = new Map<string, string | null>();
	for (const list of lists) {
		const seen = new Set([list.id]);
		let parent = raw.get(list.id) ?? null;
		let loop = false;
		while (parent) {
			if (seen.has(parent)) {
				loop = true;
				break;
			}
			seen.add(parent);
			parent = raw.get(parent) ?? null;
		}
		result.set(list.id, loop ? null : (raw.get(list.id) ?? null));
	}
	return result;
}

export interface ListNode {
	list: TaskList;
	depth: number;
	parentId: string | null;
	hasChildren: boolean;
}

/** Lists in display order: each list followed by its nested lists. */
export function listTree(lists: TaskList[], byName: boolean): ListNode[] {
	const parents = resolveParents(lists);
	const children = new Map<string | null, TaskList[]>();
	for (const list of lists) {
		const parentId = parents.get(list.id) ?? null;
		children.set(parentId, [...(children.get(parentId) ?? []), list]);
	}
	const result: ListNode[] = [];
	const visit = (parentId: string | null, depth: number) => {
		for (const list of sortLists(children.get(parentId) ?? [], byName)) {
			result.push({ list, depth, parentId, hasChildren: (children.get(list.id)?.length ?? 0) > 0 });
			visit(list.id, depth + 1);
		}
	};
	visit(null, 0);
	return result;
}

/** The list and everything nested in it. */
export function descendantIds(lists: TaskList[], id: string): Set<string> {
	const parents = resolveParents(lists);
	const result = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const list of lists) {
			const parentId = parents.get(list.id);
			if (parentId && result.has(parentId) && !result.has(list.id)) {
				result.add(list.id);
				grew = true;
			}
		}
	}
	return result;
}

/** Names from the top level down to the list. */
export function listPath(lists: TaskList[], id: string): string[] {
	const parents = resolveParents(lists);
	const byId = new Map(lists.map((list) => [list.id, list]));
	const path: string[] = [];
	for (let current: string | null = id; current; current = parents.get(current) ?? null) {
		const list = byId.get(current);
		if (!list) {
			break;
		}
		path.unshift(list.name);
	}
	return path;
}

/**
 * Puts a list inside `parentId` (null = top level), before `beforeId` among its new siblings or last.
 * Moving a list into itself or into its own nested list is ignored. Returns true if anything changed.
 */
export function moveList(data: QuestsData, id: string, parentId: string | null, beforeId: string | null): boolean {
	const list = data.lists.find((item) => item.id === id);
	if (!list || (parentId !== null && descendantIds(data.lists, id).has(parentId))) {
		return false;
	}
	const parents = resolveParents(data.lists);
	const now = Date.now();
	const siblings = sortLists(
		data.lists.filter((item) => item.id !== id && (parents.get(item.id) ?? null) === parentId),
		false,
	);
	list.parentId = parentId;
	list.updatedAt = now;
	for (const changed of placeItem(siblings, list, beforeId)) {
		const item = data.lists.find((l) => l.id === changed);
		if (item) {
			item.updatedAt = now;
		}
	}
	return true;
}

/** Replaces `oldPath` (a file or a folder) with `newPath` in attachments and links. Returns true if anything changed. */
export function renamePaths(data: QuestsData, oldPath: string, newPath: string): boolean {
	const rename = (path: string) =>
		path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
	let changed = false;
	for (const task of data.tasks) {
		const attachments = task.attachments.map(rename);
		const links = task.links.map(rename);
		if (attachments.some((p, i) => p !== task.attachments[i]) || links.some((p, i) => p !== task.links[i])) {
			task.attachments = attachments;
			task.links = links;
			task.updatedAt = Date.now();
			changed = true;
		}
	}
	return changed;
}

/**
 * Combines two copies of the data (e.g. this device and a synced file).
 * Per item, the newer `updatedAt` wins; removals win over older edits.
 */
export function mergeData(local: QuestsData, remote: QuestsData, now = Date.now()): QuestsData {
	const deleted: Record<string, number> = {};
	for (const source of [local.deleted, remote.deleted]) {
		for (const [id, at] of Object.entries(source)) {
			if (now - at < TOMBSTONE_TTL && at > (deleted[id] ?? 0)) {
				deleted[id] = at;
			}
		}
	}
	const pick = <T extends { id: string; updatedAt: number }>(a: T[], b: T[]): T[] => {
		const byId = new Map<string, T>();
		for (const item of [...a, ...b]) {
			const current = byId.get(item.id);
			if (!current || item.updatedAt > current.updatedAt) {
				byId.set(item.id, item);
			}
		}
		return [...byId.values()].filter((item) => {
			const removedAt = deleted[item.id];
			if (removedAt === undefined) {
				return true;
			}
			if (item.updatedAt > removedAt) {
				// Edited after removal elsewhere: keep it.
				delete deleted[item.id];
				return true;
			}
			return false;
		});
	};
	const lists = pick(local.lists, remote.lists);
	const listIds = new Set(lists.map((list) => list.id));
	const tasks = pick(local.tasks, remote.tasks).filter((task) => listIds.has(task.listId));
	const secret =
		local.secret && remote.secret ? (remote.secret.changedAt > local.secret.changedAt ? remote.secret : local.secret) : (local.secret ?? remote.secret);
	return { lists, tasks, deleted, secret };
}

// ---------- Private lists ----------

/** Private lists that are not inside another private list: each one is encrypted as a whole. */
export function privateRoots(lists: TaskList[]): TaskList[] {
	const parents = resolveParents(lists);
	const byId = new Map(lists.map((list) => [list.id, list]));
	return lists.filter((list) => {
		if (!list.private) {
			return false;
		}
		for (let p = parents.get(list.id) ?? null; p; p = parents.get(p) ?? null) {
			if (byId.get(p)?.private) {
				return false;
			}
		}
		return true;
	});
}

/** Ids of all lists that are private or inside a private list. */
export function privateScope(lists: TaskList[]): Set<string> {
	const result = new Set<string>();
	for (const root of privateRoots(lists)) {
		for (const id of descendantIds(lists, root.id)) {
			result.add(id);
		}
	}
	return result;
}

/** The private list that `id` belongs to (itself or an ancestor), if any. */
export function privateRootOf(lists: TaskList[], id: string): TaskList | null {
	const parents = resolveParents(lists);
	const byId = new Map(lists.map((list) => [list.id, list]));
	let root: TaskList | null = null;
	for (let current: string | null = id; current; current = parents.get(current) ?? null) {
		const list = byId.get(current);
		if (list?.private) {
			root = list;
		}
	}
	return root;
}

// ---------- Parsing stored data ----------

const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const strArray = (value: unknown) =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
const obj = (value: unknown) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null);

function parseList(raw: unknown): TaskList | null {
	const o = obj(raw);
	if (!o || typeof o.id !== 'string' || !o.id) {
		return null;
	}
	return {
		id: o.id,
		name: str(o.name).trim() || '—',
		color: LIST_COLORS.includes(o.color as ListColor) ? (o.color as ListColor) : null,
		icon: typeof o.icon === 'string' && o.icon ? o.icon : null,
		parentId: typeof o.parentId === 'string' && o.parentId ? o.parentId : null,
		private: o.private === true,
		sealed: parseSealed(o.sealed),
		order: num(o.order),
		sort: TASK_SORTS.includes(o.sort as TaskSort) ? (o.sort as TaskSort) : 'manual',
		createdAt: num(o.createdAt),
		updatedAt: num(o.updatedAt),
	};
}

function parseTask(raw: unknown): Task | null {
	const o = obj(raw);
	if (!o || typeof o.id !== 'string' || !o.id || typeof o.listId !== 'string') {
		return null;
	}
	const createdAt = num(o.createdAt);
	return {
		id: o.id,
		listId: o.listId,
		title: str(o.title),
		notes: str(o.notes),
		start: isValidDateValue(o.start) ? o.start : null,
		end: isValidDateValue(o.end) ? o.end : null,
		done: o.done === true,
		doneAt: typeof o.doneAt === 'number' ? o.doneAt : null,
		attachments: strArray(o.attachments),
		links: strArray(o.links),
		order: num(o.order),
		createdAt,
		updatedAt: num(o.updatedAt),
	};
}

/** Builds valid data from parsed JSON, dropping malformed items. */
export function parseData(raw: unknown): QuestsData {
	const o = obj(raw) ?? {};
	const lists = (Array.isArray(o.lists) ? o.lists : []).map(parseList).filter((l): l is TaskList => l !== null);
	const listIds = new Set(lists.map((list) => list.id));
	const tasks = (Array.isArray(o.tasks) ? o.tasks : [])
		.map(parseTask)
		.filter((t): t is Task => t !== null && listIds.has(t.listId));
	const deleted: Record<string, number> = {};
	for (const [id, at] of Object.entries(obj(o.deleted) ?? {})) {
		if (typeof at === 'number') {
			deleted[id] = at;
		}
	}
	return { lists, tasks, deleted, secret: parseSecret(o.secret) };
}

function parseSealed(raw: unknown): SealedBlob | null {
	const o = obj(raw);
	return o && typeof o.iv === 'string' && typeof o.data === 'string' ? { iv: o.iv, data: o.data } : null;
}

function parseSecret(raw: unknown): SecretInfo | null {
	const o = obj(raw);
	const kdf = obj(o?.kdf);
	const check = parseSealed(o?.check);
	if (!o || !kdf || !check || typeof kdf.salt !== 'string' || typeof kdf.iterations !== 'number') {
		return null;
	}
	return {
		kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt: kdf.salt },
		check,
		changedAt: num(o.changedAt),
	};
}

/** Lists and tasks from a decrypted private list, validated like the rest of the file. */
export function parseSealedContents(raw: unknown): { lists: TaskList[]; tasks: Task[] } {
	const o = obj(raw) ?? {};
	return {
		lists: (Array.isArray(o.lists) ? o.lists : []).map(parseList).filter((l): l is TaskList => l !== null),
		tasks: (Array.isArray(o.tasks) ? o.tasks : []).map(parseTask).filter((t): t is Task => t !== null),
	};
}
