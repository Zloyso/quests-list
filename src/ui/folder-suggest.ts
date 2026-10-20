import { AbstractInputSuggest, type App, type TFolder } from 'obsidian';

const DATA_FOLDER_NAME = 'Quests';

/**
 * Suggests vault folders for the data folder setting. Picking a folder means "put the data folder here",
 * so the input gets "<folder>/Quests"; the name can still be edited.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		/** The current data folder: it and its subfolders cannot be targets. */
		private readonly current: string,
		private readonly onPick: (value: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.trim().toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.filter((folder) => !folder.path.split('/').some((part) => part.startsWith('.')))
			.filter((folder) => folder.path !== this.current && !folder.path.startsWith(`${this.current}/`))
			.filter((folder) => folder.path.toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		const value = `${folder.path}/${DATA_FOLDER_NAME}`;
		this.setValue(value);
		this.onPick(value);
		this.close();
	}
}
