import { normalizePath, Notice, Plugin, type TAbstractFile, TFolder, type WorkspaceLeaf } from 'obsidian';
import { setLanguage, t } from './i18n';
import { createList, createTask, listTree, nextOrder, type QuestsData, renamePaths, type Task } from './model';
import { DEFAULT_SETTINGS, parseSettings, type QuestsSettings } from './settings';
import { DATA_FILE_NAME, DataFormatError, LockedError, parseDataText, QuestsStore } from './store';
import { type SyncReport, SyncEngine } from './sync/engine';
import { supportsPush } from './sync/types';
import { describeSyncError } from './ui/account-modal';
import { CalendarView, VIEW_TYPE_CALENDAR } from './ui/calendar-view';
import { confirmAction } from './ui/modals';
import { ChangePasswordModal, CreatePasswordModal, UnlockModal } from './ui/password-modals';
import { QuestsSettingTab } from './ui/settings-tab';
import { TasksView, VIEW_TYPE_TASKS } from './ui/tasks-view';

/** Local changes are sent to calendars after this pause. */
const PUSH_DELAY = 10_000;

export default class QuestsPlugin extends Plugin {
	settings: QuestsSettings = DEFAULT_SETTINGS;
	store!: QuestsStore;
	sync!: SyncEngine;
	private syncTimer = 0;
	private pushTimer = 0;
	/** Set while the plugin moves its own folder, so the resulting vault events are not handled twice. */
	private movingFolder = false;
	private lastActivity = Date.now();

	async onload(): Promise<void> {
		this.settings = parseSettings(await this.loadData());
		setLanguage(this.settings.language);
		this.store = new QuestsStore(this.app, () => this.settings.folder);
		this.store.onExternalLock = () => {
			new Notice(t('privateLockedElsewhere'), 8000);
			window.setTimeout(() => this.refreshViews(), 0);
		};
		this.sync = new SyncEngine({
			getSettings: () => this.settings,
			getData: () => this.store.data,
			saveSettings: () => this.saveSettings(),
			updateData: (change) => this.updateData(change),
			untitled: () => t('untitled'),
			onSyncStateChange: () => this.refreshViews(),
		});

		this.registerView(VIEW_TYPE_TASKS, (leaf) => new TasksView(leaf, this));
		this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf, this));
		this.addRibbonIcon('list-checks', t('openTasks'), () => void this.openTasks());
		this.addRibbonIcon('calendar-days', t('openCalendar'), () => void this.openCalendar());

		this.addCommand({ id: 'open', name: t('commandOpen'), callback: () => void this.openTasks() });
		this.addCommand({ id: 'open-calendar', name: t('commandOpenCalendar'), callback: () => void this.openCalendar() });
		this.addCommand({
			id: 'new-task',
			name: t('commandNewTask'),
			callback: async () => {
				const view = await this.openTasks();
				await view?.newTask();
			},
		});
		this.addCommand({
			id: 'sync',
			name: t('commandSync'),
			checkCallback: (checking) => {
				if (!this.settings.accounts.some((a) => a.enabled)) {
					return false;
				}
				if (!checking) {
					void this.syncNow(true);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'unlock-private',
			name: t('commandUnlockPrivate'),
			checkCallback: (checking) => {
				if (!this.store.locked) {
					return false;
				}
				if (!checking) {
					void this.unlockPrivate();
				}
				return true;
			},
		});
		this.addCommand({
			id: 'lock-private',
			name: t('commandLockPrivate'),
			checkCallback: (checking) => {
				if (!this.store.unlocked) {
					return false;
				}
				if (!checking) {
					void this.lockPrivate();
				}
				return true;
			},
		});

		this.addSettingTab(new QuestsSettingTab(this.app, this));
		this.register(() => {
			window.clearInterval(this.syncTimer);
			window.clearTimeout(this.pushTimer);
		});
		this.registerInterval(window.setInterval(() => this.checkAutoLock(), 15_000));
		this.registerDomEvent(document, 'visibilitychange', () => {
			// Timers may pause in the background on mobile; check right away.
			if (document.visibilityState === 'visible') {
				this.checkAutoLock();
			}
		});

		this.app.workspace.onLayoutReady(async () => {
			await this.reloadData(true);
			this.registerEvent(this.app.vault.on('modify', (file) => void this.onFileChanged(file)));
			this.registerEvent(this.app.vault.on('create', (file) => void this.onFileChanged(file)));
			this.registerEvent(this.app.vault.on('rename', (file, oldPath) => void this.onFileRenamed(file, oldPath)));
			this.scheduleSync();
			if (this.settings.accounts.some((a) => a.enabled)) {
				window.setTimeout(() => void this.syncNow(false), 3000);
			}
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * (Re)reads the data file. At startup, if there is no file in the configured folder but exactly one
	 * Quests List file elsewhere (the folder was moved on another device), switches to that folder.
	 */
	async reloadData(locate = false): Promise<void> {
		if (locate && !this.app.vault.getFileByPath(this.store.path)) {
			await this.locateDataFolder();
		}
		try {
			await this.store.load();
		} catch (err) {
			console.error('Quests List: cannot read data', err);
			new Notice(t('dataDamaged', { path: this.store.path }), 10_000);
		}
		this.refreshViews();
	}

	private async locateDataFolder(): Promise<void> {
		const found: string[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (file.name !== DATA_FILE_NAME || !file.parent || file.parent.isRoot()) {
				continue;
			}
			try {
				parseDataText(await this.app.vault.cachedRead(file));
				found.push(file.parent.path);
			} catch {
				// Some other quests.json.
			}
		}
		if (found.length === 1 && found[0]) {
			this.settings.folder = found[0];
			await this.saveSettings();
			new Notice(t('dataFound', { folder: found[0] }), 8000);
		}
	}

	/**
	 * Moves the data folder (tasks and attachments) to `target`. If `target` already holds a task file,
	 * offers to switch to it instead. Returns true when the plugin now uses `target`.
	 */
	async moveDataFolder(target: string): Promise<boolean> {
		const vault = this.app.vault;
		const old = this.store.folder;
		if (target === old) {
			return true;
		}
		if (target.startsWith(`${old}/`)) {
			new Notice(t('folderInsideItself'));
			return false;
		}
		if (vault.getFileByPath(normalizePath(`${target}/${DATA_FILE_NAME}`))) {
			const ok = await confirmAction(this.app, {
				title: t('folderHasTasksTitle'),
				message: t('folderHasTasks', { folder: target, old }),
				confirmText: t('switchFolder'),
			});
			if (!ok) {
				return false;
			}
			this.settings.folder = target;
			await this.saveSettings();
			await this.reloadData();
			return true;
		}

		const source = vault.getFolderByPath(old);
		const existing = vault.getAbstractFileByPath(target);
		if (existing && !(existing instanceof TFolder)) {
			new Notice(t('folderInvalid'));
			return false;
		}
		const clash = existing instanceof TFolder ? source?.children.find((child) => vault.getAbstractFileByPath(`${target}/${child.name}`)) : undefined;
		if (clash) {
			new Notice(t('folderClash', { folder: target, name: clash.name }), 8000);
			return false;
		}

		this.movingFolder = true;
		try {
			await this.store.idle();
			if (source) {
				if (existing instanceof TFolder) {
					// Into an existing folder: move the contents, then remove the emptied old folder.
					for (const child of [...source.children]) {
						await this.app.fileManager.renameFile(child, normalizePath(`${target}/${child.name}`));
					}
					if (!source.children.length) {
						await this.app.fileManager.trashFile(source);
					}
				} else {
					const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
					if (parent) {
						await this.store.ensureFolder(parent);
					}
					// Moves everything at once; Obsidian also updates links to the attachments in notes.
					await this.app.fileManager.renameFile(source, target);
				}
			}
			this.settings.folder = target;
			await this.saveSettings();
		} catch (err) {
			console.error('Quests List: moving the folder failed', err);
			new Notice(t('folderMoveFailed'));
			return false;
		} finally {
			this.movingFolder = false;
		}
		await this.reloadData();
		await this.followPaths(old, target);
		new Notice(t('folderMoved', { folder: target }));
		return true;
	}

	/** Updates attachment and link paths after `oldPath` became `newPath`. */
	private async followPaths(oldPath: string, newPath: string): Promise<void> {
		const used = this.store.data.tasks.some((task) =>
			[...task.attachments, ...task.links].some((path) => path === oldPath || path.startsWith(`${oldPath}/`)),
		);
		// Only once the data file is in place: writing earlier would create a new file at the old path.
		if (used && this.app.vault.getFileByPath(this.store.path)) {
			await this.updateData((data) => renamePaths(data, oldPath, newPath));
		}
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKS)) {
			if (leaf.view instanceof TasksView) {
				leaf.view.refresh();
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) {
			if (leaf.view instanceof CalendarView) {
				leaf.view.refresh();
			}
		}
	}

	/** Applies a change and saves it. Returns false (and reports) on failure. */
	async updateData(change: (data: QuestsData) => void): Promise<boolean> {
		try {
			await this.store.update(change);
			this.schedulePush();
			return true;
		} catch (err) {
			console.error('Quests List: save failed', err);
			new Notice(
				err instanceof LockedError
					? t('privateLockedSave')
					: err instanceof DataFormatError
						? t('dataDamaged', { path: this.store.path })
						: t('saveFailed'),
			);
			return false;
		} finally {
			this.refreshViews();
		}
	}

	// ---------- Private lists ----------

	/** Any interaction in the plugin's views postpones the automatic lock. */
	noteActivity(): void {
		this.lastActivity = Date.now();
	}

	private checkAutoLock(): void {
		const minutes = this.settings.privateAutoLockMinutes;
		if (minutes > 0 && this.store.unlocked && Date.now() - this.lastActivity >= minutes * 60_000) {
			void this.lockPrivate().then(() => new Notice(t('privateAutoLocked')));
		}
	}

	async lockPrivate(): Promise<void> {
		await this.store.lock();
		this.refreshViews();
	}

	/** Asks for the password. Resolves to true when private lists are open. */
	async unlockPrivate(): Promise<boolean> {
		if (this.store.unlocked) {
			return true;
		}
		const ok = await new UnlockModal(this.app, (password) => this.store.unlock(password)).ask();
		if (ok) {
			this.noteActivity();
			this.refreshViews();
		}
		return ok;
	}

	/** Makes sure a password exists and private lists are open, asking for whatever is missing. */
	async ensurePrivateAccess(): Promise<boolean> {
		if (!this.store.hasPassword) {
			const ok = await new CreatePasswordModal(this.app, (password) => this.store.setPassword(password)).ask();
			if (ok) {
				this.noteActivity();
				this.refreshViews();
			}
			return ok;
		}
		return this.unlockPrivate();
	}

	async changePrivatePassword(): Promise<void> {
		const ok = await new ChangePasswordModal(this.app, (oldPassword, newPassword) =>
			this.store.changePassword(oldPassword, newPassword),
		).ask();
		if (ok) {
			this.noteActivity();
			this.refreshViews();
			new Notice(t('privatePasswordChanged'));
		}
	}

	/** Makes a list private (encrypted) or public again. */
	async setListPrivate(id: string, value: boolean): Promise<void> {
		if (!(await this.ensurePrivateAccess())) {
			return;
		}
		const ok = await this.updateData((data) => {
			const list = data.lists.find((l) => l.id === id);
			if (list) {
				list.private = value;
				list.sealed = null;
				list.updatedAt = Date.now();
			}
		});
		if (ok) {
			new Notice(value ? t('privateListMade') : t('publicListMade'));
		}
	}

	/** Returns the new task id, or null when saving failed. */
	async createTask(fields: Pick<Task, 'listId' | 'title' | 'start'>): Promise<string | null> {
		const tasks = this.store.data.tasks.filter((task) => task.listId === fields.listId);
		const task = createTask({ ...fields, order: nextOrder(tasks) });
		return (await this.updateData((data) => data.tasks.push(task))) ? task.id : null;
	}

	/** The first list, created if there are none. */
	async ensureDefaultList(): Promise<string | null> {
		const first = listTree(this.store.data.lists, false)[0];
		if (first) {
			return first.list.id;
		}
		const list = createList(t('defaultListName'), 1);
		return (await this.updateData((data) => data.lists.push(list))) ? list.id : null;
	}

	async toggleDone(id: string): Promise<void> {
		await this.updateData((data) => {
			const task = data.tasks.find((item) => item.id === id);
			if (task) {
				task.done = !task.done;
				task.doneAt = task.done ? Date.now() : null;
				task.updatedAt = Date.now();
			}
		});
	}

	private async openView(type: string): Promise<WorkspaceLeaf> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({ type, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf;
	}

	async openTasks(): Promise<TasksView | null> {
		const leaf = await this.openView(VIEW_TYPE_TASKS);
		return leaf.view instanceof TasksView ? leaf.view : null;
	}

	async openTask(id: string): Promise<void> {
		(await this.openTasks())?.showTask(id);
	}

	async openCalendar(): Promise<void> {
		await this.openView(VIEW_TYPE_CALENDAR);
	}

	// ---------- Calendar sync ----------

	scheduleSync(): void {
		window.clearInterval(this.syncTimer);
		const minutes = this.settings.syncIntervalMinutes;
		if (minutes > 0) {
			this.syncTimer = window.setInterval(() => void this.syncNow(false), minutes * 60_000);
		}
	}

	private schedulePush(): void {
		if (!this.settings.accounts.some((a) => a.enabled && supportsPush(a) && a.push)) {
			return;
		}
		window.clearTimeout(this.pushTimer);
		this.pushTimer = window.setTimeout(() => void this.syncNow(false), PUSH_DELAY);
	}

	/** Syncs all calendars. `manual` reports the result; automatic runs only log errors. */
	async syncNow(manual: boolean): Promise<SyncReport | null> {
		if (!this.store.loaded || this.store.broken || !this.settings.accounts.some((a) => a.enabled)) {
			if (manual) {
				new Notice(t('noCalendars'));
			}
			return null;
		}
		window.clearTimeout(this.pushTimer);
		const report = await this.sync.syncAll();
		this.refreshViews();
		for (const { account, error } of report.errors) {
			console.warn(`Quests List: sync with "${account.name}" failed`, error);
			if (manual) {
				new Notice(t('syncFailed', { name: account.name, error: describeSyncError(error) }), 10_000);
			}
		}
		if (manual && !report.errors.length) {
			new Notice(t('syncDone'));
		}
		return report;
	}

	// ---------- Vault events ----------

	private async onFileChanged(file: TAbstractFile): Promise<void> {
		if (file.path !== this.store.path) {
			return;
		}
		try {
			if (await this.store.reloadFromDisk()) {
				this.refreshViews();
			}
		} catch (err) {
			console.error('Quests List: cannot read changed data file', err);
		}
	}

	private async onFileRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
		if (this.movingFolder) {
			return;
		}
		// The data folder, a folder containing it, or the data file itself was moved in the file explorer: follow it.
		const folder = this.store.folder;
		let followed: string | null = null;
		if (folder === oldPath || folder.startsWith(`${oldPath}/`)) {
			followed = normalizePath(file.path + folder.slice(oldPath.length));
		} else if (oldPath === this.store.path && file.name === DATA_FILE_NAME && file.parent && !file.parent.isRoot()) {
			followed = file.parent.path;
		}
		if (followed && followed !== folder) {
			this.settings.folder = followed;
			await this.saveSettings();
			await this.reloadData();
			new Notice(t('folderFollowed', { folder: followed }));
		}
		await this.followPaths(oldPath, file.path);
	}
}
