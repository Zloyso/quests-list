/** In-memory vault and workspace for tests. */
import { type TAbstractFile, TFile, TFolder } from './obsidian-stub';

type Listener = (...args: unknown[]) => unknown;

export interface FakeLeaf {
	app: FakeApp;
	type: string | null;
	view: { onOpen(): Promise<void> } | null;
	setViewState(state: { type: string }): Promise<void>;
}

export type FakeApp = ReturnType<typeof createApp>;

export function createApp() {
	const files = new Map<string, { file: TFile; text: string }>();
	const folders = new Map<string, TFolder>();
	const listeners: Record<string, Listener[]> = {};
	const emit = (name: string, ...args: unknown[]) => {
		for (const cb of listeners[name] ?? []) {
			void cb(...args);
		}
	};
	const leaves: FakeLeaf[] = [];
	const opened: string[] = [];
	let viewFactory: (type: string, leaf: FakeLeaf) => FakeLeaf['view'] = () => null;

	const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
	/** Folders exist when created explicitly or when a file is inside them. */
	const folderPaths = () => {
		const result = new Set(folders.keys());
		for (const path of files.keys()) {
			for (let dir = dirname(path); dir; dir = dirname(dir)) result.add(dir);
		}
		return result;
	};
	const folderAt = (path: string): TFolder => {
		const folder = new TFolder(path);
		Object.defineProperty(folder, 'children', {
			get: () => [
				...[...folderPaths()].filter((p) => p !== path && dirname(p) === path).map((p) => folderAt(p)),
				...[...files.values()].filter((e) => dirname(e.file.path) === path).map((e) => e.file),
			],
		});
		Object.defineProperty(folder, 'parent', { get: () => (path ? folderAt(dirname(path)) : null) });
		return folder;
	};
	const makeFile = (path: string): TFile => {
		const file = new TFile(path);
		Object.defineProperty(file, 'parent', { get: () => folderAt(dirname(file.path)) });
		return file;
	};
	/** Moves a file or folder like Obsidian: "rename" for every moved file, then for the folder. */
	const moveTree = (oldPath: string, newPath: string) => {
		const moved: [TFile, string][] = [];
		for (const [path, entry] of [...files]) {
			if (path === oldPath || path.startsWith(`${oldPath}/`)) {
				files.delete(path);
				entry.file.path = newPath + path.slice(oldPath.length);
				files.set(entry.file.path, entry);
				moved.push([entry.file, path]);
			}
		}
		const wasFolder = folderPaths().has(newPath) || [...folders.keys()].some((p) => p === oldPath || p.startsWith(`${oldPath}/`));
		for (const path of [...folders.keys()]) {
			if (path === oldPath || path.startsWith(`${oldPath}/`)) {
				folders.delete(path);
				folders.set(newPath + path.slice(oldPath.length), new TFolder(newPath + path.slice(oldPath.length)));
			}
		}
		for (const [file, old] of moved) emit('rename', file, old);
		if (wasFolder && !(moved.length === 1 && moved[0]![1] === oldPath)) emit('rename', folderAt(newPath), oldPath);
	};

	const vault = {
		getFileByPath: (path: string) => files.get(path)?.file ?? null,
		getFolderByPath: (path: string) => (folderPaths().has(path) ? folderAt(path) : null),
		getAllFolders: () => [...folderPaths()].map((p) => folderAt(p)),
		getAbstractFileByPath: (path: string): TAbstractFile | null =>
			files.get(path)?.file ?? (folderPaths().has(path) ? folderAt(path) : null),
		read: async (file: TFile) => files.get(file.path)?.text ?? '',
		cachedRead: async (file: TFile) => files.get(file.path)?.text ?? '',
		async process(file: TFile, fn: (text: string) => string) {
			const entry = files.get(file.path);
			if (!entry) throw new Error('missing');
			const out = fn(entry.text);
			entry.text = out;
			emit('modify', entry.file);
			return out;
		},
		async create(path: string, text: string) {
			if (files.has(path)) throw new Error('exists');
			const file = makeFile(path);
			files.set(path, { file, text });
			emit('create', file);
			return file;
		},
		async createFolder(path: string) {
			folders.set(path, new TFolder(path));
		},
		async createBinary(path: string) {
			const file = makeFile(path);
			files.set(path, { file, text: '[binary]' });
			return file;
		},
		getFiles: () => [...files.values()].map((e) => e.file),
		getResourcePath: (file: TFile) => `app://${file.path}`,
		on(name: string, cb: Listener) {
			(listeners[name] ??= []).push(cb);
			return {};
		},
	};

	const workspace = {
		layoutReady: true,
		onLayoutReady: (cb: () => unknown) => void cb(),
		getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.type === type),
		requestSaveLayout() {},
		trigger() {},
		async openLinkText(path: string) {
			opened.push(path);
		},
		getLeaf(): FakeLeaf {
			const leaf: FakeLeaf = {
				app,
				type: null,
				view: null,
				async setViewState(state) {
					leaf.type = state.type;
					leaf.view = viewFactory(state.type, leaf);
					await leaf.view?.onOpen();
				},
			};
			leaves.push(leaf);
			return leaf;
		},
		async revealLeaf() {},
	};

	const app = {
		vault,
		workspace,
		fileManager: {
			async trashFile(item: TAbstractFile) {
				files.delete(item.path);
				for (const path of [...files.keys()]) if (path.startsWith(`${item.path}/`)) files.delete(path);
				for (const path of [...folders.keys()]) if (path === item.path || path.startsWith(`${item.path}/`)) folders.delete(path);
			},
			async renameFile(item: TAbstractFile, newPath: string) {
				if (files.has(newPath) || folderPaths().has(newPath)) throw new Error('exists');
				moveTree(item.path, newPath);
			},
		},
		// Test helpers
		files,
		opened,
		setViewFactory(factory: typeof viewFactory) {
			viewFactory = factory;
		},
		/** A change made by another device (sync). */
		externalWrite(path: string, text: string) {
			const entry = files.get(path);
			if (entry) {
				entry.text = text;
				emit('modify', entry.file);
			} else {
				const file = makeFile(path);
				files.set(path, { file, text });
				emit('create', file);
			}
		},
		/** A file or folder moved in the file explorer. */
		rename(oldPath: string, newPath: string) {
			moveTree(oldPath, newPath);
		},
	};
	return app;
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
