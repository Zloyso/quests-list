import { type App, Menu, normalizePath, Notice, PluginSettingTab, Setting } from 'obsidian';
import { formatTimestamp } from '../dates';
import { type Language, setLanguage, t } from '../i18n';
import type QuestsPlugin from '../main';
import type { CalendarAccount } from '../sync/types';
import { AccountModal, type AccountPreset, describeSyncError, newAccount } from './account-modal';
import { FolderSuggest } from './folder-suggest';
import { confirmAction } from './modals';

export class QuestsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: QuestsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName(t('settingLanguage')).addDropdown((dropdown) =>
			dropdown
				.addOption('auto', t('languageAuto'))
				.addOption('ru', 'Русский')
				.addOption('en', 'English')
				.setValue(settings.language)
				.onChange(async (value) => {
					settings.language = value as Language;
					setLanguage(settings.language);
					await save();
					this.plugin.refreshViews();
					this.display();
				}),
		);

		new Setting(containerEl).setName(t('settingWeekStart')).addDropdown((dropdown) =>
			dropdown
				.addOption('1', t('monday'))
				.addOption('0', t('sunday'))
				.setValue(String(settings.weekStart))
				.onChange(async (value) => {
					settings.weekStart = value === '0' ? 0 : 1;
					await save();
					this.plugin.refreshViews();
				}),
		);

		let folderValue = settings.folder;
		new Setting(containerEl)
			.setName(t('settingFolder'))
			.setDesc(t('settingFolderDesc'))
			.addText((text) => {
				text
					.setPlaceholder('Quests')
					.setValue(settings.folder)
					.onChange((value) => {
						folderValue = value;
					});
				text.inputEl.addClass('quests-wide-input');
				new FolderSuggest(this.app, text.inputEl, settings.folder, (value) => {
					folderValue = value;
				});
			})
			.addButton((button) =>
				button.setButtonText(t('moveFolder')).onClick(async () => {
					const folder = normalizePath(folderValue.trim());
					if (!folder || folder === '/' || folder.split('/').some((part) => part.startsWith('.'))) {
						new Notice(t('folderInvalid'));
						return;
					}
					if (folder === settings.folder) {
						return;
					}
					button.setDisabled(true);
					await this.plugin.moveDataFolder(folder);
					this.display();
				}),
			);

		// Private lists
		new Setting(containerEl).setName(t('sectionPrivate')).setHeading();
		containerEl.createEl('p', { cls: 'setting-item-description', text: t('privateIntro') });
		const store = this.plugin.store;
		if (!store.hasPassword) {
			new Setting(containerEl)
				.setName(t('privateSetPassword'))
				.setDesc(t('privateSetPasswordDesc'))
				.addButton((button) =>
					button.setButtonText(t('privateCreate')).onClick(async () => {
						await this.plugin.ensurePrivateAccess();
						this.display();
					}),
				);
		} else {
			new Setting(containerEl).setName(t('privateChangeTitle')).addButton((button) =>
				button.setButtonText(t('privateChange')).onClick(async () => {
					await this.plugin.changePrivatePassword();
					this.display();
				}),
			);
			const state = new Setting(containerEl)
				.setName(t('privateState'))
				.setDesc(store.unlocked ? t('privateStateOpen') : t('privateStateClosed'));
			state.addButton((button) =>
				button.setButtonText(store.unlocked ? t('commandLockPrivate') : t('privateUnlock')).onClick(async () => {
					if (store.unlocked) {
						await this.plugin.lockPrivate();
					} else {
						await this.plugin.unlockPrivate();
					}
					this.display();
				}),
			);
		}
		new Setting(containerEl)
			.setName(t('privateAutoLock'))
			.setDesc(t('privateAutoLockDesc'))
			.addDropdown((dropdown) => {
				for (const minutes of [1, 5, 10, 15, 30, 60, 0]) {
					dropdown.addOption(String(minutes), minutes ? t('afterMinutes', { count: minutes }) : t('onlyOnClose'));
				}
				dropdown.setValue(String(settings.privateAutoLockMinutes)).onChange(async (value) => {
					settings.privateAutoLockMinutes = Number(value);
					await save();
				});
			});

		// Calendars
		new Setting(containerEl).setName(t('sectionCalendars')).setHeading();
		containerEl.createEl('p', { cls: 'setting-item-description', text: t('calendarsIntro') });

		for (const account of settings.accounts) {
			this.renderAccount(containerEl, account);
		}

		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText(t('addCalendar'))
				.setCta()
				.onClick((event) => this.openAddMenu(event)),
		);

		new Setting(containerEl)
			.setName(t('settingSyncInterval'))
			.setDesc(t('settingSyncIntervalDesc'))
			.addDropdown((dropdown) => {
				for (const minutes of [0, 5, 15, 30, 60, 180]) {
					dropdown.addOption(String(minutes), minutes ? t('everyMinutes', { count: minutes }) : t('manualOnly'));
				}
				dropdown.setValue(String(settings.syncIntervalMinutes)).onChange(async (value) => {
					settings.syncIntervalMinutes = Number(value);
					await save();
					this.plugin.scheduleSync();
				});
			});
	}

	private renderAccount(containerEl: HTMLElement, account: CalendarAccount): void {
		const settings = this.plugin.settings;
		const status = settings.status[account.id];
		const kind = account.type === 'ics' ? t('kindIcs') : account.type === 'google' ? t('kindGoogle') : t('kindCaldav');
		const details = [kind];
		if (account.type !== 'ics') {
			details.push(account.push ? t('kindPush') : t('kindReadOnly'));
		}
		const desc = createFragment();
		desc.appendText(details.join(' · '));
		desc.createEl('br');
		if (status?.error) {
			desc.createSpan({ cls: 'quests-error-text', text: t('syncFailedShort', { error: status.error }) });
		} else {
			desc.appendText(status?.lastSync ? t('lastSync', { date: formatTimestamp(status.lastSync) }) : t('neverSynced'));
		}

		const setting = new Setting(containerEl).setName(account.name).setDesc(desc);
		setting.settingEl.addClass('quests-account-setting');
		const dot = setting.nameEl.createSpan({ cls: 'quests-color-dot' });
		dot.setCssProps({ '--quests-color': `var(--color-${account.color})` });
		setting.nameEl.prepend(dot);

		setting
			.addToggle((toggle) =>
				toggle
					.setTooltip(t('calendarEnabled'))
					.setValue(account.enabled)
					.onChange(async (value) => {
						account.enabled = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
						if (value) {
							void this.plugin.syncNow(false).then(() => this.display());
						}
					}),
			)
			.addExtraButton((button) =>
				button
					.setIcon('refresh-cw')
					.setTooltip(t('syncNow'))
					.onClick(async () => {
						try {
							await this.plugin.sync.syncAccount(account);
							await this.plugin.saveSettings();
							new Notice(t('syncDoneOne', { name: account.name }));
						} catch (err) {
							new Notice(t('syncFailed', { name: account.name, error: describeSyncError(err) }), 10_000);
							await this.plugin.saveSettings();
						}
						this.plugin.refreshViews();
						this.display();
					}),
			)
			.addExtraButton((button) =>
				button
					.setIcon('pencil')
					.setTooltip(t('edit'))
					.onClick(() =>
						new AccountModal(this.plugin, account, false, async (updated) => {
							const index = settings.accounts.findIndex((a) => a.id === account.id);
							if (index >= 0) {
								settings.accounts[index] = updated;
							}
							await this.plugin.saveSettings();
							await this.plugin.syncNow(false);
							this.display();
						}).open(),
					),
			)
			.addExtraButton((button) =>
				button
					.setIcon('trash-2')
					.setTooltip(t('delete'))
					.onClick(async () => {
						const ok = await confirmAction(this.app, {
							title: t('deleteCalendar'),
							message: t('deleteCalendarMessage', { name: account.name }),
							confirmText: t('delete'),
							danger: true,
						});
						if (!ok) {
							return;
						}
						settings.accounts = settings.accounts.filter((a) => a.id !== account.id);
						this.plugin.sync.forget(account.id);
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
						this.display();
					}),
			);
	}

	private openAddMenu(event: MouseEvent): void {
		const menu = new Menu();
		const presets: [AccountPreset, string, string][] = [
			['yandex', t('presetYandex'), 'calendar'],
			['google', t('presetGoogle'), 'calendar'],
			['caldav', t('presetCaldav'), 'server'],
			['ics', t('presetIcs'), 'link'],
		];
		for (const [preset, title, icon] of presets) {
			menu.addItem((item) =>
				item
					.setTitle(title)
					.setIcon(icon)
					.onClick(() =>
						new AccountModal(this.plugin, newAccount(preset), true, async (account) => {
							this.plugin.settings.accounts.push(account);
							await this.plugin.saveSettings();
							this.display();
							const report = await this.plugin.syncNow(false);
							const failed = report?.errors.find((e) => e.account.id === account.id);
							new Notice(
								failed
									? t('syncFailed', { name: account.name, error: describeSyncError(failed.error) })
									: t('calendarAdded', { name: account.name }),
								failed ? 10_000 : 4000,
							);
							this.display();
						}).open(),
					),
			);
		}
		menu.showAtMouseEvent(event);
	}
}
