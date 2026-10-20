import { Modal, Notice, Platform, Setting } from 'obsidian';
import { t } from '../i18n';
import type QuestsPlugin from '../main';
import { LIST_COLORS, type ListColor, listPath, listTree, newId } from '../model';
import { CaldavClient, type CaldavCalendar } from '../sync/caldav';
import { type GoogleCalendarInfo, googleCalendars, googleSignIn, SignInCancelled } from '../sync/google';
import { normalizeFeedUrl } from '../sync/http';
import { type CalendarAccount, type CaldavAccount, type GoogleAccount, SyncError } from '../sync/types';
import { colorLabel } from './tasks-view';

export type AccountPreset = 'yandex' | 'google' | 'caldav' | 'ics';

export const YANDEX_CALDAV_URL = 'https://caldav.yandex.ru';
const YANDEX_APP_PASSWORDS = 'https://id.yandex.ru/security/app-passwords';
const GOOGLE_CONSOLE = 'https://console.cloud.google.com/apis/credentials';
const README_URL = 'https://github.com/Zloyso/quests-list#синхронизация-с-календарями';

export function newAccount(preset: AccountPreset): CalendarAccount {
	const base = { id: newId(), enabled: true };
	switch (preset) {
		case 'yandex':
			return {
				...base,
				type: 'caldav',
				name: t('presetYandex'),
				color: 'red',
				serverUrl: YANDEX_CALDAV_URL,
				username: '',
				password: '',
				calendarUrl: '',
				calendarName: '',
				push: true,
				listIds: null,
			};
		case 'caldav':
			return {
				...base,
				type: 'caldav',
				name: t('presetCaldav'),
				color: 'purple',
				serverUrl: '',
				username: '',
				password: '',
				calendarUrl: '',
				calendarName: '',
				push: true,
				listIds: null,
			};
		case 'google':
			return {
				...base,
				type: 'google',
				name: t('presetGoogle'),
				color: 'blue',
				clientId: '',
				clientSecret: '',
				refreshToken: '',
				calendarId: '',
				calendarName: '',
				push: true,
				listIds: null,
			};
		case 'ics':
			return { ...base, type: 'ics', name: t('presetIcs'), color: 'green', url: '' };
	}
}

export function describeSyncError(err: unknown): string {
	if (err instanceof SyncError && err.status === 401) {
		return t('syncAuthFailed');
	}
	return err instanceof Error ? err.message : String(err);
}

/** Adds or edits a calendar connection. Works on a copy; `onSave` gets the result. */
export class AccountModal extends Modal {
	private readonly draft: CalendarAccount;
	private caldavCalendars: CaldavCalendar[] | null = null;
	private googleList: GoogleCalendarInfo[] | null = null;
	private busy = false;
	private signIn: AbortController | null = null;

	constructor(
		private readonly plugin: QuestsPlugin,
		account: CalendarAccount,
		private readonly isNew: boolean,
		private readonly onSave: (account: CalendarAccount) => Promise<void>,
	) {
		super(plugin.app);
		this.draft = structuredClone(account);
	}

	onOpen(): void {
		this.modalEl.addClass('quests-account-modal');
		this.render();
	}

	onClose(): void {
		this.signIn?.abort();
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl, draft } = this;
		contentEl.empty();
		this.setTitle(this.isNew ? t('addCalendar') : t('editCalendar'));

		new Setting(contentEl).setName(t('calendarName')).addText((text) =>
			text.setValue(draft.name).onChange((value) => {
				draft.name = value;
			}),
		);
		new Setting(contentEl).setName(t('color')).addDropdown((dropdown) => {
			for (const color of LIST_COLORS) {
				dropdown.addOption(color, colorLabel(color));
			}
			dropdown.setValue(draft.color).onChange((value) => {
				draft.color = value as ListColor;
			});
		});

		if (draft.type === 'ics') {
			this.renderIcs(draft);
		} else if (draft.type === 'caldav') {
			this.renderCaldav(draft);
		} else {
			this.renderGoogle(draft);
		}
		if (draft.type !== 'ics') {
			this.renderPushOptions(draft);
		}

		new Setting(contentEl)
			.addButton((button) => button.setButtonText(t('cancel')).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t('save'))
					.setCta()
					.setDisabled(this.busy)
					.onClick(() => void this.save()),
			);
	}

	private help(parts: (string | { text: string; href: string })[]): void {
		const p = this.contentEl.createEl('p', { cls: 'quests-help' });
		for (const part of parts) {
			if (typeof part === 'string') {
				p.appendText(part);
			} else {
				p.createEl('a', { text: part.text, href: part.href });
			}
		}
	}

	private renderIcs(draft: Extract<CalendarAccount, { type: 'ics' }>): void {
		this.help([t('icsHelp')]);
		new Setting(this.contentEl).setName(t('icsUrl')).addText((text) => {
			text.inputEl.addClass('quests-wide-input');
			text
				.setPlaceholder('https://…/basic.ics')
				.setValue(draft.url)
				.onChange((value) => {
					draft.url = value.trim();
				});
		});
	}

	private renderCaldav(draft: CaldavAccount): void {
		const yandex = draft.serverUrl.replace(/\/+$/, '') === YANDEX_CALDAV_URL;
		if (yandex) {
			this.help([t('yandexHelp1'), { text: t('yandexHelpLink'), href: YANDEX_APP_PASSWORDS }, t('yandexHelp2')]);
		} else {
			this.help([t('caldavHelp')]);
		}
		const reset = () => {
			this.caldavCalendars = null;
		};
		new Setting(this.contentEl).setName(t('serverUrl')).addText((text) => {
			text.inputEl.addClass('quests-wide-input');
			text
				.setPlaceholder('https://caldav.example.com')
				.setValue(draft.serverUrl)
				.onChange((value) => {
					draft.serverUrl = value.trim();
					reset();
				});
		});
		new Setting(this.contentEl).setName(yandex ? t('yandexLogin') : t('username')).addText((text) =>
			text
				.setPlaceholder(yandex ? 'name@yandex.ru' : '')
				.setValue(draft.username)
				.onChange((value) => {
					draft.username = value.trim();
					reset();
				}),
		);
		new Setting(this.contentEl).setName(yandex ? t('appPassword') : t('password')).addText((text) => {
			text.inputEl.type = 'password';
			text.inputEl.setAttrs({ autocomplete: 'off', spellcheck: 'false' });
			text.setValue(draft.password).onChange((value) => {
				draft.password = value.trim();
				reset();
			});
		});

		const calendarSetting = new Setting(this.contentEl).setName(t('calendar'));
		if (this.caldavCalendars?.length) {
			const calendars = this.caldavCalendars;
			calendarSetting.addDropdown((dropdown) => {
				for (const calendar of calendars) {
					dropdown.addOption(calendar.url, calendar.name);
				}
				if (!calendars.some((c) => c.url === draft.calendarUrl)) {
					draft.calendarUrl = calendars[0]?.url ?? '';
					draft.calendarName = calendars[0]?.name ?? '';
				}
				dropdown.setValue(draft.calendarUrl).onChange((value) => {
					draft.calendarUrl = value;
					draft.calendarName = calendars.find((c) => c.url === value)?.name ?? '';
				});
			});
		} else {
			calendarSetting.setDesc(draft.calendarName || draft.calendarUrl || t('calendarNotChosen'));
		}
		calendarSetting.addButton((button) =>
			button
				.setButtonText(this.busy ? t('working') : t('findCalendars'))
				.setDisabled(this.busy)
				.onClick(() => void this.findCaldavCalendars(draft)),
		);
	}

	private async findCaldavCalendars(draft: CaldavAccount): Promise<void> {
		if (!draft.serverUrl || !draft.username || !draft.password) {
			new Notice(t('fillServerFirst'));
			return;
		}
		this.busy = true;
		this.render();
		try {
			const calendars = await new CaldavClient(draft.serverUrl, draft.username, draft.password).discover();
			this.caldavCalendars = calendars;
			if (!calendars.length) {
				new Notice(t('noCalendarsFound'));
			}
		} catch (err) {
			new Notice(t('connectFailed', { error: describeSyncError(err) }), 10_000);
		} finally {
			this.busy = false;
			this.render();
		}
	}

	private renderGoogle(draft: GoogleAccount): void {
		this.help([t('googleHelp1'), { text: 'Google Cloud Console', href: GOOGLE_CONSOLE }, t('googleHelp2'), { text: t('googleHelpReadme'), href: README_URL }, '.']);
		new Setting(this.contentEl).setName('Client ID').addText((text) => {
			text.inputEl.addClass('quests-wide-input');
			text.setValue(draft.clientId).onChange((value) => {
				draft.clientId = value.trim();
			});
		});
		new Setting(this.contentEl).setName('Client secret').addText((text) => {
			text.inputEl.type = 'password';
			text.setValue(draft.clientSecret).onChange((value) => {
				draft.clientSecret = value.trim();
			});
		});

		const account = new Setting(this.contentEl)
			.setName(t('googleAccount'))
			.setDesc(draft.refreshToken ? t('googleSignedIn') : Platform.isDesktopApp ? t('googleNotSignedIn') : t('googleDesktopOnly'));
		if (Platform.isDesktopApp) {
			account.addButton((button) =>
				button
					.setButtonText(this.signIn ? t('googleWaiting') : draft.refreshToken ? t('googleSignInAgain') : t('googleSignIn'))
					.setDisabled(this.busy)
					.onClick(() => void this.googleSignIn(draft)),
			);
		}

		if (draft.refreshToken) {
			const calendarSetting = new Setting(this.contentEl).setName(t('calendar'));
			if (this.googleList?.length) {
				const list = this.googleList;
				calendarSetting.addDropdown((dropdown) => {
					for (const calendar of list) {
						dropdown.addOption(calendar.id, calendar.name);
					}
					if (!list.some((c) => c.id === draft.calendarId)) {
						const pick = list.find((c) => c.primary) ?? list[0];
						draft.calendarId = pick?.id ?? '';
						draft.calendarName = pick?.name ?? '';
					}
					dropdown.setValue(draft.calendarId).onChange((value) => {
						draft.calendarId = value;
						draft.calendarName = list.find((c) => c.id === value)?.name ?? '';
					});
				});
			} else {
				calendarSetting.setDesc(draft.calendarName || t('calendarNotChosen'));
			}
			calendarSetting.addButton((button) =>
				button
					.setButtonText(this.busy && !this.signIn ? t('working') : t('findCalendars'))
					.setDisabled(this.busy)
					.onClick(() => void this.loadGoogleCalendars(draft)),
			);
		}
	}

	private async googleSignIn(draft: GoogleAccount): Promise<void> {
		if (this.signIn) {
			this.signIn.abort();
			return;
		}
		if (!draft.clientId || !draft.clientSecret) {
			new Notice(t('fillGoogleClient'));
			return;
		}
		this.signIn = new AbortController();
		this.busy = true;
		this.render();
		try {
			draft.refreshToken = await googleSignIn(draft.clientId, draft.clientSecret, this.signIn.signal);
			this.signIn = null;
			this.busy = false;
			await this.loadGoogleCalendars(draft);
		} catch (err) {
			if (!(err instanceof SignInCancelled)) {
				new Notice(t('connectFailed', { error: describeSyncError(err) }), 10_000);
			}
		} finally {
			this.signIn = null;
			this.busy = false;
			this.render();
		}
	}

	private async loadGoogleCalendars(draft: GoogleAccount): Promise<void> {
		this.busy = true;
		this.render();
		try {
			this.googleList = await googleCalendars(draft);
		} catch (err) {
			new Notice(t('connectFailed', { error: describeSyncError(err) }), 10_000);
		} finally {
			this.busy = false;
			this.render();
		}
	}

	private renderPushOptions(draft: CaldavAccount | GoogleAccount): void {
		new Setting(this.contentEl).setName(t('pushSection')).setHeading();
		new Setting(this.contentEl)
			.setName(t('pushTasks'))
			.setDesc(t('pushTasksDesc'))
			.addToggle((toggle) =>
				toggle.setValue(draft.push).onChange((value) => {
					draft.push = value;
					this.render();
				}),
			);
		if (!draft.push) {
			return;
		}
		const all = this.plugin.store.data.lists;
		const lists = listTree(all, this.plugin.settings.listsByName).map((node) => node.list);
		new Setting(this.contentEl).setName(t('pushLists')).addDropdown((dropdown) =>
			dropdown
				.addOption('all', t('pushAllLists'))
				.addOption('some', t('pushSomeLists'))
				.setValue(draft.listIds === null ? 'all' : 'some')
				.onChange((value) => {
					draft.listIds = value === 'all' ? null : lists.map((l) => l.id);
					this.render();
				}),
		);
		if (draft.listIds !== null) {
			const box = this.contentEl.createDiv({ cls: 'quests-list-checks' });
			for (const list of lists) {
				const label = box.createEl('label', { cls: 'quests-checkbox' });
				const input = label.createEl('input', { type: 'checkbox' });
				input.checked = draft.listIds.includes(list.id);
				label.appendText(listPath(all, list.id).join(' / '));
				input.addEventListener('change', () => {
					const ids = new Set(draft.listIds ?? []);
					if (input.checked) {
						ids.add(list.id);
					} else {
						ids.delete(list.id);
					}
					draft.listIds = [...ids];
				});
			}
		}
	}

	private async save(): Promise<void> {
		const draft = this.draft;
		draft.name = draft.name.trim() || t('calendar');
		if (draft.type === 'ics') {
			if (!/^(https?|webcals?):\/\//i.test(draft.url)) {
				new Notice(t('icsUrlInvalid'));
				return;
			}
			draft.url = normalizeFeedUrl(draft.url);
		} else if (draft.type === 'caldav') {
			if (!draft.calendarUrl) {
				new Notice(t('chooseCalendar'));
				return;
			}
		} else if (!draft.refreshToken || !draft.calendarId) {
			new Notice(t('chooseCalendar'));
			return;
		}
		await this.onSave(draft);
		this.close();
	}
}
