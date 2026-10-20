import { type App, getIconIds, Modal, setIcon, setTooltip } from 'obsidian';
import { t } from '../i18n';

/** Icons that suit task lists, shown before searching. Names that this Obsidian version lacks are skipped. */
const SUGGESTED = [
	'list', 'list-checks', 'list-todo', 'check-square', 'inbox', 'star', 'flag', 'bookmark', 'heart', 'target',
	'briefcase', 'building-2', 'house', 'home', 'user', 'users', 'baby', 'dog', 'cat',
	'shopping-cart', 'shopping-bag', 'wallet', 'piggy-bank', 'credit-card', 'receipt', 'gift',
	'calendar', 'clock', 'alarm-clock', 'bell', 'mail', 'phone', 'message-circle',
	'book', 'book-open', 'graduation-cap', 'lightbulb', 'brain', 'pencil', 'pen-tool', 'palette', 'file-text', 'folder', 'archive',
	'code', 'terminal', 'laptop', 'smartphone', 'wrench', 'hammer', 'settings',
	'dumbbell', 'bike', 'footprints', 'heart-pulse', 'pill', 'stethoscope', 'apple', 'utensils', 'coffee', 'chef-hat',
	'car', 'plane', 'train-front', 'map-pin', 'globe', 'tent', 'mountain',
	'music', 'film', 'camera', 'gamepad-2', 'tv', 'headphones',
	'sun', 'moon', 'cloud', 'leaf', 'flower', 'trees', 'sprout', 'flame', 'zap', 'sparkles',
	'rocket', 'trophy', 'medal', 'crown', 'gem', 'puzzle', 'package', 'truck', 'shield', 'key', 'lock',
];
const MAX_RESULTS = 200;

function iconName(id: string): string {
	return id.replace(/^lucide-/, '');
}

/** Grid of Obsidian icons with search. `onPick(null)` restores the default icon. */
export class IconPicker extends Modal {
	private grid!: HTMLElement;
	private readonly allIds: string[];

	constructor(
		app: App,
		private readonly current: string | null,
		private readonly onPick: (icon: string | null) => void,
	) {
		super(app);
		let ids: string[] = [];
		try {
			ids = getIconIds();
		} catch {
			// Older Obsidian: only the suggested set.
		}
		this.allIds = ids;
	}

	onOpen(): void {
		this.setTitle(t('iconPickerTitle'));
		this.modalEl.addClass('quests-icon-picker');
		const search = this.contentEl.createEl('input', {
			type: 'search',
			cls: 'quests-icon-search',
			attr: { placeholder: t('iconSearch'), 'aria-label': t('iconSearch') },
		});
		search.addEventListener('input', () => this.renderGrid(search.value));
		this.grid = this.contentEl.createDiv({ cls: 'quests-icon-grid' });
		this.renderGrid('');

		const footer = this.contentEl.createDiv({ cls: 'quests-form-actions' });
		footer.createEl('button', { text: t('defaultIcon'), attr: { type: 'button' } }).addEventListener('click', () => {
			this.onPick(null);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private suggested(): string[] {
		if (!this.allIds.length) {
			return SUGGESTED;
		}
		const known = new Set(this.allIds.map(iconName));
		const seen = new Set<string>();
		return SUGGESTED.filter((name) => known.has(name) && !seen.has(name) && seen.add(name));
	}

	private renderGrid(query: string): void {
		this.grid.empty();
		const q = query.trim().toLowerCase();
		const names = q
			? [...new Set(this.allIds.map(iconName))].filter((name) => name.includes(q)).slice(0, MAX_RESULTS)
			: this.suggested();
		if (!names.length) {
			this.grid.createDiv({ cls: 'quests-muted quests-icon-empty', text: t('nothingFound') });
			return;
		}
		for (const name of names) {
			const cell = this.grid.createEl('button', {
				cls: 'clickable-icon quests-icon-cell',
				attr: { type: 'button', 'aria-label': name },
			});
			cell.toggleClass('is-active', iconName(this.current ?? '') === name);
			setIcon(cell, name);
			setTooltip(cell, name);
			cell.addEventListener('click', () => {
				this.onPick(name);
				this.close();
			});
		}
	}
}
