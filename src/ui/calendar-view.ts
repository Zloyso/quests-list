import { ItemView, Menu, Platform, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import {
	addDays,
	addMonths,
	datePart,
	daysBetween,
	formatLongDate,
	formatMonthTitle,
	formatTime,
	shiftDays,
	startOfMonth,
	timePart,
	todayStr,
	weekday,
	weekdayNames,
} from '../dates';
import { t } from '../i18n';
import type QuestsPlugin from '../main';
import { descendantIds, lastDay, listIcon, type ListColor, listPath, listTree, type Task } from '../model';
import type { CalendarEvent } from '../sync/types';
import { type DragOptions, makeDraggable } from './drag';
import { EventModal, eventTimeText, ListPicker, promptText } from './modals';
import { iconButton, makeActivatable, renderCheckbox, setColor, textButton } from './widgets';

export const VIEW_TYPE_CALENDAR = 'quests-list-calendar';

const NARROW_WIDTH = 640;
const MAX_CHIPS = 3;
/** Longest span drawn day by day. */
const MAX_SPAN_DAYS = 366;

type DayItem = { kind: 'task'; task: Task; sortKey: string } | { kind: 'event'; event: CalendarEvent; sortKey: string };

/** Tasks first among all-day items, then timed items by time. */
function sortKeyFor(allDay: boolean, start: string, kind: 'task' | 'event', title: string): string {
	return `${allDay ? '0' : `1${timePart(start) ?? ''}`}${kind === 'task' ? 'a' : 'b'}${title.toLocaleLowerCase()}`;
}

export class CalendarView extends ItemView {
	private month = startOfMonth(todayStr());
	private selected = todayStr();
	private narrow = false;
	private showDone = true;
	private hidden = new Set<string>();
	private resizeObserver: ResizeObserver | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: QuestsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CALENDAR;
	}

	getDisplayText(): string {
		return t('calendarTitle');
	}

	getIcon(): string {
		return 'calendar-days';
	}

	getState(): Record<string, unknown> {
		return { month: this.month, showDone: this.showDone, hidden: [...this.hidden] };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const o = (typeof state === 'object' && state !== null ? state : {}) as Record<string, unknown>;
		if (typeof o.month === 'string' && /^\d{4}-\d{2}-01$/.test(o.month)) {
			this.month = o.month;
		}
		if (typeof o.showDone === 'boolean') {
			this.showDone = o.showDone;
		}
		if (Array.isArray(o.hidden)) {
			this.hidden = new Set(o.hidden.filter((id): id is string => typeof id === 'string'));
		}
		await super.setState(state, result);
		this.refresh();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('quests-view');
		this.narrow = this.computeNarrow();
		this.resizeObserver = new ResizeObserver(() => {
			const narrow = this.computeNarrow();
			if (narrow !== this.narrow) {
				this.narrow = narrow;
				window.setTimeout(() => this.refresh(), 0);
			}
		});
		this.resizeObserver.observe(this.contentEl);
		this.registerDomEvent(this.contentEl, 'pointerdown', () => this.plugin.noteActivity());
		this.registerDomEvent(this.contentEl, 'keydown', () => this.plugin.noteActivity());
		this.refresh();
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.contentEl.empty();
	}

	private computeNarrow(): boolean {
		const width = this.contentEl.clientWidth;
		return Platform.isPhone || (width > 0 ? width < NARROW_WIDTH : this.narrow);
	}

	refresh(): void {
		const scroll = this.contentEl.querySelector('.quests-agenda')?.scrollTop ?? 0;
		this.contentEl.empty();
		if (!this.plugin.store.loaded) {
			this.contentEl.createDiv({ cls: 'quests-empty', text: t('loading') });
			return;
		}
		const root = this.contentEl.createDiv({ cls: 'quests-calendar' });
		root.toggleClass('is-narrow', this.narrow);
		this.renderToolbar(root.createDiv({ cls: 'quests-toolbar' }));
		this.renderFilters(root);
		const body = root.createDiv({ cls: 'quests-cal-body' });
		const index = this.buildIndex();
		this.renderMonth(body.createDiv({ cls: 'quests-cal-month' }), index);
		const agenda = body.createDiv({ cls: 'quests-agenda quests-scroll' });
		this.renderAgenda(agenda, index.get(this.selected) ?? []);
		agenda.scrollTop = scroll;
	}

	private goTo(month: string): void {
		this.month = startOfMonth(month);
		this.refresh();
		this.app.workspace.requestSaveLayout();
	}

	private renderToolbar(bar: HTMLElement): void {
		const nav = bar.createDiv({ cls: 'quests-cal-nav' });
		iconButton(nav, 'chevron-left', t('previousMonth'), () => this.goTo(addMonths(this.month, -1)));
		nav
			.createEl('button', { cls: 'quests-today-button', text: t('todayButton'), attr: { type: 'button' } })
			.addEventListener('click', () => {
				this.selected = todayStr();
				this.goTo(todayStr());
			});
		iconButton(nav, 'chevron-right', t('nextMonth'), () => this.goTo(addMonths(this.month, 1)));
		bar.createDiv({ cls: 'quests-cal-title', text: formatMonthTitle(this.month) });

		const actions = bar.createDiv({ cls: 'quests-toolbar-actions' });
		textButton(actions, 'plus', t('newTask'), () => void this.addTaskOn(this.selected));
		iconButton(actions, 'sliders-horizontal', t('viewOptions'), (event) => this.openOptionsMenu(event));
		if (this.plugin.settings.accounts.some((a) => a.enabled)) {
			const sync = iconButton(actions, 'refresh-cw', this.syncTooltip(), () => void this.plugin.syncNow(true), 'quests-sync-button');
			sync.toggleClass('is-spinning', this.plugin.sync.running);
			const failed = this.plugin.settings.accounts.some((a) => a.enabled && this.plugin.settings.status[a.id]?.error);
			sync.toggleClass('has-error', failed);
		}
		iconButton(actions, 'list-checks', t('openTasks'), () => void this.plugin.openTasks());
	}

	private syncTooltip(): string {
		const times = this.plugin.settings.accounts
			.filter((a) => a.enabled)
			.map((a) => this.plugin.settings.status[a.id]?.lastSync ?? 0);
		const last = times.length ? Math.min(...times) : 0;
		return last ? t('syncNowLast', { time: new Date(last).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }) : t('syncNow');
	}

	// ---------- What is shown ----------

	/** Ids of everything that can be shown or hidden: lists and enabled calendars. */
	private sourceIds(): string[] {
		return [
			...this.plugin.store.data.lists.map((l) => l.id),
			...this.plugin.settings.accounts.filter((a) => a.enabled).map((a) => a.id),
		];
	}

	private setHidden(hidden: Set<string>): void {
		this.hidden = hidden;
		this.refresh();
		this.app.workspace.requestSaveLayout();
	}

	/** A list together with its nested lists; a calendar on its own. */
	private scopeOf(id: string): Set<string> {
		const lists = this.plugin.store.data.lists;
		return lists.some((l) => l.id === id) ? descendantIds(lists, id) : new Set([id]);
	}

	private toggleSource(id: string): void {
		const hidden = new Set(this.hidden);
		const hide = !hidden.has(id);
		for (const member of this.scopeOf(id)) {
			if (hide) {
				hidden.add(member);
			} else {
				hidden.delete(member);
			}
		}
		this.setHidden(hidden);
	}

	/** Shows only one list (with its nested lists) or one calendar. */
	private showOnly(id: string): void {
		const keep = this.scopeOf(id);
		this.setHidden(new Set(this.sourceIds().filter((other) => !keep.has(other))));
	}

	/** Chips that switch lists and calendars on and off. */
	private renderFilters(root: HTMLElement): void {
		const lists = listTree(this.plugin.store.data.lists, this.plugin.settings.listsByName).map((node) => node.list);
		const accounts = this.plugin.settings.accounts.filter((a) => a.enabled);
		if (lists.length + accounts.length < 2) {
			return;
		}
		const bar = root.createDiv({ cls: 'quests-cal-filters' });
		const anyHidden = this.sourceIds().some((id) => this.hidden.has(id));
		const all = bar.createDiv({ cls: 'quests-filter-chip is-all', text: t('filterAll') });
		all.toggleClass('is-off', anyHidden);
		all.setAttr('aria-pressed', String(!anyHidden));
		makeActivatable(all, () => this.setHidden(new Set()));

		const chip = (id: string, icon: string, color: ListColor | null, name: string) => {
			const el = bar.createDiv({ cls: 'quests-filter-chip' });
			const on = !this.hidden.has(id);
			el.toggleClass('is-off', !on);
			el.setAttr('aria-pressed', String(on));
			setColor(el, color);
			setIcon(el.createSpan({ cls: 'quests-filter-icon' }), icon);
			el.createSpan({ cls: 'quests-filter-label', text: name });
			setTooltip(el, t('filterHint'));
			makeActivatable(el, () => this.toggleSource(id));
			el.addEventListener('contextmenu', (event) => {
				event.preventDefault();
				const menu = new Menu();
				menu.addItem((item) => item.setTitle(t('showOnlyThis')).setIcon('eye').onClick(() => this.showOnly(id)));
				menu.addItem((item) => item.setTitle(t('showAll')).setIcon('eye-off').onClick(() => this.setHidden(new Set())));
				menu.showAtMouseEvent(event);
			});
		};
		for (const list of lists) {
			chip(list.id, listIcon(list), list.color, list.name);
		}
		if (accounts.length && lists.length) {
			bar.createSpan({ cls: 'quests-filter-separator' });
		}
		for (const account of accounts) {
			chip(account.id, 'calendar', account.color, account.name);
		}
	}

	private openOptionsMenu(event: MouseEvent): void {
		const menu = new Menu();
		const all = this.plugin.store.data.lists;
		const lists = listTree(all, this.plugin.settings.listsByName).map((node) => node.list);
		if (lists.length > 1) {
			menu.addItem((item) =>
				item
					.setTitle(t('showOnlyList'))
					.setIcon('filter')
					.onClick(() =>
						new ListPicker(
							this.app,
							t('showOnlyListPlaceholder'),
							lists,
							(list) => this.showOnly(list.id),
							(list) => listPath(all, list.id).join(' / '),
						).open(),
					),
			);
		}
		if (this.sourceIds().some((id) => this.hidden.has(id))) {
			menu.addItem((item) => item.setTitle(t('showAll')).setIcon('eye').onClick(() => this.setHidden(new Set())));
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t('completedTasks'))
				.setChecked(this.showDone)
				.onClick(() => {
					this.showDone = !this.showDone;
					this.refresh();
					this.app.workspace.requestSaveLayout();
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle(t('weekStartsMonday'))
				.setChecked(this.plugin.settings.weekStart === 1)
				.onClick(async () => {
					this.plugin.settings.weekStart = this.plugin.settings.weekStart === 1 ? 0 : 1;
					await this.plugin.saveSettings();
					this.refresh();
				}),
		);
		menu.showAtMouseEvent(event);
	}

	// ---------- Month grid ----------

	private gridStart(): string {
		const offset = (weekday(this.month) - this.plugin.settings.weekStart + 7) % 7;
		return addDays(this.month, -offset);
	}

	/** Items per day for the 6 visible weeks. */
	private buildIndex(): Map<string, DayItem[]> {
		const first = this.gridStart();
		const last = addDays(first, 41);
		const index = new Map<string, DayItem[]>();
		const add = (from: string, to: string, item: DayItem) => {
			let day = from < first ? first : from;
			const end = to > last ? last : to;
			for (let i = 0; day <= end && i < MAX_SPAN_DAYS; i++, day = addDays(day, 1)) {
				const list = index.get(day);
				if (list) {
					list.push(item);
				} else {
					index.set(day, [item]);
				}
			}
		};
		// The selected day may be outside the grid; include it too.
		const covers = (from: string, to: string) => (to >= first && from <= last) || (from <= this.selected && this.selected <= to);
		const addCovering = (from: string, to: string, item: DayItem) => {
			add(from, to, item);
			if ((this.selected < first || this.selected > last) && from <= this.selected && this.selected <= to) {
				index.set(this.selected, [...(index.get(this.selected) ?? []), item]);
			}
		};

		for (const task of this.plugin.store.data.tasks) {
			if ((task.done && !this.showDone) || this.hidden.has(task.listId)) {
				continue;
			}
			const from = datePart(task.start);
			const to = lastDay(task);
			if (covers(from, to)) {
				addCovering(from, to, { kind: 'task', task, sortKey: sortKeyFor(!timePart(task.start), task.start, 'task', task.title) });
			}
		}
		for (const event of this.plugin.sync.events()) {
			if (this.hidden.has(event.accountId)) {
				continue;
			}
			const from = datePart(event.start);
			let to = datePart(event.end);
			// An event ending at midnight does not reach into the next day.
			if (!event.allDay && to > from && timePart(event.end) === '00:00') {
				to = addDays(to, -1);
			}
			if (covers(from, to)) {
				addCovering(from, to, { kind: 'event', event, sortKey: sortKeyFor(event.allDay, event.start, 'event', event.title) });
			}
		}
		for (const items of index.values()) {
			items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
		}
		return index;
	}

	private renderMonth(container: HTMLElement, index: Map<string, DayItem[]>): void {
		const head = container.createDiv({ cls: 'quests-cal-weekdays' });
		for (const name of weekdayNames(this.plugin.settings.weekStart)) {
			head.createDiv({ cls: 'quests-cal-weekday', text: name });
		}
		const grid = container.createDiv({ cls: 'quests-cal-grid' });
		const today = todayStr();
		const first = this.gridStart();
		for (let i = 0; i < 42; i++) {
			const date = addDays(first, i);
			const cell = grid.createDiv({ cls: 'quests-cal-day' });
			cell.dataset.questsDate = date;
			cell.toggleClass('is-other-month', date.slice(0, 7) !== this.month.slice(0, 7));
			cell.toggleClass('is-today', date === today);
			cell.toggleClass('is-selected', date === this.selected);
			const wd = weekday(date);
			cell.toggleClass('is-weekend', wd === 0 || wd === 6);
			cell.createDiv({ cls: 'quests-cal-date', text: String(Number(date.slice(8, 10))) });

			const items = index.get(date) ?? [];
			if (this.narrow) {
				const dots = cell.createDiv({ cls: 'quests-cal-dots' });
				for (const item of items.slice(0, 4)) {
					setColor(dots.createSpan({ cls: 'quests-cal-dot' }), this.colorOf(item));
				}
			} else {
				const chips = cell.createDiv({ cls: 'quests-cal-chips' });
				const shown = items.length > MAX_CHIPS ? MAX_CHIPS - 1 : MAX_CHIPS;
				for (const item of items.slice(0, shown)) {
					this.renderChip(chips, item, date);
				}
				if (items.length > shown) {
					chips.createDiv({ cls: 'quests-cal-more', text: t('moreItems', { count: items.length - shown }) });
				}
			}

			cell.addEventListener('click', () => {
				this.selected = date;
				if (date.slice(0, 7) !== this.month.slice(0, 7)) {
					this.month = startOfMonth(date);
				}
				this.refresh();
			});
			cell.addEventListener('dblclick', (event) => {
				if (!(event.target as HTMLElement).closest('.quests-chip')) {
					void this.addTaskOn(date);
				}
			});
		}
	}

	private colorOf(item: DayItem) {
		if (item.kind === 'task') {
			return this.plugin.store.data.lists.find((l) => l.id === item.task.listId)?.color ?? null;
		}
		return this.plugin.settings.accounts.find((a) => a.id === item.event.accountId)?.color ?? null;
	}

	private renderChip(parent: HTMLElement, item: DayItem, date: string): void {
		const chip = parent.createDiv({ cls: `quests-chip is-${item.kind}` });
		setColor(chip, this.colorOf(item));
		if (item.kind === 'task') {
			const { task } = item;
			chip.toggleClass('is-done', task.done);
			chip.toggleClass('is-continued', datePart(task.start) < date);
			if (task.done) {
				setIcon(chip.createSpan({ cls: 'quests-chip-icon' }), 'check');
			}
			const time = timePart(task.start);
			if (time && datePart(task.start) === date) {
				chip.createSpan({ cls: 'quests-chip-time', text: formatTime(task.start) });
			}
			chip.createSpan({ cls: 'quests-chip-title', text: task.title || t('untitled') });
			setTooltip(chip, task.title || t('untitled'));
			makeActivatable(chip, () => void this.plugin.openTask(task.id));
			makeDraggable(chip, null, () => this.taskDragOptions(task, date));
		} else {
			const { event } = item;
			chip.toggleClass('is-all-day', event.allDay);
			chip.toggleClass('is-continued', datePart(event.start) < date);
			if (!event.allDay && datePart(event.start) === date) {
				chip.createSpan({ cls: 'quests-chip-time', text: formatTime(event.start) });
			}
			chip.createSpan({ cls: 'quests-chip-title', text: event.title });
			setTooltip(chip, event.title);
			makeActivatable(chip, () => this.openEvent(event));
		}
		chip.addEventListener('click', (e) => e.stopPropagation());
	}

	private taskDragOptions(task: Task, fromDate: string): DragOptions {
		return {
			label: task.title || t('untitled'),
			locate: (target) => {
				const cell = target?.closest<HTMLElement>('[data-quests-date]');
				return cell && this.contentEl.contains(cell) && cell.dataset.questsDate !== fromDate ? { el: cell, position: 'inside' } : null;
			},
			drop: (spot) => {
				const toDate = spot.el.dataset.questsDate;
				if (toDate) {
					void this.moveTask(task.id, daysBetween(fromDate, toDate));
				}
			},
		};
	}

	private async moveTask(id: string, days: number): Promise<void> {
		if (!days) {
			return;
		}
		await this.plugin.updateData((data) => {
			const task = data.tasks.find((item) => item.id === id);
			if (task) {
				task.start = shiftDays(task.start, days);
				task.end = task.end ? shiftDays(task.end, days) : null;
				task.updatedAt = Date.now();
			}
		});
	}

	private openEvent(event: CalendarEvent): void {
		const account = this.plugin.settings.accounts.find((a) => a.id === event.accountId);
		new EventModal(this.app, event, account?.name ?? '').open();
	}

	private async addTaskOn(date: string): Promise<void> {
		const title = await promptText(this.app, { title: t('newTaskOn', { date: formatLongDate(date) }), placeholder: t('taskTitlePlaceholder') });
		if (!title) {
			return;
		}
		const listId = await this.plugin.ensureDefaultList();
		if (listId) {
			this.selected = date;
			await this.plugin.createTask({ listId, title, start: date });
		}
	}

	// ---------- Agenda ----------

	private renderAgenda(container: HTMLElement, items: DayItem[]): void {
		const header = container.createDiv({ cls: 'quests-agenda-header' });
		header.createDiv({ cls: 'quests-agenda-title', text: formatLongDate(this.selected) });
		iconButton(header, 'plus', t('newTask'), () => void this.addTaskOn(this.selected));

		if (!items.length) {
			container.createDiv({ cls: 'quests-muted quests-agenda-empty', text: t('nothingPlanned') });
			return;
		}
		for (const item of items) {
			const row = container.createDiv({ cls: `quests-agenda-item is-${item.kind}` });
			setColor(row, this.colorOf(item));
			if (item.kind === 'task') {
				const { task } = item;
				row.toggleClass('is-done', task.done);
				renderCheckbox(row, task.done, this.colorOf(item), () => void this.plugin.toggleDone(task.id));
				const text = row.createDiv({ cls: 'quests-agenda-text' });
				text.createDiv({ cls: 'quests-agenda-item-title', text: task.title || t('untitled') });
				const list = this.plugin.store.data.lists.find((l) => l.id === task.listId);
				text.createDiv({ cls: 'quests-agenda-item-sub', text: [this.taskTimeText(task), list?.name ?? ''].filter(Boolean).join(' · ') });
				makeActivatable(row, () => void this.plugin.openTask(task.id));
			} else {
				const { event } = item;
				row.createSpan({ cls: 'quests-agenda-bar' });
				const text = row.createDiv({ cls: 'quests-agenda-text' });
				text.createDiv({ cls: 'quests-agenda-item-title', text: event.title });
				const account = this.plugin.settings.accounts.find((a) => a.id === event.accountId);
				text.createDiv({ cls: 'quests-agenda-item-sub', text: [eventTimeText(event), account?.name ?? ''].filter(Boolean).join(' · ') });
				makeActivatable(row, () => this.openEvent(event));
			}
		}
	}

	private taskTimeText(task: Task): string {
		const start = datePart(task.start);
		const end = lastDay(task);
		if (start !== end) {
			return t('dayOfSpan', { day: daysBetween(start, this.selected) + 1, total: daysBetween(start, end) + 1 });
		}
		if (timePart(task.start)) {
			return task.end && timePart(task.end) ? `${formatTime(task.start)} – ${formatTime(task.end)}` : formatTime(task.start);
		}
		return t('allDay');
	}
}
