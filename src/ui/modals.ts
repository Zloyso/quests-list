import { type App, FuzzySuggestModal, Modal, Setting, type TFile } from 'obsidian';
import { formatDateValue, formatTime } from '../dates';
import { t } from '../i18n';
import type { TaskList } from '../model';
import type { CalendarEvent } from '../sync/types';

/** Yes/no question. Resolves to true only when confirmed. */
export function confirmAction(
	app: App,
	options: { title: string; message: string; confirmText: string; danger?: boolean },
): Promise<boolean> {
	return new Promise((resolve) => {
		let decided = false;
		const modal = new (class extends Modal {
			onOpen() {
				this.setTitle(options.title);
				this.contentEl.createEl('p', { text: options.message, cls: 'quests-modal-message' });
				new Setting(this.contentEl)
					.addButton((button) => button.setButtonText(t('cancel')).onClick(() => this.close()))
					.addButton((button) => {
						button.setButtonText(options.confirmText).onClick(() => {
							decided = true;
							this.close();
						});
						if (options.danger) {
							button.setWarning();
						} else {
							button.setCta();
						}
					});
			}
			onClose() {
				this.contentEl.empty();
				resolve(decided);
			}
		})(app);
		modal.open();
	});
}

/** Single-line text input. Resolves to the trimmed value or null when cancelled. */
export function promptText(app: App, options: { title: string; value?: string; placeholder?: string }): Promise<string | null> {
	return new Promise((resolve) => {
		let result: string | null = null;
		const modal = new (class extends Modal {
			onOpen() {
				this.setTitle(options.title);
				const form = this.contentEl.createEl('form', { cls: 'quests-form' });
				const input = form.createEl('input', {
					type: 'text',
					value: options.value ?? '',
					attr: { placeholder: options.placeholder ?? '' },
				});
				const actions = form.createDiv({ cls: 'quests-form-actions' });
				actions.createEl('button', { text: t('cancel'), attr: { type: 'button' } }).addEventListener('click', () => this.close());
				actions.createEl('button', { text: t('save'), attr: { type: 'submit' }, cls: 'mod-cta' });
				form.addEventListener('submit', (event) => {
					event.preventDefault();
					const value = input.value.trim();
					if (value) {
						result = value;
						this.close();
					}
				});
				window.setTimeout(() => input.select(), 0);
			}
			onClose() {
				this.contentEl.empty();
				resolve(result);
			}
		})(app);
		modal.open();
	});
}

/** Picks a file from the vault. */
export class FilePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		placeholder: string,
		private readonly files: () => TFile[],
		private readonly onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = t('nothingFound');
	}

	getItems(): TFile[] {
		return this.files();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

export class ListPicker extends FuzzySuggestModal<TaskList> {
	constructor(
		app: App,
		placeholder: string,
		private readonly lists: TaskList[],
		private readonly onPick: (list: TaskList) => void,
		private readonly label: (list: TaskList) => string = (list) => list.name,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = t('noLists');
	}

	getItems(): TaskList[] {
		return this.lists;
	}

	getItemText(list: TaskList): string {
		return this.label(list);
	}

	onChooseItem(list: TaskList): void {
		this.onPick(list);
	}
}

export interface Choice {
	id: string | null;
	label: string;
}

/** Picks one of several labelled options; `id: null` is a valid choice (e.g. "top level"). */
export class ChoicePicker extends FuzzySuggestModal<Choice> {
	constructor(
		app: App,
		placeholder: string,
		private readonly choices: Choice[],
		private readonly onPick: (id: string | null) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = t('nothingFound');
	}

	getItems(): Choice[] {
		return this.choices;
	}

	getItemText(choice: Choice): string {
		return choice.label;
	}

	onChooseItem(choice: Choice): void {
		this.onPick(choice.id);
	}
}

export function eventTimeText(event: CalendarEvent): string {
	if (event.allDay) {
		return event.end > event.start ? `${formatDateValue(event.start)} – ${formatDateValue(event.end)}` : t('allDay');
	}
	const sameDay = event.start.slice(0, 10) === event.end.slice(0, 10);
	return sameDay
		? `${formatTime(event.start)} – ${formatTime(event.end)}`
		: `${formatDateValue(event.start)} – ${formatDateValue(event.end)}`;
}

/** Read-only details of an outside calendar event. */
export class EventModal extends Modal {
	constructor(
		app: App,
		private readonly event: CalendarEvent,
		private readonly calendarName: string,
	) {
		super(app);
	}

	onOpen() {
		const { event } = this;
		this.setTitle(event.title);
		const fields = this.contentEl.createDiv({ cls: 'quests-event-details' });
		const row = (label: string, value: string) => {
			if (!value) {
				return;
			}
			const item = fields.createDiv({ cls: 'quests-event-row' });
			item.createDiv({ cls: 'quests-field-label', text: label });
			item.createDiv({ cls: 'quests-event-value', text: value });
		};
		row(t('when'), event.allDay ? eventTimeText(event) : `${formatDateValue(event.start.slice(0, 10))}, ${eventTimeText(event)}`);
		row(t('calendar'), this.calendarName);
		row(t('location'), event.location);
		row(t('description'), event.description);
		if (/^https:\/\//i.test(event.url)) {
			new Setting(this.contentEl).addButton((button) =>
				button.setButtonText(t('openInCalendar')).onClick(() => {
					window.open(event.url);
				}),
			);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
