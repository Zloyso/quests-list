import { menus, notices, openModals } from './obsidian-stub';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayStr } from '../src/dates';
import QuestsPlugin from '../src/main';
import { CalendarView, VIEW_TYPE_CALENDAR } from '../src/ui/calendar-view';
import { FolderSuggest } from '../src/ui/folder-suggest';
import { QuestsSettingTab } from '../src/ui/settings-tab';
import { TasksView, VIEW_TYPE_TASKS } from '../src/ui/tasks-view';
import { createApp, type FakeApp, type FakeLeaf, tick } from './fake-app';

const DATA = 'Quests/quests.json';

async function start(): Promise<{ app: FakeApp; plugin: QuestsPlugin; view: TasksView }> {
	const app = createApp();
	const plugin = new QuestsPlugin(app as never, {} as never);
	app.setViewFactory((type, leaf) =>
		type === VIEW_TYPE_TASKS ? new TasksView(leaf as never, plugin) : new CalendarView(leaf as never, plugin),
	);
	await plugin.onload();
	await tick();
	const view = (await plugin.openTasks()) as TasksView;
	// Wide layout: three panes.
	Object.defineProperty(view.contentEl, 'clientWidth', { value: 1200 });
	view.refresh();
	return { app, plugin, view };
}

const $ = <T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string) => {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`Not found: ${selector}`);
	return el;
};
const $$ = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector));
const taskTitles = (view: TasksView) => $$(view.contentEl, '.quests-pane-tasks .quests-task .quests-task-title').map((el) => el.textContent);
const settle = async () => {
	for (let i = 0; i < 5; i++) await tick();
};

async function quickAdd(view: TasksView, title: string) {
	const input = $<HTMLInputElement>(view.contentEl, '.quests-quick-add input');
	input.value = title;
	$(view.contentEl, '.quests-quick-add').dispatchEvent(new Event('submit', { cancelable: true }));
	await settle();
}

async function answerPrompt(value: string) {
	const modal = openModals[openModals.length - 1]!;
	$<HTMLInputElement>(modal.contentEl, 'input').value = value;
	$(modal.contentEl, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
	await settle();
}

function pointer(type: string, x: number, y: number, target: EventTarget = window, pointerType = 'mouse') {
	target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType, button: 0, bubbles: true, cancelable: true }));
}

/** Drags `source` and releases it over `target` (jsdom has no layout, so hit testing is faked). */
async function drag(source: HTMLElement, target: HTMLElement, half: 'top' | 'bottom' | 'middle' = 'middle') {
	const rect = { top: 100, bottom: 140, height: 40, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) };
	target.getBoundingClientRect = () => rect as DOMRect;
	const y = half === 'top' ? 105 : half === 'bottom' ? 135 : 120;
	document.elementFromPoint = () => target;
	pointer('pointerdown', 10, 10, source);
	pointer('pointermove', 30, 40);
	pointer('pointermove', 50, y);
	pointer('pointerup', 50, y);
	await settle();
}

beforeEach(() => {
	notices.length = 0;
	menus.length = 0;
	openModals.length = 0;
	document.body.empty();
});

afterEach(async () => {
	await settle();
});

describe('tasks view', () => {
	it('adds tasks, creating the inbox list on first use', async () => {
		const { app, plugin, view } = await start();
		expect($$(view.contentEl, '.quests-pane').length).toBe(3);
		await quickAdd(view, 'Buy milk');
		await quickAdd(view, 'Call mom');
		expect(plugin.store.data.lists.map((l) => l.name)).toEqual(['Inbox']);
		expect(taskTitles(view)).toEqual(['Buy milk', 'Call mom']);
		expect(JSON.parse(app.files.get(DATA)!.text).tasks).toHaveLength(2);
		// "Today" shows them with the list name.
		expect($(view.contentEl, '.quests-task-list-name').textContent).toBe('Inbox');
	});

	it('edits a task in the detail pane', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'Draft');
		$(view.contentEl, '.quests-task').click();
		const title = $<HTMLTextAreaElement>(view.contentEl, '.quests-title-input');
		expect(title.value).toBe('Draft');
		title.focus();
		title.value = 'Final draft';
		title.dispatchEvent(new Event('input'));
		// While typing, the detail pane is kept (the textarea stays the same element).
		title.dispatchEvent(new Event('blur'));
		await settle();
		expect(plugin.store.data.tasks[0]!.title).toBe('Final draft');
		expect(taskTitles(view)).toEqual(['Final draft']);

		const [startDate, , endDate] = $$(view.contentEl, '.quests-date-row input') as HTMLInputElement[];
		expect(startDate!.value).toBe(todayStr());
		endDate!.value = addDays(todayStr(), 2);
		endDate!.dispatchEvent(new Event('change'));
		endDate!.dispatchEvent(new Event('blur'));
		await settle();
		expect(plugin.store.data.tasks[0]!.end).toBe(addDays(todayStr(), 2));

		// Moving the start past the end moves the end too.
		const startInput = $$(view.contentEl, '.quests-date-row input')[0] as HTMLInputElement;
		startInput.value = addDays(todayStr(), 5);
		startInput.dispatchEvent(new Event('change'));
		startInput.dispatchEvent(new Event('blur'));
		await settle();
		expect(plugin.store.data.tasks[0]).toMatchObject({ start: addDays(todayStr(), 5), end: addDays(todayStr(), 7) });
	});

	it('marks tasks done and shows them under "Completed"', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'One');
		await quickAdd(view, 'Two');
		const listId = plugin.store.data.lists[0]!.id;
		$$(view.contentEl, '.quests-nav-item').find((el) => el.textContent?.includes('Inbox'))!.click();
		$(view.contentEl, '.quests-task .quests-check').click();
		await settle();
		expect(plugin.store.data.tasks.find((t) => t.title === 'One')?.done).toBe(true);
		expect(taskTitles(view)).toEqual(['Two']);
		$(view.contentEl, '.quests-done-toggle').click();
		expect(taskTitles(view)).toEqual(['Two', 'One']);
		expect(plugin.store.data.tasks.every((t) => t.listId === listId)).toBe(true);
	});

	it('creates lists and moves tasks by dragging them onto a list', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'Movable');
		$(view.contentEl, '.quests-nav-header [aria-label="New list"]').click();
		await answerPrompt('Work');
		expect(plugin.store.data.lists.map((l) => l.name)).toEqual(['Inbox', 'Work']);

		$$(view.contentEl, '.quests-nav-item').find((el) => el.textContent?.includes('Inbox'))!.click();
		const row = $(view.contentEl, '.quests-task');
		const workItem = $$(view.contentEl, '[data-quests-list]').find((el) => el.textContent?.includes('Work'))!;
		await drag(row, workItem);
		const work = plugin.store.data.lists.find((l) => l.name === 'Work')!;
		expect(plugin.store.data.tasks[0]!.listId).toBe(work.id);
		expect(notices).toContain('Task moved to Work');
	});

	it('reorders tasks and lists by dragging', async () => {
		const { plugin, view } = await start();
		for (const title of ['A', 'B', 'C']) {
			await quickAdd(view, title);
		}
		$$(view.contentEl, '.quests-nav-item').find((el) => el.textContent?.includes('Inbox'))!.click();
		expect(taskTitles(view)).toEqual(['A', 'B', 'C']);

		const rows = () => $$(view.contentEl, '.quests-pane-tasks .quests-task');
		await drag(rows()[2]!, rows()[0]!, 'top');
		expect(taskTitles(view)).toEqual(['C', 'A', 'B']);
		await drag(rows()[0]!, rows()[2]!, 'bottom');
		expect(taskTitles(view)).toEqual(['A', 'B', 'C']);

		// In a sorted list, dragging keeps the order on screen and switches to manual order.
		const list = plugin.store.data.lists[0]!;
		await plugin.updateData((d) => {
			d.lists[0]!.sort = 'title';
			d.tasks.find((t) => t.title === 'A')!.title = 'Z';
		});
		expect(taskTitles(view)).toEqual(['B', 'C', 'Z']);
		await drag(rows()[2]!, rows()[1]!, 'top');
		expect(taskTitles(view)).toEqual(['B', 'Z', 'C']);
		expect(plugin.store.data.lists.find((l) => l.id === list.id)?.sort).toBe('manual');

		// Lists
		$(view.contentEl, '.quests-nav-header [aria-label="New list"]').click();
		await answerPrompt('Second');
		const listNames = () => $$(view.contentEl, '[data-quests-list] .quests-nav-label').map((el) => el.textContent);
		expect(listNames()).toEqual(['Inbox', 'Second']);
		const items = $$(view.contentEl, '[data-quests-list]');
		await drag(items[1]!, items[0]!, 'top');
		expect(listNames()).toEqual(['Second', 'Inbox']);
	});

	it('drags with touch only by the handle', async () => {
		const { view } = await start();
		await quickAdd(view, 'A');
		await quickAdd(view, 'B');
		$$(view.contentEl, '.quests-nav-item').find((el) => el.textContent?.includes('Inbox'))!.click();
		const rows = () => $$(view.contentEl, '.quests-pane-tasks .quests-task');
		const target = rows()[0]!;
		target.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40 }) as DOMRect;
		document.elementFromPoint = () => target;

		// Touching the row body scrolls instead of dragging.
		pointer('pointerdown', 0, 50, rows()[1]!.querySelector('.quests-task-title')!, 'touch');
		pointer('pointermove', 0, 5, window, 'touch');
		pointer('pointerup', 0, 5, window, 'touch');
		await settle();
		expect(taskTitles(view)).toEqual(['A', 'B']);

		pointer('pointerdown', 0, 50, rows()[1]!.querySelector('.quests-handle')!, 'touch');
		pointer('pointermove', 0, 5, window, 'touch');
		pointer('pointerup', 0, 5, window, 'touch');
		await settle();
		expect(taskTitles(view)).toEqual(['B', 'A']);
	});

	it('deletes a task after confirmation', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'Temp');
		$(view.contentEl, '.quests-task').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menus.at(-1)!.find((item) => item.title === 'Delete task')!.click();
		const modal = openModals.at(-1)!;
		$$(modal.contentEl, 'button').find((b) => b.textContent === 'Delete')!.click();
		await settle();
		expect(plugin.store.data.tasks).toEqual([]);
		expect(plugin.store.data.deleted).toHaveProperty([Object.keys(plugin.store.data.deleted)[0]!]);
	});

	it('links notes and follows renames', async () => {
		const { app, plugin, view } = await start();
		await app.vault.create('Notes/Plan.md', '# Plan');
		await quickAdd(view, 'With link');
		$(view.contentEl, '.quests-task').click();
		$(view.contentEl, '[aria-label="Link a note"]').click();
		const picker = openModals.at(-1) as unknown as { getItems(): { path: string }[]; onChooseItem(f: unknown): void };
		const note = picker.getItems().find((f) => f.path === 'Notes/Plan.md');
		expect(note).toBeDefined();
		picker.onChooseItem(note);
		await settle();
		expect(plugin.store.data.tasks[0]!.links).toEqual(['Notes/Plan.md']);
		expect($(view.contentEl, '.quests-path-name').textContent).toBe('Plan');

		app.rename('Notes/Plan.md', 'Notes/Big plan.md');
		await settle();
		expect(plugin.store.data.tasks[0]!.links).toEqual(['Notes/Big plan.md']);

		$(view.contentEl, '.quests-path-item').click();
		expect(app.opened).toContain('Notes/Big plan.md');
	});

	it('picks up changes synced from another device', async () => {
		const { app, plugin, view } = await start();
		await quickAdd(view, 'Local');
		const remote = JSON.parse(app.files.get(DATA)!.text) as { tasks: { title: string; updatedAt: number }[] };
		remote.tasks[0]!.title = 'Edited on phone';
		remote.tasks[0]!.updatedAt = Date.now() + 1000;
		app.externalWrite(DATA, JSON.stringify(remote));
		await settle();
		expect(plugin.store.data.tasks[0]!.title).toBe('Edited on phone');
		expect(taskTitles(view)).toEqual(['Edited on phone']);
	});
});

describe('calendar view', () => {
	it('shows tasks on their days and moves them by dragging', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'Trip');
		await plugin.updateData((d) => {
			d.tasks[0]!.end = addDays(todayStr(), 1);
		});
		await plugin.openCalendar();
		const leaf = (plugin.app.workspace as unknown as { getLeavesOfType(t: string): FakeLeaf[] }).getLeavesOfType(VIEW_TYPE_CALENDAR)[0]!;
		const calendar = leaf.view as unknown as CalendarView;
		Object.defineProperty(calendar.contentEl, 'clientWidth', { value: 1200 });
		calendar.refresh();

		const cell = (date: string) => $(calendar.contentEl, `[data-quests-date="${date}"]`);
		expect(cell(todayStr()).querySelector('.quests-chip-title')?.textContent).toBe('Trip');
		expect(cell(addDays(todayStr(), 1)).querySelector('.quests-chip.is-continued')).not.toBeNull();
		expect($(calendar.contentEl, '.quests-agenda-item-title').textContent).toBe('Trip');

		const chip = cell(todayStr()).querySelector<HTMLElement>('.quests-chip')!;
		const target = cell(addDays(todayStr(), 3));
		document.elementFromPoint = () => target;
		pointer('pointerdown', 0, 0, chip);
		pointer('pointermove', 40, 40);
		pointer('pointerup', 40, 40);
		await settle();
		expect(plugin.store.data.tasks[0]).toMatchObject({ start: addDays(todayStr(), 3), end: addDays(todayStr(), 4) });

		// Clicking a task chip opens it in the tasks view.
		calendar.contentEl.querySelector<HTMLElement>(`[data-quests-date="${addDays(todayStr(), 3)}"] .quests-chip`)!.click();
		await settle();
		expect($<HTMLTextAreaElement>(view.contentEl, '.quests-title-input').value).toBe('Trip');
	});

	it('shows events from calendars', async () => {
		const { plugin } = await start();
		plugin.settings.accounts = [{ id: 'ics', type: 'ics', name: 'Holidays', color: 'green', enabled: true, url: 'https://x/basic.ics' }];
		plugin.settings.eventCache.ics = [
			{ key: 'k', accountId: 'ics', title: 'Holiday', allDay: true, start: todayStr(), end: todayStr(), location: '', description: '', url: '' },
		];
		await plugin.openCalendar();
		const leaf = (plugin.app.workspace as unknown as { getLeavesOfType(t: string): FakeLeaf[] }).getLeavesOfType(VIEW_TYPE_CALENDAR)[0]!;
		const calendar = leaf.view as unknown as CalendarView;
		Object.defineProperty(calendar.contentEl, 'clientWidth', { value: 1200 });
		calendar.refresh();
		const chip = $(calendar.contentEl, `[data-quests-date="${todayStr()}"] .quests-chip.is-event`);
		expect(chip.textContent).toBe('Holiday');
		chip.click();
		expect(openModals.at(-1)?.title).toBe('Holiday');
	});
});

describe('settings tab', () => {
	it('renders accounts', async () => {
		const { app, plugin } = await start();
		plugin.settings.accounts = [{ id: 'ics', type: 'ics', name: 'Holidays', color: 'green', enabled: true, url: 'https://x/basic.ics' }];
		plugin.settings.status.ics = { lastSync: Date.now(), error: null };
		const tab = new QuestsSettingTab(app as never, plugin);
		tab.display();
		expect(tab.containerEl.textContent).toContain('Holidays');
		expect(tab.containerEl.textContent).toContain('Connect a calendar');
	});
});

describe('list icons, date pickers and calendar filters', () => {
	it('sets a list icon from the picker and shows it in the lists pane', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'Task');
		const item = $(view.contentEl, '[data-quests-list]');
		expect($(item, '.quests-nav-icon').dataset.icon).toBe('list');
		item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menus.at(-1)!.find((entry) => entry.title === 'Icon…')!.click();
		const picker = openModals.at(-1)!;
		const search = $<HTMLInputElement>(picker.contentEl, 'input');
		search.value = 'brief';
		search.dispatchEvent(new Event('input'));
		const cells = $$(picker.contentEl, '.quests-icon-cell');
		expect(cells.map((c) => c.getAttribute('aria-label'))).toEqual(['briefcase']);
		cells[0]!.click();
		await settle();
		expect(plugin.store.data.lists[0]!.icon).toBe('briefcase');
		expect($(view.contentEl, '[data-quests-list] .quests-nav-icon').dataset.icon).toBe('briefcase');
	});

	it('opens the calendar from the lists pane and keeps the toolbar for "New task"', async () => {
		const { plugin, view } = await start();
		expect($(view.contentEl, '.quests-toolbar .quests-text-button').textContent).toBe('New task');
		expect(view.contentEl.querySelector('.quests-toolbar [aria-label="Open calendar"]')).toBeNull();
		$(view.contentEl, '.quests-nav-calendar').click();
		await settle();
		expect(plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)).toHaveLength(1);
	});

	it('opens the date picker on a click anywhere in the date row', async () => {
		const { view } = await start();
		await quickAdd(view, 'Dated');
		$(view.contentEl, '.quests-task').click();
		const opened: string[] = [];
		const original = HTMLInputElement.prototype.showPicker;
		HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
			opened.push(this.type);
		};
		try {
			const [startRow] = $$(view.contentEl, '.quests-date-row');
			startRow!.click();
			(startRow!.previousElementSibling as HTMLElement).click();
			$(startRow!, 'input[type="time"]').click();
			expect(opened).toEqual(['date', 'date', 'time']);
		} finally {
			HTMLInputElement.prototype.showPicker = original;
		}
	});

	it('uses a round checkbox element, not a button', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'Check me');
		const check = $(view.contentEl, '.quests-task .quests-check');
		expect(check.tagName).toBe('DIV');
		expect(check.getAttribute('role')).toBe('checkbox');
		check.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		await settle();
		expect(plugin.store.data.tasks[0]!.done).toBe(true);
	});

	it('shows or hides lists in the calendar', async () => {
		const { plugin, view } = await start();
		await quickAdd(view, 'Inbox task');
		$(view.contentEl, '.quests-nav-header [aria-label="New list"]').click();
		await answerPrompt('Work');
		await quickAdd(view, 'Work task');
		await plugin.openCalendar();
		const leaf = (plugin.app.workspace as unknown as { getLeavesOfType(t: string): FakeLeaf[] }).getLeavesOfType(VIEW_TYPE_CALENDAR)[0]!;
		const calendar = leaf.view as unknown as CalendarView;
		const titles = () => $$(calendar.contentEl, '.quests-agenda-item-title').map((el) => el.textContent);
		expect(titles()).toEqual(['Inbox task', 'Work task']);

		const chip = (name: string) => $$(calendar.contentEl, '.quests-filter-chip').find((el) => el.textContent === name)!;
		chip('Inbox').click();
		expect(titles()).toEqual(['Work task']);
		expect(chip('Inbox').hasClass('is-off')).toBe(true);
		expect(chip('All').hasClass('is-off')).toBe(true);

		chip('All').click();
		expect(titles()).toEqual(['Inbox task', 'Work task']);

		// "Show only this" from the chip menu.
		chip('Inbox').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menus.at(-1)!.find((entry) => entry.title === 'Show only this')!.click();
		expect(titles()).toEqual(['Inbox task']);
	});
});

describe('nested lists in the view', () => {
	const navItem = (view: TasksView, name: string) =>
		$$(view.contentEl, '[data-quests-list]').find((el) => $(el, '.quests-nav-label').textContent === name)!;
	const listNames = (view: TasksView) =>
		$$(view.contentEl, '[data-quests-list]').map((el) => `${el.style.getPropertyValue('--quests-depth')}${$(el, '.quests-nav-label').textContent}`);

	async function withLists() {
		const ctx = await start();
		const { view } = ctx;
		$(view.contentEl, '.quests-nav-header [aria-label="New list"]').click();
		await answerPrompt('Work');
		await quickAdd(view, 'Work task');
		navItem(view, 'Work').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menus.at(-1)!.find((entry) => entry.title === 'New nested list')!.click();
		await answerPrompt('Project');
		await quickAdd(view, 'Project task');
		$(view.contentEl, '.quests-nav-header [aria-label="New list"]').click();
		await answerPrompt('Home');
		return ctx;
	}

	it('creates nested lists and shows their tasks in the parent', async () => {
		const { plugin, view } = await withLists();
		expect(listNames(view)).toEqual(['0Work', '1Project', '0Home']);
		const project = plugin.store.data.lists.find((l) => l.name === 'Project')!;
		expect(project.parentId).toBe(plugin.store.data.lists.find((l) => l.name === 'Work')!.id);
		// The parent counts nested tasks too.
		expect($(navItem(view, 'Work'), '.quests-nav-count').textContent).toBe('2');

		navItem(view, 'Work').click();
		expect(taskTitles(view)).toEqual(['Work task', 'Project task']);
		expect($(view.contentEl, '.quests-group-header .quests-group-name').textContent).toBe('Project');

		// Collapsing hides nested lists.
		$(navItem(view, 'Work'), '.quests-nav-toggle').click();
		expect(listNames(view)).toEqual(['0Work', '0Home']);
	});

	it('drags a list inside another and back to the top level', async () => {
		const { plugin, view } = await withLists();
		await drag(navItem(view, 'Home'), navItem(view, 'Project'), 'middle');
		expect(listNames(view)).toEqual(['0Work', '1Project', '2Home']);
		const home = () => plugin.store.data.lists.find((l) => l.name === 'Home')!;
		expect(home().parentId).toBe(plugin.store.data.lists.find((l) => l.name === 'Project')!.id);

		// A list cannot go inside its own nested list.
		await drag(navItem(view, 'Work'), navItem(view, 'Home'), 'middle');
		expect(listNames(view)).toEqual(['0Work', '1Project', '2Home']);

		await drag(navItem(view, 'Home'), $(view.contentEl, '[data-quests-lists-root]'));
		expect(home().parentId).toBeNull();
		expect(listNames(view)).toEqual(['0Work', '1Project', '0Home']);

		// Top or bottom quarter: next to the target, in its parent.
		await drag(navItem(view, 'Home'), navItem(view, 'Project'), 'top');
		expect(listNames(view)).toEqual(['0Work', '1Home', '1Project']);
	});

	it('moves tasks between a list and its nested lists by dragging', async () => {
		const { plugin, view } = await withLists();
		navItem(view, 'Work').click();
		const rows = () => $$(view.contentEl, '.quests-pane-tasks .quests-task');
		// Work task → the top of the "Project" group.
		await drag(rows()[0]!, $(view.contentEl, '.quests-group-header'));
		const project = plugin.store.data.lists.find((l) => l.name === 'Project')!;
		expect(plugin.store.data.tasks.find((t) => t.title === 'Work task')?.listId).toBe(project.id);
		expect(taskTitles(view)).toEqual(['Work task', 'Project task']);
		expect(notices).toContain('Task moved to Project');

		// And back: drop it before... there is no Work task left, so drop on the Work list in the nav.
		await drag(rows()[1]!, navItem(view, 'Work'));
		const work = plugin.store.data.lists.find((l) => l.name === 'Work')!;
		expect(plugin.store.data.tasks.find((t) => t.title === 'Project task')?.listId).toBe(work.id);
	});

	it('deletes a list with its nested lists after confirmation', async () => {
		const { plugin, view } = await withLists();
		navItem(view, 'Work').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menus.at(-1)!.find((entry) => entry.title === 'Delete list')!.click();
		const modal = openModals.at(-1)!;
		expect($(modal.contentEl, '.quests-modal-message').textContent).toContain('nested lists (1) and 2 tasks');
		$$(modal.contentEl, 'button').find((b) => b.textContent === 'Delete')!.click();
		await settle();
		expect(plugin.store.data.lists.map((l) => l.name)).toEqual(['Home']);
		expect(plugin.store.data.tasks).toEqual([]);
	});

	it('hides a parent list together with its nested lists in the calendar', async () => {
		const { plugin } = await withLists();
		await plugin.openCalendar();
		const leaf = (plugin.app.workspace as unknown as { getLeavesOfType(t: string): FakeLeaf[] }).getLeavesOfType(VIEW_TYPE_CALENDAR)[0]!;
		const calendar = leaf.view as unknown as CalendarView;
		const titles = () => $$(calendar.contentEl, '.quests-agenda-item-title').map((el) => el.textContent);
		const chip = (name: string) => $$(calendar.contentEl, '.quests-filter-chip').find((el) => el.textContent === name)!;
		expect(titles()).toEqual(['Project task', 'Work task']);
		chip('Work').click();
		expect(titles()).toEqual([]);
		expect(chip('Project').hasClass('is-off')).toBe(true);
		chip('All').click();
		chip('Project').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menus.at(-1)!.find((entry) => entry.title === 'Show only this')!.click();
		expect(titles()).toEqual(['Project task']);
	});
});

describe('data folder', () => {
	async function withAttachment() {
		const ctx = await start();
		await quickAdd(ctx.view, 'With file');
		await ctx.app.vault.create('Quests/attachments/photo.png', '');
		await ctx.plugin.updateData((d) => {
			d.tasks[0]!.attachments = ['Quests/attachments/photo.png'];
		});
		return ctx;
	}

	it('moves the folder with its files and keeps attachment paths right', async () => {
		const { app, plugin } = await withAttachment();
		expect(await plugin.moveDataFolder('System/Tasks')).toBe(true);
		await settle();
		expect([...app.files.keys()].sort()).toEqual(['System/Tasks/attachments/photo.png', 'System/Tasks/quests.json']);
		expect(plugin.settings.folder).toBe('System/Tasks');
		expect(plugin.store.data.tasks[0]!.attachments).toEqual(['System/Tasks/attachments/photo.png']);
		expect(notices).toContain('Tasks moved to "System/Tasks"');
	});

	it('moves the contents into an existing folder', async () => {
		const { app, plugin } = await withAttachment();
		await app.vault.create('Archive/old note.md', '');
		expect(await plugin.moveDataFolder('Archive')).toBe(true);
		await settle();
		expect([...app.files.keys()].sort()).toEqual(['Archive/attachments/photo.png', 'Archive/old note.md', 'Archive/quests.json']);
		expect(app.vault.getFolderByPath('Quests')).toBeNull();
	});

	it('offers to switch to a folder that already has tasks', async () => {
		const { app, plugin } = await withAttachment();
		const other = JSON.parse(app.files.get('Quests/quests.json')!.text) as { tasks: { title: string }[] };
		other.tasks[0]!.title = 'Other vault task';
		await app.vault.create('Other/quests.json', JSON.stringify(other));
		const result = plugin.moveDataFolder('Other');
		await settle();
		const modal = openModals.at(-1)!;
		$$(modal.contentEl, 'button').find((b) => b.textContent === 'Switch')!.click();
		expect(await result).toBe(true);
		expect(plugin.store.data.tasks[0]!.title).toBe('Other vault task');
		// Nothing was moved.
		expect(app.files.has('Quests/quests.json')).toBe(true);
	});

	it('refuses to move the folder into itself', async () => {
		const { plugin } = await withAttachment();
		expect(await plugin.moveDataFolder('Quests/inner')).toBe(false);
		expect(plugin.settings.folder).toBe('Quests');
	});

	it('follows the folder when it is dragged in the file explorer', async () => {
		const { app, plugin, view } = await withAttachment();
		app.rename('Quests', 'Life/Quests');
		await settle();
		expect(plugin.settings.folder).toBe('Life/Quests');
		expect(plugin.store.data.tasks[0]!.attachments).toEqual(['Life/Quests/attachments/photo.png']);
		// No new task file appeared at the old place.
		expect(app.files.has('Quests/quests.json')).toBe(false);
		await quickAdd(view, 'After move');
		expect(app.files.has('Quests/quests.json')).toBe(false);
		expect(JSON.parse(app.files.get('Life/Quests/quests.json')!.text).tasks).toHaveLength(2);
	});

	it('finds the task file at startup when the folder moved on another device', async () => {
		const app = createApp();
		await app.vault.create('Moved/Here/quests.json', JSON.stringify({ format: 'quests-list', version: 1, lists: [], tasks: [], deleted: {} }));
		await app.vault.create('Elsewhere/quests.json', '{"something": "else"}');
		const plugin = new QuestsPlugin(app as never, {} as never);
		await plugin.onload();
		await settle();
		expect(plugin.settings.folder).toBe('Moved/Here');
	});

	it('suggests folders as "<folder>/Quests", without the current one', async () => {
		const { app, plugin } = await withAttachment();
		await app.vault.create('Work/plan.md', '');
		const input = document.createElement('input');
		let picked = '';
		const suggest = new FolderSuggest(app as never, input, plugin.settings.folder, (value) => (picked = value));
		const options = (suggest as unknown as { suggest(q: string): { path: string }[] }).suggest('');
		expect(options.map((f) => f.path)).toEqual(['Work']);
		suggest.selectSuggestion(options[0] as never);
		expect(picked).toBe('Work/Quests');
		expect(input.value).toBe('Work/Quests');
	});
});

describe('private lists in the view', () => {
	async function fillPassword(...values: string[]) {
		const modal = openModals.at(-1)!;
		$$(modal.contentEl, 'input[type="password"]').forEach((input, i) => {
			(input as HTMLInputElement).value = values[i] ?? '';
		});
		$(modal.contentEl, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
		await settle();
		return modal;
	}

	it('makes a list private, locks it and opens it with the password', async () => {
		const { app, plugin, view } = await start();
		plugin.store.kdfIterations = 1000;
		await quickAdd(view, 'Secret task');
		const item = () => $(view.contentEl, '[data-quests-list]');
		item().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		menus.at(-1)!.find((entry) => entry.title === 'Make private')!.click();
		await settle();

		// First time: create the password.
		const create = await fillPassword('short', 'short');
		expect($(create.contentEl, '.quests-error').textContent).toContain('at least 6');
		await fillPassword('secret-pass', 'secret-pass');
		await settle();
		expect(plugin.store.data.lists[0]!.private).toBe(true);
		expect(app.files.get(DATA)!.text).not.toContain('Secret task');
		expect($(item(), '.quests-nav-lock').dataset.icon).toBe('lock-open');

		// Close from the lists header.
		$(view.contentEl, '.quests-nav-header [aria-label="Close private lists"]').click();
		await settle();
		expect(plugin.store.locked).toBe(true);
		expect($(item(), '.quests-nav-lock').dataset.icon).toBe('lock');
		expect(taskTitles(view)).toEqual([]);
		$$(view.contentEl, '.quests-nav-item').find((el) => el.textContent?.includes('Today'))!.click();
		expect(taskTitles(view)).toEqual([]);

		// Clicking the closed list asks for the password.
		item().click();
		await settle();
		const unlock = await fillPassword('wrong-pass');
		expect($(unlock.contentEl, '.quests-error').textContent).toBe('Wrong password');
		await fillPassword('secret-pass');
		await settle();
		expect(plugin.store.unlocked).toBe(true);
		expect(taskTitles(view)).toEqual(['Secret task']);
	});

	it('closes private lists after inactivity', async () => {
		const { plugin, view } = await start();
		plugin.store.kdfIterations = 1000;
		await quickAdd(view, 'Secret task');
		$$(view.contentEl, '.quests-nav-item').find((el) => el.textContent?.includes('Inbox'))!.click();
		await plugin.store.setPassword('secret-pass');
		await plugin.setListPrivate(plugin.store.data.lists[0]!.id, true);
		expect(plugin.store.unlocked).toBe(true);
		plugin.settings.privateAutoLockMinutes = 1;
		(plugin as unknown as { lastActivity: number }).lastActivity = Date.now() - 61_000;
		(plugin as unknown as { checkAutoLock(): void }).checkAutoLock();
		await settle();
		expect(plugin.store.locked).toBe(true);
		expect(notices).toContain('Private lists were closed after inactivity');
		expect($(view.contentEl, '.quests-pane-tasks .quests-empty').textContent).toContain('private list');
	});
});
