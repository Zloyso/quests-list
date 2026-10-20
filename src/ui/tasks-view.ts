import {
	Component,
	ItemView,
	Keymap,
	MarkdownRenderer,
	Menu,
	normalizePath,
	Notice,
	Platform,
	setIcon,
	TFile,
	type ViewStateResult,
	type WorkspaceLeaf,
} from 'obsidian';
import { addDays, datePart, daysBetween, formatDateValue, formatTimestamp, shiftDays, timePart, todayStr, withTime } from '../dates';
import { t } from '../i18n';
import type QuestsPlugin from '../main';
import {
	createList,
	createTask,
	descendantIds,
	firstOrder,
	isOverdue,
	LIST_COLORS,
	type ListColor,
	listIcon,
	type ListNode,
	listPath,
	listTree,
	privateRoots,
	privateScope,
	matchesFilter,
	matchesQuery,
	moveList,
	nextOrder,
	placeItem,
	removeList,
	removeTask,
	resolveParents,
	sameFilter,
	sortTasks,
	type Task,
	type TaskFilter,
	type TaskList,
	type TaskSort,
	TASK_SORTS,
} from '../model';
import { type DragOptions, type DropSpot, halfOf, makeDraggable, zoneOf } from './drag';
import { ChoicePicker, confirmAction, FilePicker, ListPicker, promptText } from './modals';
import { IconPicker } from './icon-picker';
import { autoGrow, iconButton, makeActivatable, openNativePicker, renderCheckbox, setColor, textButton } from './widgets';

export const VIEW_TYPE_TASKS = 'quests-list-tasks';

const NARROW_WIDTH = 760;
const SAVE_DELAY = 500;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];

type Pane = 'lists' | 'tasks' | 'detail';

/** Open tasks of one list; `list` is null in "Today", "Upcoming" and "All". */
interface TaskGroup {
	list: TaskList | null;
	open: Task[];
}

const SORT_LABELS: Record<TaskSort, 'sortManual' | 'sortStart' | 'sortEnd' | 'sortTitle' | 'sortCreated'> = {
	manual: 'sortManual',
	start: 'sortStart',
	end: 'sortEnd',
	title: 'sortTitle',
	created: 'sortCreated',
};

const COLOR_LABELS: Record<ListColor, 'colorRed' | 'colorOrange' | 'colorYellow' | 'colorGreen' | 'colorCyan' | 'colorBlue' | 'colorPurple' | 'colorPink'> = {
	red: 'colorRed',
	orange: 'colorOrange',
	yellow: 'colorYellow',
	green: 'colorGreen',
	cyan: 'colorCyan',
	blue: 'colorBlue',
	purple: 'colorPurple',
	pink: 'colorPink',
};

export function colorLabel(color: ListColor): string {
	return t(COLOR_LABELS[color]);
}

function parseFilter(raw: unknown): TaskFilter | null {
	if (typeof raw !== 'object' || raw === null) {
		return null;
	}
	const o = raw as { kind?: unknown; id?: unknown };
	if (o.kind === 'all' || o.kind === 'today' || o.kind === 'upcoming') {
		return { kind: o.kind };
	}
	if (o.kind === 'list' && typeof o.id === 'string') {
		return { kind: 'list', id: o.id };
	}
	return null;
}

export class TasksView extends ItemView {
	private filter: TaskFilter = { kind: 'today' };
	private selectedId: string | null = null;
	private query = '';
	private pane: Pane = 'tasks';
	private narrow = false;
	private showDone = false;
	private resizeObserver: ResizeObserver | null = null;
	private rootEl: HTMLElement | null = null;
	private panesEl: HTMLElement | null = null;
	private listsPaneEl: HTMLElement | null = null;
	private tasksPaneEl: HTMLElement | null = null;
	private detailPaneEl: HTMLElement | null = null;
	private backButton: HTMLElement | null = null;
	private syncButton: HTMLElement | null = null;
	/** Owns markdown rendered in the detail pane. */
	private detailComponent: Component | null = null;
	private editingNotes = false;
	/** Set after creating a task so its title gets focus. */
	private focusTitle = false;
	private readonly saveTimers = new Map<string, number>();
	private readonly pendingRuns = new Map<string, () => void>();
	/** Lists whose nested lists are hidden in the lists pane. */
	private collapsed = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: QuestsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TASKS;
	}

	getDisplayText(): string {
		return this.plugin.manifest.name;
	}

	getIcon(): string {
		return 'list-checks';
	}

	getState(): Record<string, unknown> {
		return { filter: this.filter, selectedId: this.selectedId, collapsed: [...this.collapsed] };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const o = (typeof state === 'object' && state !== null ? state : {}) as { filter?: unknown; selectedId?: unknown; collapsed?: unknown };
		this.filter = parseFilter(o.filter) ?? this.filter;
		this.selectedId = typeof o.selectedId === 'string' ? o.selectedId : this.selectedId;
		if (Array.isArray(o.collapsed)) {
			this.collapsed = new Set(o.collapsed.filter((id): id is string => typeof id === 'string'));
		}
		await super.setState(state, result);
		this.render();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('quests-view');
		this.narrow = this.computeNarrow();
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.contentEl);
		this.registerDomEvent(this.contentEl, 'pointerdown', () => this.plugin.noteActivity());
		this.registerDomEvent(this.contentEl, 'keydown', () => this.plugin.noteActivity());
		this.render();
	}

	async onClose(): Promise<void> {
		this.flushSaves();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.detailComponent?.unload();
		this.contentEl.empty();
	}

	/** Called after any data change. Keeps the detail pane while the user is typing in it. */
	refresh(): void {
		if (!this.rootEl || !this.plugin.store.loaded || this.plugin.store.broken) {
			this.render();
			return;
		}
		this.updateSyncButton();
		const active = this.contentEl.doc.activeElement;
		const typing = !!active && !!this.detailPaneEl?.contains(active) && active.matches('input, textarea, select');
		this.renderPanes(typing);
	}

	/** Shows a task, e.g. when it is clicked in the calendar. */
	showTask(id: string): void {
		const task = this.plugin.store.data.tasks.find((item) => item.id === id);
		if (!task) {
			return;
		}
		this.flushSaves();
		this.filter = { kind: 'list', id: task.listId };
		this.expandTo(task.listId);
		this.selectedId = id;
		this.editingNotes = false;
		this.query = '';
		this.showDone ||= task.done;
		this.pane = 'detail';
		this.render();
	}

	/** Creates a task (optionally starting on `date`) and opens it for editing. */
	async newTask(date?: string): Promise<void> {
		const listId =
			this.filter.kind === 'list' && this.plugin.store.data.lists.some((l) => l.id === (this.filter as { id: string }).id)
				? this.filter.id
				: await this.plugin.ensureDefaultList();
		if (!listId) {
			return;
		}
		const start = date ?? (this.filter.kind === 'upcoming' ? addDays(todayStr(), 1) : todayStr());
		const id = await this.plugin.createTask({ listId, title: '', start });
		if (!id) {
			return;
		}
		const task = this.plugin.store.data.tasks.find((item) => item.id === id);
		if (task && !matchesFilter(task, this.filter)) {
			this.filter = { kind: 'list', id: listId };
			this.expandTo(listId);
		}
		this.query = '';
		this.selectedId = id;
		this.editingNotes = false;
		this.focusTitle = true;
		this.pane = 'detail';
		this.render();
	}

	// ---------- Layout ----------

	private computeNarrow(): boolean {
		const width = this.contentEl.clientWidth;
		return Platform.isPhone || (width > 0 ? width < NARROW_WIDTH : this.narrow);
	}

	private handleResize(): void {
		const narrow = this.computeNarrow();
		if (narrow !== this.narrow) {
			this.narrow = narrow;
			// Re-render outside the observer callback to avoid "ResizeObserver loop" warnings.
			window.setTimeout(() => this.render(), 0);
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.rootEl = null;
		const store = this.plugin.store;
		if (!store.loaded) {
			this.contentEl.createDiv({ cls: 'quests-empty', text: t('loading') });
			return;
		}
		if (store.broken) {
			const box = this.contentEl.createDiv({ cls: 'quests-empty' });
			setIcon(box.createDiv({ cls: 'quests-empty-icon' }), 'file-warning');
			box.createDiv({ text: t('dataDamaged', { path: store.path }) });
			box
				.createEl('button', { text: t('retry'), attr: { type: 'button' } })
				.addEventListener('click', () => void this.plugin.reloadData());
			return;
		}
		const root = (this.rootEl = this.contentEl.createDiv({ cls: 'quests-manager' }));
		root.toggleClass('is-narrow', this.narrow);
		this.renderToolbar(root.createDiv({ cls: 'quests-toolbar' }));
		this.panesEl = root.createDiv({ cls: 'quests-panes' });
		this.renderPanes(false);
	}

	private renderToolbar(bar: HTMLElement): void {
		this.backButton = iconButton(bar, 'chevron-left', t('back'), () => this.goBack(), 'quests-back');

		const search = bar.createDiv({ cls: 'quests-search' });
		setIcon(search.createSpan({ cls: 'quests-search-icon' }), 'search');
		const input = search.createEl('input', {
			type: 'search',
			value: this.query,
			attr: { placeholder: t('searchPlaceholder'), 'aria-label': t('searchPlaceholder') },
		});
		input.addEventListener('input', () => {
			this.query = input.value;
			if (this.narrow && this.pane !== 'tasks') {
				this.pane = 'tasks';
			}
			this.renderPanes(false);
		});
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && input.value) {
				event.stopPropagation();
				input.value = '';
				this.query = '';
				this.renderPanes(false);
			}
		});

		const actions = bar.createDiv({ cls: 'quests-toolbar-actions' });
		textButton(actions, 'plus', t('newTask'), () => void this.newTask());
		this.syncButton = iconButton(actions, 'refresh-cw', t('syncNow'), () => void this.plugin.syncNow(true), 'quests-sync-button');
		this.updateSyncButton();
	}

	private updateSyncButton(): void {
		const button = this.syncButton;
		if (!button) {
			return;
		}
		button.toggleClass('is-hidden', !this.plugin.settings.accounts.some((a) => a.enabled));
		button.toggleClass('is-spinning', this.plugin.sync.running);
	}

	private renderPanes(keepDetail: boolean): void {
		const panes = this.panesEl;
		if (!panes) {
			return;
		}
		this.backButton?.toggleClass('is-hidden', !(this.narrow && this.pane !== 'lists'));
		if (!this.plugin.store.data.tasks.some((task) => task.id === this.selectedId)) {
			this.selectedId = null;
		}
		if (this.filter.kind === 'list' && !this.plugin.store.data.lists.some((l) => l.id === (this.filter as { id: string }).id)) {
			this.filter = { kind: 'today' };
		}

		const canKeep = keepDetail && !!this.selectedId && !!this.detailPaneEl?.isConnected;
		if (canKeep && this.narrow) {
			// Only the detail pane is on screen; re-rendering it would close the keyboard.
			return;
		}
		if (!canKeep) {
			panes.empty();
			if (this.narrow) {
				const pane = panes.createDiv({ cls: `quests-pane quests-scroll quests-pane-${this.pane}` });
				this.listsPaneEl = this.pane === 'lists' ? pane : null;
				this.tasksPaneEl = this.pane === 'tasks' ? pane : null;
				this.detailPaneEl = this.pane === 'detail' ? pane : null;
			} else {
				this.listsPaneEl = panes.createDiv({ cls: 'quests-pane quests-scroll quests-pane-lists' });
				this.tasksPaneEl = panes.createDiv({ cls: 'quests-pane quests-scroll quests-pane-tasks' });
				this.detailPaneEl = panes.createDiv({ cls: 'quests-pane quests-scroll quests-pane-detail' });
			}
		}
		if (this.listsPaneEl) {
			this.renderListsPane(this.listsPaneEl);
		}
		if (this.tasksPaneEl) {
			this.renderTasksPane(this.tasksPaneEl);
		}
		if (this.detailPaneEl && !canKeep) {
			this.renderDetailPane(this.detailPaneEl);
		}
	}

	private goBack(): void {
		this.flushSaves();
		if (this.pane === 'detail') {
			this.pane = 'tasks';
		} else if (this.pane === 'tasks') {
			this.pane = 'lists';
		}
		this.renderPanes(false);
	}

	// ---------- Lists ----------

	/** All lists in display order (each followed by its nested lists). */
	private sortedLists(): TaskList[] {
		return this.tree().map((node) => node.list);
	}

	private tree(): ListNode[] {
		return listTree(this.plugin.store.data.lists, this.plugin.settings.listsByName);
	}

	/** "Работа / Проект А" */
	private listLabel(id: string): string {
		return listPath(this.plugin.store.data.lists, id).join(' / ');
	}

	/** Expands the lists that contain `id`, so it is visible in the lists pane. */
	private expandTo(id: string): void {
		const parents = resolveParents(this.plugin.store.data.lists);
		for (let parent = parents.get(id) ?? null; parent; parent = parents.get(parent) ?? null) {
			this.collapsed.delete(parent);
		}
	}

	private renderListsPane(pane: HTMLElement): void {
		pane.empty();
		const { tasks } = this.plugin.store.data;
		const today = todayStr();
		const nav = pane.createDiv({ cls: 'quests-nav' });
		const openCount = (filter: TaskFilter) => tasks.filter((task) => !task.done && matchesFilter(task, filter, today)).length;

		this.renderNavItem(nav, { kind: 'today' }, 'sun', t('today'), openCount({ kind: 'today' }));
		this.renderNavItem(nav, { kind: 'upcoming' }, 'calendar-clock', t('upcoming'), openCount({ kind: 'upcoming' }));
		this.renderNavItem(nav, { kind: 'all' }, 'inbox', t('allTasks'), openCount({ kind: 'all' }));
		const calendar = nav.createDiv({ cls: 'quests-nav-item quests-nav-calendar' });
		setIcon(calendar.createSpan({ cls: 'quests-nav-icon' }), 'calendar-days');
		calendar.createSpan({ cls: 'quests-nav-label', text: t('calendar') });
		setIcon(calendar.createSpan({ cls: 'quests-nav-arrow' }), 'arrow-up-right');
		makeActivatable(calendar, () => void this.plugin.openCalendar());

		const header = nav.createDiv({ cls: 'quests-nav-header' });
		// Dropping a list on the header moves it to the top level.
		header.dataset.questsListsRoot = '';
		header.createSpan({ text: t('lists') });
		const headerActions = header.createDiv({ cls: 'quests-nav-header-actions' });
		iconButton(headerActions, 'arrow-up-down', t('sortLists'), (event) => this.openListSortMenu(event));
		if (this.plugin.store.unlocked && privateRoots(this.plugin.store.data.lists).length) {
			iconButton(headerActions, 'lock', t('commandLockPrivate'), () => void this.plugin.lockPrivate());
		}
		iconButton(headerActions, 'plus', t('newList'), () => void this.createListInteractive());

		const nodes = this.tree();
		if (!nodes.length) {
			const empty = nav.createDiv({ cls: 'quests-nav-empty' });
			empty.createDiv({ cls: 'quests-muted', text: t('noLists') });
			empty
				.createEl('button', { text: t('newList'), cls: 'mod-cta', attr: { type: 'button' } })
				.addEventListener('click', () => void this.createListInteractive());
		}
		const listBox = nav.createDiv({ cls: 'quests-nav-lists' });
		const parents = resolveParents(this.plugin.store.data.lists);
		const hiddenByCollapse = (id: string) => {
			for (let p = parents.get(id) ?? null; p; p = parents.get(p) ?? null) {
				if (this.collapsed.has(p)) {
					return true;
				}
			}
			return false;
		};
		const lists = this.plugin.store.data.lists;
		for (const node of nodes) {
			if (hiddenByCollapse(node.list.id)) {
				continue;
			}
			// A list's count includes the tasks of its nested lists.
			const scope = descendantIds(lists, node.list.id);
			const count = tasks.filter((task) => !task.done && scope.has(task.listId)).length;
			const item = this.renderNavItem(listBox, { kind: 'list', id: node.list.id }, listIcon(node.list), node.list.name, count, node);
			item.dataset.questsList = node.list.id;
		}
	}

	private renderNavItem(
		parent: HTMLElement,
		filter: TaskFilter,
		icon: string,
		label: string,
		count: number,
		node?: ListNode,
	): HTMLElement {
		const list = node?.list;
		const item = parent.createDiv({ cls: 'quests-nav-item' });
		item.toggleClass('is-active', sameFilter(filter, this.filter));
		const handle = list ? item.createSpan({ cls: 'quests-handle' }) : null;
		if (handle) {
			setIcon(handle, 'grip-vertical');
		}
		if (node) {
			item.setCssProps({ '--quests-depth': String(node.depth) });
			if (node.hasChildren) {
				const isCollapsed = this.collapsed.has(node.list.id);
				iconButton(
					item,
					isCollapsed ? 'chevron-right' : 'chevron-down',
					isCollapsed ? t('expandList') : t('collapseList'),
					() => {
						if (isCollapsed) {
							this.collapsed.delete(node.list.id);
						} else {
							this.collapsed.add(node.list.id);
						}
						this.renderPanes(true);
						this.app.workspace.requestSaveLayout();
					},
					'quests-nav-toggle',
				);
			} else {
				item.createSpan({ cls: 'quests-nav-toggle-spacer' });
			}
		}
		const iconEl = item.createSpan({ cls: 'quests-nav-icon' });
		setIcon(iconEl, icon);
		if (list) {
			iconEl.addClass('is-colored');
			setColor(iconEl, list.color);
		}
		item.createSpan({ cls: 'quests-nav-label', text: label });
		const locked = !!list && this.isLocked(list.id);
		item.createSpan({ cls: 'quests-nav-count', text: count && !locked ? String(count) : '' });
		if (list?.private) {
			const badge = item.createSpan({ cls: 'quests-nav-lock' });
			setIcon(badge, locked ? 'lock' : 'lock-open');
			badge.toggleClass('is-locked', locked);
		}
		if (list) {
			iconButton(item, 'more-horizontal', t('listActions'), (event) => this.openListMenu(event, list), 'quests-nav-menu');
			item.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				this.openListMenu(event, list);
			});
			makeDraggable(item, handle, () => this.listDragOptions(list));
		}
		makeActivatable(item, () => {
			if (locked) {
				// A closed private list opens after the password.
				void this.plugin.unlockPrivate().then((ok) => ok && this.selectFilter(filter));
				return;
			}
			this.selectFilter(filter);
		});
		return item;
	}

	private selectFilter(filter: TaskFilter): void {
		this.flushSaves();
		if (!sameFilter(filter, this.filter)) {
			this.selectedId = null;
			this.editingNotes = false;
		}
		this.filter = filter;
		if (this.narrow) {
			this.pane = 'tasks';
		}
		this.renderPanes(false);
		this.app.workspace.requestSaveLayout();
	}

	private openListSortMenu(event: MouseEvent): void {
		const menu = new Menu();
		const byName = this.plugin.settings.listsByName;
		const set = async (value: boolean) => {
			this.plugin.settings.listsByName = value;
			await this.plugin.saveSettings();
			this.renderPanes(true);
		};
		menu.addItem((item) => item.setTitle(t('sortManual')).setChecked(!byName).onClick(() => void set(false)));
		menu.addItem((item) => item.setTitle(t('sortTitle')).setChecked(byName).onClick(() => void set(true)));
		menu.showAtMouseEvent(event);
	}

	private openListMenu(event: MouseEvent, list: TaskList): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t('newSublist'))
				.setIcon('folder-plus')
				.onClick(() => void this.withAccess(list.id, () => this.createListInteractive(list.id))),
		);
		menu.addItem((item) =>
			item
				.setTitle(t('renameList'))
				.setIcon('pencil')
				.onClick(() => void this.renameListInteractive(list)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t('moveList'))
				.setIcon('folder-input')
				.onClick(() => this.moveListInteractive(list)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t('listIcon'))
				.setIcon(listIcon(list))
				.onClick(() => new IconPicker(this.app, list.icon, (icon) => void this.setListIcon(list.id, icon)).open()),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t('noColor'))
				.setChecked(list.color === null)
				.onClick(() => void this.setListColor(list.id, null)),
		);
		for (const color of LIST_COLORS) {
			menu.addItem((item) => {
				item
					.setTitle(colorLabel(color))
					.setChecked(list.color === color)
					.onClick(() => void this.setListColor(list.id, color));
			});
		}
		menu.addSeparator();
		const scope = privateScope(this.plugin.store.data.lists);
		if (list.private) {
			menu.addItem((item) =>
				item
					.setTitle(t('makePublic'))
					.setIcon('lock-open')
					.onClick(() => void this.plugin.setListPrivate(list.id, false)),
			);
		} else if (!scope.has(list.id)) {
			menu.addItem((item) =>
				item
					.setTitle(t('makePrivate'))
					.setIcon('lock')
					.onClick(() => void this.plugin.setListPrivate(list.id, true)),
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t('deleteList'))
				.setIcon('trash-2')
				.setWarning(true)
				.onClick(() => void this.withAccess(list.id, () => this.deleteListInteractive(list))),
		);
		menu.showAtMouseEvent(event);
	}

	/** The list is private (or inside a private list) and private lists are closed. */
	private isLocked(id: string): boolean {
		return this.plugin.store.locked && privateScope(this.plugin.store.data.lists).has(id);
	}

	/** Runs `action` once the list is accessible, asking for the password if it is closed. */
	private async withAccess(id: string, action: () => unknown): Promise<void> {
		if (this.isLocked(id) && !(await this.plugin.unlockPrivate())) {
			return;
		}
		await action();
	}

	/** Lists that tasks or lists can be moved into right now. */
	private openLists(): TaskList[] {
		return this.sortedLists().filter((list) => !this.isLocked(list.id));
	}

	private parentOf(id: string): string | null {
		return resolveParents(this.plugin.store.data.lists).get(id) ?? null;
	}

	/** Names must be unique among lists in the same place. */
	private validListName(name: string, parentId: string | null, exceptId?: string): boolean {
		const lower = name.toLocaleLowerCase();
		const parents = resolveParents(this.plugin.store.data.lists);
		const taken = this.plugin.store.data.lists.some(
			(l) => l.id !== exceptId && (parents.get(l.id) ?? null) === parentId && l.name.toLocaleLowerCase() === lower,
		);
		if (taken) {
			new Notice(t('listExists'));
			return false;
		}
		return true;
	}

	private async createListInteractive(parentId: string | null = null): Promise<void> {
		const title = parentId ? t('newSublistIn', { name: this.listLabel(parentId) }) : t('newList');
		const name = await promptText(this.app, { title, placeholder: t('listName') });
		if (!name || !this.validListName(name, parentId)) {
			return;
		}
		const parents = resolveParents(this.plugin.store.data.lists);
		const siblings = this.plugin.store.data.lists.filter((l) => (parents.get(l.id) ?? null) === parentId);
		const list = createList(name, nextOrder(siblings), parentId);
		if (await this.plugin.updateData((data) => data.lists.push(list))) {
			if (parentId) {
				this.collapsed.delete(parentId);
			}
			this.selectFilter({ kind: 'list', id: list.id });
		}
	}

	private moveListInteractive(list: TaskList): void {
		const blocked = descendantIds(this.plugin.store.data.lists, list.id);
		const current = this.parentOf(list.id);
		const choices = [
			{ id: null, label: t('topLevel') },
			...this.tree()
				.filter((node) => !blocked.has(node.list.id) && !this.isLocked(node.list.id))
				.map((node) => ({ id: node.list.id, label: this.listLabel(node.list.id) })),
		].filter((choice) => choice.id !== current);
		new ChoicePicker(this.app, t('moveListPlaceholder', { name: list.name }), choices, (parentId) =>
			void this.moveListTo(list.id, parentId, null),
		).open();
	}

	private async moveListTo(id: string, parentId: string | null, beforeId: string | null): Promise<void> {
		const list = this.plugin.store.data.lists.find((l) => l.id === id);
		if (!list || (parentId !== this.parentOf(id) && !this.validListName(list.name, parentId, id))) {
			return;
		}
		const ok = await this.plugin.updateData((data) => {
			moveList(data, id, parentId, beforeId);
		});
		if (ok && parentId) {
			this.collapsed.delete(parentId);
			this.renderPanes(true);
		}
	}

	private async renameListInteractive(list: TaskList): Promise<void> {
		const name = await promptText(this.app, { title: t('renameList'), value: list.name });
		if (!name || name === list.name || !this.validListName(name, this.parentOf(list.id), list.id)) {
			return;
		}
		await this.plugin.updateData((data) => {
			const target = data.lists.find((l) => l.id === list.id);
			if (target) {
				target.name = name;
				target.updatedAt = Date.now();
			}
		});
	}

	private async setListIcon(id: string, icon: string | null): Promise<void> {
		await this.plugin.updateData((data) => {
			const target = data.lists.find((l) => l.id === id);
			if (target) {
				target.icon = icon;
				target.updatedAt = Date.now();
			}
		});
	}

	private async setListColor(id: string, color: ListColor | null): Promise<void> {
		await this.plugin.updateData((data) => {
			const target = data.lists.find((l) => l.id === id);
			if (target) {
				target.color = color;
				target.updatedAt = Date.now();
			}
		});
	}

	private async deleteListInteractive(list: TaskList): Promise<void> {
		const scope = descendantIds(this.plugin.store.data.lists, list.id);
		const count = this.plugin.store.data.tasks.filter((task) => scope.has(task.listId)).length;
		const nested = scope.size - 1;
		const ok = await confirmAction(this.app, {
			title: t('deleteList'),
			message: nested
				? t('deleteListMessageNested', { name: list.name, lists: nested, count })
				: count
					? t('deleteListMessageTasks', { name: list.name, count })
					: t('deleteListMessage', { name: list.name }),
			confirmText: t('delete'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		if (this.filter.kind === 'list' && scope.has(this.filter.id)) {
			this.filter = { kind: 'today' };
		}
		await this.plugin.updateData((data) => removeList(data, list.id));
	}

	/**
	 * Lists: the top or bottom quarter of another list puts the dragged one next to it,
	 * the middle puts it inside; the "Lists" header moves it to the top level.
	 */
	private listDragOptions(list: TaskList): DragOptions {
		return {
			label: list.name,
			locate: (target, _x, y) => {
				if (!target || !this.contentEl.contains(target)) {
					return null;
				}
				const root = target.closest<HTMLElement>('[data-quests-lists-root]');
				if (root) {
					return this.parentOf(list.id) === null ? null : { el: root, position: 'inside' };
				}
				const item = target.closest<HTMLElement>('[data-quests-list]');
				const targetId = item?.dataset.questsList;
				if (!item || !targetId || descendantIds(this.plugin.store.data.lists, list.id).has(targetId)) {
					return null;
				}
				const position = zoneOf(item, y);
				// Nothing can be put inside a closed private list.
				return position === 'inside' && this.isLocked(targetId) ? null : { el: item, position };
			},
			drop: (spot) => void this.dropList(list.id, spot),
		};
	}

	private async dropList(id: string, spot: DropSpot): Promise<void> {
		if (spot.el.dataset.questsListsRoot !== undefined) {
			await this.moveListTo(id, null, null);
			return;
		}
		const targetId = spot.el.dataset.questsList;
		if (!targetId) {
			return;
		}
		if (spot.position === 'inside') {
			await this.moveListTo(id, targetId, null);
			return;
		}
		const parentId = this.parentOf(targetId);
		const siblings = this.tree()
			.filter((node) => node.parentId === parentId && node.list.id !== id)
			.map((node) => node.list.id);
		const beforeId = spot.position === 'before' ? targetId : (siblings[siblings.indexOf(targetId) + 1] ?? null);
		if (this.plugin.settings.listsByName) {
			// Dragging while sorted by name keeps the order on screen and switches to manual order.
			const visible = this.tree();
			this.plugin.settings.listsByName = false;
			await this.plugin.saveSettings();
			await this.plugin.updateData((data) => {
				const now = Date.now();
				const byId = new Map(data.lists.map((l) => [l.id, l]));
				const position = new Map<string | null, number>();
				for (const node of visible) {
					const l = byId.get(node.list.id);
					if (l) {
						const next = (position.get(node.parentId) ?? 0) + 1;
						position.set(node.parentId, next);
						l.order = next;
						l.updatedAt = now;
					}
				}
			});
		}
		await this.moveListTo(id, parentId, beforeId);
	}

	// ---------- Tasks ----------

	private currentList(): TaskList | null {
		const filter = this.filter;
		return filter.kind === 'list' ? (this.plugin.store.data.lists.find((l) => l.id === filter.id) ?? null) : null;
	}

	private currentSort(): TaskSort {
		return this.currentList()?.sort ?? this.plugin.settings.smartSort;
	}

	private filterLabel(): string {
		switch (this.filter.kind) {
			case 'all':
				return t('allTasks');
			case 'today':
				return t('today');
			case 'upcoming':
				return t('upcoming');
			case 'list':
				return this.currentList()?.name ?? '';
		}
	}

	/**
	 * Open tasks in groups and done tasks, for the current filter and search, in display order.
	 * A list shows its own tasks first, then one group per nested list.
	 */
	private visibleTasks(): { groups: TaskGroup[]; open: Task[]; done: Task[] } {
		const { tasks } = this.plugin.store.data;
		const today = todayStr();
		const current = this.currentList();
		const byDoneTime = (a: Task, b: Task) => (b.doneAt ?? 0) - (a.doneAt ?? 0);
		if (current) {
			const scope = descendantIds(this.plugin.store.data.lists, current.id);
			const nodes = this.tree().filter((node) => scope.has(node.list.id));
			const matching = tasks.filter((task) => scope.has(task.listId) && matchesQuery(task, this.query));
			const groups: TaskGroup[] = [];
			for (const node of nodes) {
				const open = sortTasks(
					matching.filter((task) => task.listId === node.list.id && !task.done),
					node.list.sort,
				);
				if (node.list.id === current.id || open.length) {
					groups.push({ list: node.list, open });
				}
			}
			return { groups, open: groups.flatMap((g) => g.open), done: matching.filter((task) => task.done).sort(byDoneTime) };
		}
		const matching = tasks.filter((task) => matchesFilter(task, this.filter, today) && matchesQuery(task, this.query));
		const listOrder = new Map(this.sortedLists().map((l, i) => [l.id, i]));
		const open = sortTasks(
			matching.filter((task) => !task.done),
			this.currentSort(),
			listOrder,
		);
		return { groups: [{ list: null, open }], open, done: matching.filter((task) => task.done).sort(byDoneTime) };
	}

	private renderTasksPane(pane: HTMLElement): void {
		const scroll = pane.scrollTop;
		pane.empty();
		const current = this.currentList();
		if (current && this.isLocked(current.id)) {
			this.renderLockedPane(pane, current);
			return;
		}
		const { groups, open, done } = this.visibleTasks();
		const header = pane.createDiv({ cls: 'quests-list-header' });
		const title = header.createDiv({ cls: 'quests-list-title' });
		const list = this.currentList();
		if (list) {
			const dot = title.createSpan({ cls: 'quests-color-dot' });
			setColor(dot, list.color);
		}
		title.createSpan({ text: this.filterLabel() });
		header.createDiv({ cls: 'quests-list-count', text: String(open.length) });
		iconButton(header, 'arrow-up-down', t('sortTasks'), (event) => this.openTaskSortMenu(event));

		if (!this.query) {
			this.renderQuickAdd(pane);
		}

		const box = pane.createDiv({ cls: 'quests-task-list' });
		if (!open.length && !done.length) {
			const empty = box.createDiv({ cls: 'quests-empty quests-empty-small' });
			empty.createDiv({ text: this.query ? t('nothingFound') : this.filter.kind === 'today' ? t('nothingToday') : t('noTasks') });
		}
		for (const group of groups) {
			if (group.list && list && group.list.id !== list.id) {
				this.renderGroupHeader(box, group.list, list.id, group.open.length);
			}
			for (const task of group.open) {
				this.renderTaskRow(box, task);
			}
		}
		if (done.length) {
			const toggle = box.createDiv({ cls: 'quests-done-toggle' });
			setIcon(toggle.createSpan({ cls: 'quests-done-chevron' }), this.showDone ? 'chevron-down' : 'chevron-right');
			toggle.createSpan({ text: t('completedCount', { count: done.length }) });
			makeActivatable(toggle, () => {
				this.showDone = !this.showDone;
				this.renderPanes(true);
			});
			if (this.showDone) {
				for (const task of done) {
					this.renderTaskRow(box, task);
				}
			}
		}
		pane.scrollTop = scroll;
	}

	private renderLockedPane(pane: HTMLElement, list: TaskList): void {
		const header = pane.createDiv({ cls: 'quests-list-header' });
		header.createDiv({ cls: 'quests-list-title', text: list.name });
		const box = pane.createDiv({ cls: 'quests-empty' });
		setIcon(box.createDiv({ cls: 'quests-empty-icon' }), 'lock');
		box.createDiv({ text: t('privateListClosed') });
		box
			.createEl('button', { text: t('privateUnlock'), cls: 'mod-cta', attr: { type: 'button' } })
			.addEventListener('click', () => void this.plugin.unlockPrivate());
	}

	/** Heading for the tasks of a nested list; click opens that list, tasks can be dropped on it. */
	private renderGroupHeader(box: HTMLElement, group: TaskList, currentId: string, count: number): void {
		const header = box.createDiv({ cls: 'quests-group-header' });
		header.dataset.questsGroupHeader = group.id;
		const icon = header.createSpan({ cls: 'quests-group-icon' });
		setIcon(icon, listIcon(group));
		setColor(icon, group.color);
		const path = listPath(this.plugin.store.data.lists, group.id);
		const depth = listPath(this.plugin.store.data.lists, currentId).length;
		header.createSpan({ cls: 'quests-group-name', text: path.slice(depth).join(' / ') });
		header.createSpan({ cls: 'quests-group-count', text: String(count) });
		makeActivatable(header, () => this.selectFilter({ kind: 'list', id: group.id }));
	}

	private renderQuickAdd(pane: HTMLElement): void {
		const form = pane.createEl('form', { cls: 'quests-quick-add' });
		setIcon(form.createSpan({ cls: 'quests-quick-add-icon' }), 'plus');
		const input = form.createEl('input', { type: 'text', attr: { placeholder: t('addTaskPlaceholder'), 'aria-label': t('newTask') } });
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const title = input.value.trim();
			if (!title) {
				return;
			}
			input.value = '';
			void this.quickAdd(title).then(() => {
				// The pane was re-rendered; put the cursor back for the next task.
				this.tasksPaneEl?.querySelector<HTMLInputElement>('.quests-quick-add input')?.focus();
			});
		});
	}

	private async quickAdd(title: string): Promise<void> {
		const list = this.currentList();
		const listId = list?.id ?? (await this.plugin.ensureDefaultList());
		if (!listId) {
			return;
		}
		const start = this.filter.kind === 'upcoming' ? addDays(todayStr(), 1) : todayStr();
		await this.plugin.createTask({ listId, title, start });
	}

	private openTaskSortMenu(event: MouseEvent): void {
		const menu = new Menu();
		const current = this.currentSort();
		const list = this.currentList();
		for (const sort of TASK_SORTS) {
			menu.addItem((item) =>
				item
					.setTitle(t(SORT_LABELS[sort]))
					.setChecked(sort === current)
					.onClick(async () => {
						if (list) {
							await this.plugin.updateData((data) => {
								const target = data.lists.find((l) => l.id === list.id);
								if (target) {
									target.sort = sort;
									target.updatedAt = Date.now();
								}
							});
						} else {
							this.plugin.settings.smartSort = sort;
							await this.plugin.saveSettings();
							this.renderPanes(true);
						}
					}),
			);
		}
		menu.showAtMouseEvent(event);
	}

	private renderTaskRow(box: HTMLElement, task: Task): void {
		const row = box.createDiv({ cls: 'quests-task' });
		row.dataset.questsTask = task.id;
		row.dataset.questsGroup = task.listId;
		row.toggleClass('is-active', task.id === this.selectedId);
		row.toggleClass('is-done', task.done);
		const handle = row.createSpan({ cls: 'quests-handle' });
		setIcon(handle, 'grip-vertical');
		this.renderCheck(row, task);

		const text = row.createDiv({ cls: 'quests-task-text' });
		text.createDiv({ cls: 'quests-task-title', text: task.title || t('untitled') }).toggleClass('is-untitled', !task.title);
		const meta = text.createDiv({ cls: 'quests-task-meta' });
		const dates = meta.createSpan({ cls: 'quests-task-dates' });
		dates.toggleClass('is-overdue', isOverdue(task));
		setIcon(dates.createSpan({ cls: 'quests-meta-icon' }), 'calendar');
		dates.createSpan({ text: this.datesText(task) });
		if (this.filter.kind !== 'list') {
			const list = this.plugin.store.data.lists.find((l) => l.id === task.listId);
			if (list) {
				const tag = meta.createSpan({ cls: 'quests-task-list-name' });
				setColor(tag.createSpan({ cls: 'quests-color-dot' }), list.color);
				tag.createSpan({ text: list.name });
			}
		}
		if (task.notes.trim()) {
			setIcon(meta.createSpan({ cls: 'quests-meta-icon' }), 'align-left');
		}
		if (task.links.length) {
			const links = meta.createSpan({ cls: 'quests-meta-count' });
			setIcon(links.createSpan({ cls: 'quests-meta-icon' }), 'link');
			links.createSpan({ text: String(task.links.length) });
		}
		if (task.attachments.length) {
			const files = meta.createSpan({ cls: 'quests-meta-count' });
			setIcon(files.createSpan({ cls: 'quests-meta-icon' }), 'paperclip');
			files.createSpan({ text: String(task.attachments.length) });
		}

		row.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.openTaskMenu(event, task);
		});
		makeActivatable(row, () => this.selectTask(task.id));
		makeDraggable(row, handle, () => this.taskDragOptions(task));
	}

	private datesText(task: Task): string {
		const start = formatDateValue(task.start);
		if (!task.end) {
			return start;
		}
		const end = datePart(task.end) === datePart(task.start) && timePart(task.end) ? (timePart(task.end) ?? '') : formatDateValue(task.end);
		return `${start} → ${end}`;
	}

	private renderCheck(parent: HTMLElement, task: Task): HTMLElement {
		const list = this.plugin.store.data.lists.find((l) => l.id === task.listId);
		return renderCheckbox(parent, task.done, list?.color ?? null, () => void this.plugin.toggleDone(task.id));
	}

	private selectTask(id: string): void {
		this.flushSaves();
		if (id !== this.selectedId) {
			this.editingNotes = false;
		}
		this.selectedId = id;
		if (this.narrow) {
			this.pane = 'detail';
		}
		this.renderPanes(false);
		this.app.workspace.requestSaveLayout();
	}

	private openTaskMenu(event: MouseEvent, task: Task): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(task.done ? t('markOpen') : t('markDone'))
				.setIcon(task.done ? 'circle' : 'check-circle')
				.onClick(() => void this.plugin.toggleDone(task.id)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t('moveToList'))
				.setIcon('folder-input')
				.onClick(() => this.moveTaskInteractive(task)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t('duplicate'))
				.setIcon('copy')
				.onClick(() => void this.duplicateTask(task)),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t('deleteTask'))
				.setIcon('trash-2')
				.setWarning(true)
				.onClick(() => void this.deleteTaskInteractive(task)),
		);
		menu.showAtMouseEvent(event);
	}

	private moveTaskInteractive(task: Task): void {
		const lists = this.openLists().filter((l) => l.id !== task.listId);
		new ListPicker(
			this.app,
			t('moveToListPlaceholder'),
			lists,
			(list) => void this.moveTaskToList(task.id, list.id),
			(list) => this.listLabel(list.id),
		).open();
	}

	private async moveTaskToList(taskId: string, listId: string): Promise<void> {
		const list = this.plugin.store.data.lists.find((l) => l.id === listId);
		const ok = await this.plugin.updateData((data) => {
			const task = data.tasks.find((item) => item.id === taskId);
			if (task && task.listId !== listId) {
				task.listId = listId;
				task.order = firstOrder(data.tasks.filter((item) => item.listId === listId));
				task.updatedAt = Date.now();
			}
		});
		if (ok && list) {
			new Notice(t('movedToList', { name: list.name }));
		}
	}

	private async duplicateTask(task: Task): Promise<void> {
		const copy = createTask({
			listId: task.listId,
			title: task.title ? t('copyOf', { title: task.title }) : '',
			notes: task.notes,
			start: task.start,
			end: task.end,
			attachments: [...task.attachments],
			links: [...task.links],
			order: task.order + 0.5,
		});
		if (await this.plugin.updateData((data) => data.tasks.push(copy))) {
			this.selectTask(copy.id);
		}
	}

	private async deleteTaskInteractive(task: Task): Promise<void> {
		const ok = await confirmAction(this.app, {
			title: t('deleteTask'),
			message: t('deleteTaskMessage', { title: task.title || t('untitled') }),
			confirmText: t('delete'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		this.cancelSaves(task.id);
		if (this.selectedId === task.id) {
			this.selectedId = null;
			if (this.narrow) {
				this.pane = 'tasks';
			}
		}
		await this.plugin.updateData((data) => removeTask(data, task.id));
	}

	/** Manual reordering only makes sense inside a list (and its nested lists) without a search. */
	private canReorder(task: Task): boolean {
		const list = this.currentList();
		return !!list && !this.query && !task.done && descendantIds(this.plugin.store.data.lists, list.id).has(task.listId);
	}

	private taskDragOptions(task: Task): DragOptions {
		return {
			label: task.title || t('untitled'),
			locate: (target, _x, y) => {
				if (!target || !this.contentEl.contains(target)) {
					return null;
				}
				const listItem = target.closest<HTMLElement>('[data-quests-list]');
				if (listItem) {
					const listId = listItem.dataset.questsList;
					return listId === task.listId || (listId && this.isLocked(listId)) ? null : { el: listItem, position: 'inside' };
				}
				if (!this.canReorder(task)) {
					return null;
				}
				const groupHeader = target.closest<HTMLElement>('[data-quests-group-header]');
				if (groupHeader) {
					return { el: groupHeader, position: 'after' };
				}
				const row = target.closest<HTMLElement>('[data-quests-task]');
				if (row && !row.hasClass('is-done')) {
					return row.dataset.questsTask === task.id ? null : { el: row, position: halfOf(row, y) };
				}
				if (target.closest('.quests-pane-tasks')) {
					const rows = this.tasksPaneEl?.querySelectorAll<HTMLElement>('.quests-task:not(.is-done)');
					const last = rows?.[rows.length - 1];
					return last && last.dataset.questsTask !== task.id ? { el: last, position: 'after' } : null;
				}
				return null;
			},
			drop: (spot) => {
				const listId = spot.el.dataset.questsList;
				if (listId) {
					void this.moveTaskToList(task.id, listId);
				} else {
					void this.dropTask(task.id, spot);
				}
			},
		};
	}

	/** Drops a task next to another task or at the top of a nested list's group, moving it between lists if needed. */
	private async dropTask(id: string, spot: DropSpot): Promise<void> {
		const headerList = spot.el.dataset.questsGroupHeader;
		const targetTaskId = spot.el.dataset.questsTask;
		const targetListId = headerList ?? spot.el.dataset.questsGroup;
		if (!targetListId) {
			return;
		}
		const group = this.visibleTasks()
			.groups.find((g) => g.list?.id === targetListId)
			?.open.map((task) => task.id)
			.filter((taskId) => taskId !== id) ?? [];
		let beforeId: string | null;
		if (headerList !== undefined) {
			beforeId = group[0] ?? null;
		} else if (targetTaskId) {
			beforeId = spot.position === 'before' ? targetTaskId : (group[group.indexOf(targetTaskId) + 1] ?? null);
		} else {
			return;
		}
		const moved = this.plugin.store.data.tasks.find((task) => task.id === id)?.listId !== targetListId;
		const target = this.plugin.store.data.lists.find((l) => l.id === targetListId);
		await this.plugin.updateData((data) => {
			const now = Date.now();
			const byId = new Map(data.tasks.map((task) => [task.id, task]));
			const task = byId.get(id);
			const list = data.lists.find((l) => l.id === targetListId);
			if (!task || !list) {
				return;
			}
			const others = group.map((taskId) => byId.get(taskId)).filter((item): item is Task => !!item);
			if (list.sort !== 'manual') {
				// Dragging in a sorted list keeps the order on screen and switches the list to manual order.
				others.forEach((item, i) => {
					item.order = i + 1;
					item.updatedAt = now;
				});
				list.sort = 'manual';
				list.updatedAt = now;
			}
			task.listId = targetListId;
			task.updatedAt = now;
			for (const changed of placeItem(others, task, beforeId)) {
				const item = byId.get(changed);
				if (item) {
					item.updatedAt = now;
				}
			}
		});
		if (moved && target) {
			new Notice(t('movedToList', { name: target.name }));
		}
	}

	// ---------- Task details ----------

	private renderDetailPane(pane: HTMLElement): void {
		this.detailComponent?.unload();
		this.detailComponent = null;
		pane.empty();
		const task = this.plugin.store.data.tasks.find((item) => item.id === this.selectedId);
		if (!task) {
			const empty = pane.createDiv({ cls: 'quests-empty quests-detail-empty' });
			setIcon(empty.createDiv({ cls: 'quests-empty-icon' }), 'list-checks');
			empty.createDiv({ text: t('selectTaskHint') });
			return;
		}
		this.detailComponent = new Component();
		this.detailComponent.load();
		this.renderTaskDetails(pane, task);
	}

	/** Saves one change to a task. Delayed saves for the same field are merged. */
	private saveTask(id: string, change: (task: Task) => void, delayKey?: string): void {
		const run = () =>
			void this.plugin.updateData((data) => {
				const task = data.tasks.find((item) => item.id === id);
				if (task) {
					change(task);
					task.updatedAt = Date.now();
				}
			});
		if (!delayKey) {
			run();
			return;
		}
		const key = `${id}:${delayKey}`;
		window.clearTimeout(this.saveTimers.get(key));
		this.saveTimers.set(
			key,
			window.setTimeout(() => {
				this.saveTimers.delete(key);
				run();
			}, SAVE_DELAY),
		);
		this.pendingRuns.set(key, run);
	}

	/** Saves typed text right away (before switching tasks or closing). */
	private flushSaves(): void {
		for (const [key, timer] of this.saveTimers) {
			window.clearTimeout(timer);
			this.pendingRuns.get(key)?.();
		}
		this.saveTimers.clear();
		this.pendingRuns.clear();
	}

	private cancelSaves(taskId: string): void {
		for (const [key, timer] of this.saveTimers) {
			if (key.startsWith(`${taskId}:`)) {
				window.clearTimeout(timer);
				this.saveTimers.delete(key);
				this.pendingRuns.delete(key);
			}
		}
	}

	private renderTaskDetails(pane: HTMLElement, task: Task): void {
		const header = pane.createDiv({ cls: 'quests-detail-header' });
		this.renderCheck(header, task);
		const title = header.createEl('textarea', {
			cls: 'quests-title-input',
			attr: { rows: '1', placeholder: t('taskTitlePlaceholder'), 'aria-label': t('taskTitle') },
		});
		title.value = task.title;
		title.toggleClass('is-done', task.done);
		autoGrow(title);
		title.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				title.blur();
			}
		});
		title.addEventListener('input', () => {
			const value = title.value.replace(/\s*\n\s*/g, ' ');
			this.saveTask(task.id, (target) => (target.title = value.trim()), 'title');
		});
		title.addEventListener('blur', () => this.flushSaves());
		if (this.focusTitle) {
			this.focusTitle = false;
			window.setTimeout(() => title.focus(), 0);
		}
		const actions = header.createDiv({ cls: 'quests-detail-actions' });
		iconButton(actions, 'more-horizontal', t('more'), (event) => this.openTaskMenu(event, task));

		const fields = pane.createDiv({ cls: 'quests-fields' });

		// List
		const listField = this.renderField(fields, 'list', t('list'));
		const select = listField.createEl('select', { cls: 'dropdown' });
		for (const list of this.openLists()) {
			select.createEl('option', { text: this.listLabel(list.id), value: list.id });
		}
		select.value = task.listId;
		select.addEventListener('change', () => void this.moveTaskToList(task.id, select.value));

		// Dates
		this.renderDateField(fields, task, 'start');
		this.renderDateField(fields, task, 'end');

		// Notes
		this.renderNotes(pane, task);

		// Links to notes
		this.renderPathSection(pane, task, 'links');

		// Attachments
		this.renderPathSection(pane, task, 'attachments');

		const meta = pane.createDiv({ cls: 'quests-meta quests-muted' });
		meta.createDiv({ text: t('createdAt', { date: formatTimestamp(task.createdAt) }) });
		if (task.done && task.doneAt) {
			meta.createDiv({ text: t('doneAt', { date: formatTimestamp(task.doneAt) }) });
		}
	}

	private renderField(parent: HTMLElement, icon: string, label: string): HTMLElement {
		const field = parent.createDiv({ cls: 'quests-field' });
		const labelEl = field.createDiv({ cls: 'quests-field-label' });
		setIcon(labelEl.createSpan({ cls: 'quests-field-icon' }), icon);
		labelEl.createSpan({ text: label });
		return field.createDiv({ cls: 'quests-field-value' });
	}

	private renderDateField(parent: HTMLElement, task: Task, which: 'start' | 'end'): void {
		const value = which === 'start' ? task.start : task.end;
		const field = this.renderField(parent, which === 'start' ? 'calendar' : 'calendar-check', which === 'start' ? t('startDate') : t('endDate'));
		field.addClass('quests-date-row');
		const dateInput = field.createEl('input', { type: 'date', value: value ? datePart(value) : '' });
		const timeInput = field.createEl('input', { type: 'time', value: value ? (timePart(value) ?? '') : '' });
		timeInput.toggleClass('is-hidden', !value);
		// A click anywhere on the row (label included) opens the date picker; on the time input, the time picker.
		const openPicker = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest('button')) {
				return;
			}
			openNativePicker(target === timeInput ? timeInput : dateInput);
		};
		field.addEventListener('click', openPicker);
		field.previousElementSibling?.addEventListener('click', openPicker as EventListener);
		field.previousElementSibling?.addClass('is-clickable');
		if (which === 'end' && isOverdue(task)) {
			dateInput.addClass('is-overdue');
		}
		if (which === 'start' && value && !timePart(value)) {
			field.createSpan({ cls: 'quests-muted quests-small quests-date-hint', text: t('allDayHint') });
		}
		if (which === 'end' && value) {
			iconButton(field, 'x', t('clearEndDate'), () => this.saveTask(task.id, (target) => (target.end = null)));
		} else {
			// Keeps both date rows the same width on phones, where the clear button would otherwise shift one.
			field.createSpan({ cls: 'quests-date-spacer' });
		}

		const commit = () => {
			const date = dateInput.value;
			const time = timeInput.value || null;
			timeInput.toggleClass('is-hidden', !date);
			const year = Number(date.slice(0, 4));
			if (date && (year < 1900 || year > 2200)) {
				// Still typing the year.
				return;
			}
			if (which === 'start' && !date) {
				// The start date is required.
				return;
			}
			const next = date ? withTime(date, time) : null;
			this.saveTask(
				task.id,
				(target) => {
					if (which === 'start' && next) {
						if (target.end && datePart(target.end) < datePart(next)) {
							// Moving the start past the end moves the end too, keeping the length.
							target.end = shiftDays(target.end, daysBetween(datePart(target.start), datePart(next)));
						}
						target.start = next;
					} else if (which === 'end') {
						target.end = next && datePart(next) < datePart(target.start) ? target.end : next;
					}
				},
				which,
			);
			if (which === 'end' && next && datePart(next) < datePart(this.currentTask(task.id)?.start ?? next)) {
				new Notice(t('endBeforeStart'));
			}
		};
		dateInput.addEventListener('change', commit);
		timeInput.addEventListener('change', commit);
		dateInput.addEventListener('blur', () => {
			this.flushSaves();
			if (which === 'start' && !dateInput.value) {
				dateInput.value = datePart(this.currentTask(task.id)?.start ?? task.start);
			}
		});
		timeInput.addEventListener('blur', () => this.flushSaves());
	}

	private currentTask(id: string): Task | undefined {
		return this.plugin.store.data.tasks.find((item) => item.id === id);
	}

	private renderNotes(pane: HTMLElement, task: Task): void {
		const section = pane.createDiv({ cls: 'quests-section' });
		const head = section.createDiv({ cls: 'quests-section-header' });
		setIcon(head.createSpan({ cls: 'quests-field-icon' }), 'align-left');
		head.createSpan({ text: t('description') });
		const body = section.createDiv({ cls: 'quests-notes' });
		// The latest text, even before it is saved.
		let notes = task.notes;

		const showPreview = () => {
			body.empty();
			const preview = body.createDiv({ cls: 'quests-notes-preview markdown-rendered' });
			const current = notes;
			if (!current.trim()) {
				preview.addClass('is-empty');
				preview.setText(t('descriptionPlaceholder'));
			} else if (this.detailComponent) {
				void MarkdownRenderer.render(this.app, current, preview, this.plugin.store.path, this.detailComponent);
			}
			preview.addEventListener('click', (event) => {
				const link = (event.target as HTMLElement).closest('a');
				if (link) {
					this.handleNotesLink(event, link);
					return;
				}
				showEditor();
			});
			preview.addEventListener('mouseover', (event) => {
				const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a.internal-link');
				if (link) {
					this.app.workspace.trigger('hover-link', {
						event,
						source: 'preview',
						hoverParent: this,
						targetEl: link,
						linktext: link.dataset.href ?? link.getAttribute('href') ?? '',
						sourcePath: this.plugin.store.path,
					});
				}
			});
		};

		const showEditor = () => {
			this.editingNotes = true;
			body.empty();
			const textarea = body.createEl('textarea', {
				cls: 'quests-notes-input',
				attr: { placeholder: t('descriptionPlaceholder'), 'aria-label': t('description') },
			});
			textarea.value = notes;
			autoGrow(textarea);
			textarea.addEventListener('input', () => {
				const value = (notes = textarea.value);
				this.saveTask(task.id, (target) => (target.notes = value), 'notes');
			});
			textarea.addEventListener('blur', () => {
				this.flushSaves();
				this.editingNotes = false;
				showPreview();
			});
			textarea.addEventListener('keydown', (event) => {
				if (event.key === 'Escape') {
					event.stopPropagation();
					textarea.blur();
				}
			});
			window.setTimeout(() => textarea.focus(), 0);
		};

		if (this.editingNotes) {
			showEditor();
		} else {
			showPreview();
		}
	}

	private handleNotesLink(event: MouseEvent, link: HTMLAnchorElement): void {
		if (link.hasClass('internal-link')) {
			event.preventDefault();
			const target = link.dataset.href ?? link.getAttribute('href') ?? '';
			void this.app.workspace.openLinkText(target, this.plugin.store.path, Keymap.isModEvent(event));
		}
		// External links are opened by Obsidian.
	}

	private renderPathSection(pane: HTMLElement, task: Task, kind: 'links' | 'attachments'): void {
		const section = pane.createDiv({ cls: 'quests-section' });
		const head = section.createDiv({ cls: 'quests-section-header' });
		setIcon(head.createSpan({ cls: 'quests-field-icon' }), kind === 'links' ? 'link' : 'paperclip');
		head.createSpan({ text: kind === 'links' ? t('linkedNotes') : t('attachments') });
		const headActions = head.createDiv({ cls: 'quests-section-actions' });
		if (kind === 'links') {
			iconButton(headActions, 'plus', t('addLink'), () => this.pickLink(task));
		} else {
			iconButton(headActions, 'folder-open', t('attachFromVault'), () => this.pickAttachment(task));
			iconButton(headActions, 'upload', t('uploadFile'), () => this.uploadAttachment(task));
		}

		const paths = kind === 'links' ? task.links : task.attachments;
		const list = section.createDiv({ cls: 'quests-path-list' });
		if (!paths.length) {
			list.createDiv({ cls: 'quests-muted quests-small', text: kind === 'links' ? t('noLinks') : t('noAttachments') });
		}
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path);
			const item = list.createDiv({ cls: 'quests-path-item' });
			item.toggleClass('is-missing', !file);
			const extension = (path.split('.').pop() ?? '').toLowerCase();
			if (kind === 'attachments' && file && IMAGE_EXTENSIONS.includes(extension)) {
				item.createEl('img', { cls: 'quests-thumb', attr: { src: this.app.vault.getResourcePath(file), alt: '' } });
			} else {
				setIcon(item.createSpan({ cls: 'quests-path-icon' }), this.iconFor(kind, extension));
			}
			const text = item.createDiv({ cls: 'quests-path-text' });
			const name = path.split('/').pop() ?? path;
			text.createDiv({ cls: 'quests-path-name', text: kind === 'links' && extension === 'md' ? name.slice(0, -3) : name });
			text.createDiv({ cls: 'quests-path-sub', text: file ? path : t('fileMissing') });
			if (file) {
				makeActivatable(item, () => void this.app.workspace.openLinkText(path, '', false));
				item.addEventListener('auxclick', (event) => {
					if (event.button === 1) {
						void this.app.workspace.openLinkText(path, '', true);
					}
				});
			}
			const remove = () =>
				this.saveTask(task.id, (target) => {
					target[kind] = target[kind].filter((p) => p !== path);
				});
			iconButton(item, 'x', kind === 'links' ? t('removeLink') : t('detach'), remove);
			item.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				const menu = new Menu();
				if (file) {
					menu.addItem((mi) =>
						mi
							.setTitle(t('openInNewTab'))
							.setIcon('file-plus')
							.onClick(() => void this.app.workspace.openLinkText(path, '', true)),
					);
				}
				menu.addItem((mi) => mi.setTitle(kind === 'links' ? t('removeLink') : t('detach')).setIcon('x').onClick(remove));
				if (kind === 'attachments' && file && path.startsWith(`${this.plugin.store.attachmentsFolder}/`)) {
					menu.addItem((mi) =>
						mi
							.setTitle(t('detachAndDelete'))
							.setIcon('trash-2')
							.setWarning(true)
							.onClick(() => void this.deleteAttachment(task, file)),
					);
				}
				menu.showAtMouseEvent(event);
			});
		}
	}

	private iconFor(kind: 'links' | 'attachments', extension: string): string {
		if (kind === 'links') {
			return extension === 'canvas' ? 'layout-dashboard' : 'file-text';
		}
		if (extension === 'pdf') {
			return 'file-text';
		}
		if (['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm'].includes(extension)) {
			return 'file-audio';
		}
		if (['mp4', 'mov', 'mkv', 'avi'].includes(extension)) {
			return 'file-video';
		}
		return 'file';
	}

	private pickLink(task: Task): void {
		new FilePicker(
			this.app,
			t('pickNote'),
			() => this.app.vault.getFiles().filter((f) => (f.extension === 'md' || f.extension === 'canvas') && !task.links.includes(f.path)),
			(file) => this.saveTask(task.id, (target) => (target.links = [...target.links.filter((p) => p !== file.path), file.path])),
		).open();
	}

	private pickAttachment(task: Task): void {
		const dataPath = this.plugin.store.path;
		new FilePicker(
			this.app,
			t('pickFile'),
			() => this.app.vault.getFiles().filter((f) => f.path !== dataPath && !task.attachments.includes(f.path)),
			(file) => this.saveTask(task.id, (target) => (target.attachments = [...target.attachments.filter((p) => p !== file.path), file.path])),
		).open();
	}

	private uploadAttachment(task: Task): void {
		const input = this.contentEl.createEl('input', { type: 'file', cls: 'is-hidden', attr: { multiple: '' } });
		input.addEventListener('change', () => {
			const files = Array.from(input.files ?? []);
			input.remove();
			if (files.length) {
				void this.saveUploads(task.id, files);
			}
		});
		input.click();
	}

	private async saveUploads(taskId: string, files: File[]): Promise<void> {
		const store = this.plugin.store;
		const added: string[] = [];
		try {
			await store.ensureFolder(store.attachmentsFolder);
			for (const file of files) {
				const path = this.availablePath(store.attachmentsFolder, file.name);
				await this.app.vault.createBinary(path, await file.arrayBuffer());
				added.push(path);
			}
		} catch (err) {
			console.error('Quests List: upload failed', err);
			new Notice(t('uploadFailed'));
		}
		if (added.length) {
			this.saveTask(taskId, (target) => (target.attachments = [...target.attachments, ...added]));
			new Notice(t('filesAttached', { count: added.length }));
		}
	}

	private availablePath(folder: string, name: string): string {
		const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, '_').trim() || 'file';
		const dot = clean.lastIndexOf('.');
		const base = dot > 0 ? clean.slice(0, dot) : clean;
		const ext = dot > 0 ? clean.slice(dot) : '';
		let path = normalizePath(`${folder}/${clean}`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			path = normalizePath(`${folder}/${base} ${i}${ext}`);
		}
		return path;
	}

	private async deleteAttachment(task: Task, file: TFile): Promise<void> {
		const usedElsewhere = this.plugin.store.data.tasks.some((other) => other.id !== task.id && other.attachments.includes(file.path));
		const ok = await confirmAction(this.app, {
			title: t('detachAndDelete'),
			message: usedElsewhere ? t('deleteFileShared', { name: file.name }) : t('deleteFileMessage', { name: file.name }),
			confirmText: t('delete'),
			danger: true,
		});
		if (!ok) {
			return;
		}
		this.saveTask(task.id, (target) => (target.attachments = target.attachments.filter((p) => p !== file.path)));
		if (!usedElsewhere) {
			await this.app.fileManager.trashFile(file);
		}
	}
}
