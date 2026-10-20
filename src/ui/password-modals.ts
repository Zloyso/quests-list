import { type App, Modal, Platform } from 'obsidian';
import { t } from '../i18n';
import { WrongPasswordError } from '../store';

export const MIN_PASSWORD_LENGTH = 6;

interface Field {
	input: HTMLInputElement;
}

/** Password form in a modal. `submit` returns an error message to show, or null when done. */
abstract class PasswordModal extends Modal {
	private done = false;
	private resolve!: (ok: boolean) => void;
	protected form!: HTMLFormElement;
	private error!: HTMLElement;
	private button!: HTMLButtonElement;

	constructor(app: App) {
		super(app);
	}

	/** Opens the modal; resolves to true when the form was submitted successfully. */
	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	protected abstract heading(): string;
	protected abstract buildFields(): void;
	protected abstract submitText(): string;
	protected abstract submit(): Promise<string | null>;

	protected field(label: string, autocomplete: string): Field {
		this.form.createEl('label', { text: label, cls: 'quests-label' });
		const input = this.form.createEl('input', { type: 'password', attr: { autocomplete } });
		input.setAttrs({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
		return { input };
	}

	onOpen(): void {
		this.setTitle(this.heading());
		this.form = this.contentEl.createEl('form', { cls: 'quests-form' });
		this.buildFields();
		this.error = this.form.createDiv({ cls: 'quests-error' });
		const actions = this.form.createDiv({ cls: 'quests-form-actions' });
		actions.createEl('button', { text: t('cancel'), attr: { type: 'button' } }).addEventListener('click', () => this.close());
		this.button = actions.createEl('button', { text: this.submitText(), attr: { type: 'submit' }, cls: 'mod-cta' });
		this.form.addEventListener('submit', (event) => {
			event.preventDefault();
			void this.run();
		});
		if (!Platform.isMobile) {
			window.setTimeout(() => this.form.querySelector('input')?.focus(), 0);
		}
	}

	private async run(): Promise<void> {
		this.error.setText('');
		this.button.disabled = true;
		this.button.setText(t('working'));
		let message: string | null;
		try {
			message = await this.submit();
		} catch (err) {
			if (err instanceof WrongPasswordError) {
				message = t('wrongPassword');
			} else {
				console.error('Quests List: password operation failed', err);
				message = t('saveFailed');
			}
		}
		this.button.disabled = false;
		this.button.setText(this.submitText());
		if (message) {
			this.error.setText(message);
			this.form.querySelector('input')?.select();
			return;
		}
		this.done = true;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve?.(this.done);
	}
}

/** Asks for the password to open private lists. */
export class UnlockModal extends PasswordModal {
	private password!: Field;

	constructor(
		app: App,
		private readonly unlock: (password: string) => Promise<void>,
	) {
		super(app);
	}

	protected heading(): string {
		return t('privateUnlockTitle');
	}

	protected submitText(): string {
		return t('privateUnlock');
	}

	protected buildFields(): void {
		this.form.createEl('p', { cls: 'quests-muted quests-modal-message', text: t('privateUnlockHint') });
		this.password = this.field(t('password'), 'current-password');
	}

	protected async submit(): Promise<string | null> {
		if (!this.password.input.value) {
			return t('passwordEmpty');
		}
		await this.unlock(this.password.input.value);
		this.password.input.value = '';
		return null;
	}
}

/** Creates the password for private lists. */
export class CreatePasswordModal extends PasswordModal {
	private password!: Field;
	private confirm!: Field;

	constructor(
		app: App,
		private readonly create: (password: string) => Promise<void>,
	) {
		super(app);
	}

	protected heading(): string {
		return t('privateCreateTitle');
	}

	protected submitText(): string {
		return t('privateCreate');
	}

	protected buildFields(): void {
		this.form.createEl('p', { cls: 'quests-muted quests-modal-message', text: t('privateCreateHint') });
		this.password = this.field(t('newPassword'), 'new-password');
		this.confirm = this.field(t('confirmPassword'), 'new-password');
		this.form.createEl('p', { cls: 'quests-warning', text: t('privateForgetWarning') });
	}

	protected async submit(): Promise<string | null> {
		const value = this.password.input.value;
		if (value.length < MIN_PASSWORD_LENGTH) {
			return t('passwordTooShort', { count: MIN_PASSWORD_LENGTH });
		}
		if (value !== this.confirm.input.value) {
			return t('passwordsDoNotMatch');
		}
		await this.create(value);
		return null;
	}
}

/** Changes the password; private lists are re-encrypted. */
export class ChangePasswordModal extends PasswordModal {
	private current!: Field;
	private password!: Field;
	private confirm!: Field;

	constructor(
		app: App,
		private readonly change: (oldPassword: string, newPassword: string) => Promise<void>,
	) {
		super(app);
	}

	protected heading(): string {
		return t('privateChangeTitle');
	}

	protected submitText(): string {
		return t('privateChange');
	}

	protected buildFields(): void {
		this.current = this.field(t('currentPassword'), 'current-password');
		this.password = this.field(t('newPassword'), 'new-password');
		this.confirm = this.field(t('confirmPassword'), 'new-password');
	}

	protected async submit(): Promise<string | null> {
		const value = this.password.input.value;
		if (value.length < MIN_PASSWORD_LENGTH) {
			return t('passwordTooShort', { count: MIN_PASSWORD_LENGTH });
		}
		if (value !== this.confirm.input.value) {
			return t('passwordsDoNotMatch');
		}
		await this.change(this.current.input.value, value);
		return null;
	}
}
