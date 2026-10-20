import { setIcon, setTooltip } from 'obsidian';
import { t } from '../i18n';
import type { ListColor } from '../model';

export function iconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: (event: MouseEvent) => void,
	cls = '',
): HTMLButtonElement {
	const button = parent.createEl('button', {
		cls: `clickable-icon quests-icon-button ${cls}`.trim(),
		attr: { 'aria-label': label, type: 'button' },
	});
	setIcon(button, icon);
	setTooltip(button, label);
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		onClick(event);
	});
	return button;
}

/** Button with an icon and a text label, the size of an icon button in height. */
export function textButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: (event: MouseEvent) => void,
	cls = '',
): HTMLButtonElement {
	const button = parent.createEl('button', { cls: `mod-cta quests-text-button ${cls}`.trim(), attr: { type: 'button' } });
	setIcon(button.createSpan({ cls: 'quests-text-button-icon' }), icon);
	button.createSpan({ cls: 'quests-text-button-label', text: label });
	setTooltip(button, label);
	button.addEventListener('click', (event) => {
		event.stopPropagation();
		onClick(event);
	});
	return button;
}

/**
 * Round "done" checkbox. A plain element rather than a <button>: theme and mobile button styles
 * (padding, min-height) would stretch it into an oval.
 */
export function renderCheckbox(parent: HTMLElement, checked: boolean, color: ListColor | null, onToggle: () => void): HTMLElement {
	const label = checked ? t('markOpen') : t('markDone');
	const box = parent.createDiv({
		cls: 'quests-check quests-no-drag',
		attr: { role: 'checkbox', tabindex: '0', 'aria-checked': String(checked), 'aria-label': label },
	});
	box.toggleClass('is-checked', checked);
	setColor(box, color);
	setIcon(box, 'check');
	setTooltip(box, label);
	const toggle = (event: Event) => {
		event.preventDefault();
		event.stopPropagation();
		onToggle();
	};
	box.addEventListener('click', toggle);
	box.addEventListener('keydown', (event) => {
		if (event.key === ' ' || event.key === 'Enter') {
			toggle(event);
		}
	});
	return box;
}

/** Opens the browser's date/time picker; falls back to focusing the input (which opens it on phones). */
export function openNativePicker(input: HTMLInputElement): void {
	try {
		if (typeof input.showPicker === 'function') {
			input.showPicker();
			return;
		}
	} catch {
		// Not allowed here (e.g. not a user gesture); focus instead.
	}
	input.focus();
}

/** Theme color for a list or calendar; neutral accent when none is set. */
export function colorValue(color: ListColor | null): string {
	return color ? `var(--color-${color})` : 'var(--text-faint)';
}

export function setColor(el: HTMLElement, color: ListColor | null): void {
	el.setCssProps({ '--quests-color': colorValue(color) });
}

/** Makes a div behave like a button for keyboard users. */
export function makeActivatable(el: HTMLElement, activate: () => void): void {
	el.setAttrs({ role: 'button', tabindex: '0' });
	el.addEventListener('click', activate);
	el.addEventListener('keydown', (event) => {
		if ((event.key === 'Enter' || event.key === ' ') && event.target === el) {
			event.preventDefault();
			activate();
		}
	});
}

/** Grows a textarea with its content. */
export function autoGrow(textarea: HTMLTextAreaElement): void {
	const fit = () => {
		textarea.setCssProps({ height: 'auto' });
		textarea.setCssProps({ height: `${textarea.scrollHeight}px` });
	};
	textarea.addEventListener('input', fit);
	window.setTimeout(fit, 0);
}
