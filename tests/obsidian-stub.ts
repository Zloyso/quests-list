/**
 * Minimal stand-in for the Obsidian API so the plugin can run under jsdom in tests.
 * Only what Quests List uses is implemented.
 */

type DomInfo = { cls?: string; text?: string; type?: string; value?: string; href?: string; attr?: Record<string, string> };

// ---------- DOM helpers that Obsidian adds ----------

function applyInfo(el: HTMLElement, info?: DomInfo | string): void {
	if (typeof info === 'string') {
		el.className = info;
		return;
	}
	if (!info) return;
	if (info.cls) el.className = info.cls;
	if (info.text !== undefined) el.textContent = info.text;
	if (info.type && el instanceof HTMLInputElement) el.type = info.type;
	if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
	if (info.href !== undefined) el.setAttribute('href', info.href);
	for (const [k, v] of Object.entries(info.attr ?? {})) el.setAttribute(k, v);
}

function install(proto: Record<string, unknown>): void {
	proto.createEl = function (this: Node, tag: string, info?: DomInfo | string) {
		const el = (this.ownerDocument ?? document).createElement(tag);
		applyInfo(el, info);
		this.appendChild(el);
		return el;
	};
	proto.createDiv = function (this: Node, info?: DomInfo | string) {
		return (this as unknown as { createEl: (t: string, i?: unknown) => HTMLElement }).createEl('div', info);
	};
	proto.createSpan = function (this: Node, info?: DomInfo | string) {
		return (this as unknown as { createEl: (t: string, i?: unknown) => HTMLElement }).createEl('span', info);
	};
	proto.empty = function (this: Node) {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	proto.appendText = function (this: Node, text: string) {
		this.appendChild((this.ownerDocument ?? document).createTextNode(text));
	};
}
install(HTMLElement.prototype as unknown as Record<string, unknown>);
install(DocumentFragment.prototype as unknown as Record<string, unknown>);

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.setText = function (this: HTMLElement, text: string) {
	this.textContent = text;
};
proto.addClass = function (this: HTMLElement, ...cls: string[]) {
	this.classList.add(...cls);
};
proto.removeClass = function (this: HTMLElement, ...cls: string[]) {
	this.classList.remove(...cls);
};
proto.toggleClass = function (this: HTMLElement, cls: string, value: boolean) {
	this.classList.toggle(cls, value);
};
proto.hasClass = function (this: HTMLElement, cls: string) {
	return this.classList.contains(cls);
};
proto.setAttrs = function (this: HTMLElement, attrs: Record<string, string>) {
	for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
};
proto.setAttr = function (this: HTMLElement, k: string, v: string) {
	this.setAttribute(k, v);
};
proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
	for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
};
Object.defineProperty(Node.prototype, 'doc', {
	get(this: Node) {
		return this.ownerDocument ?? document;
	},
});
Object.defineProperty(Node.prototype, 'win', {
	get(this: Node) {
		return (this.ownerDocument ?? document).defaultView ?? window;
	},
});
(globalThis as Record<string, unknown>).createFragment = (callback?: (el: DocumentFragment) => void) => {
	const fragment = document.createDocumentFragment();
	callback?.(fragment);
	return fragment;
};
(globalThis as Record<string, unknown>).activeDocument = document;
(globalThis as Record<string, unknown>).activeWindow = window;

if (typeof globalThis.PointerEvent === 'undefined') {
	class PointerEventPolyfill extends MouseEvent {
		pointerId: number;
		pointerType: string;
		constructor(type: string, init: PointerEventInit = {}) {
			super(type, init);
			this.pointerId = init.pointerId ?? 1;
			this.pointerType = init.pointerType ?? 'mouse';
		}
	}
	(globalThis as Record<string, unknown>).PointerEvent = PointerEventPolyfill;
}
if (typeof globalThis.ResizeObserver === 'undefined') {
	(globalThis as Record<string, unknown>).ResizeObserver = class {
		observe() {}
		disconnect() {}
	};
}

// ---------- API ----------

export const Platform = { isDesktop: true, isDesktopApp: true, isMobile: false, isPhone: false, isIosApp: false, isAndroidApp: false };

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function getLanguage(): string {
	return 'en';
}

export function setIcon(el: HTMLElement, icon: string): void {
	el.setAttribute('data-icon', icon);
}

export function setTooltip(): void {}

export function getIconIds(): string[] {
	return ['lucide-list', 'lucide-briefcase', 'lucide-house', 'lucide-book', 'lucide-car', 'lucide-cart'];
}

export const Keymap = { isModEvent: () => false };

export const notices: string[] = [];
export class Notice {
	constructor(message: string) {
		notices.push(message);
	}
}

export type RequestHandler = (req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
	status: number;
	text?: string;
	headers?: Record<string, string>;
};
export const http: { handler: RequestHandler } = { handler: () => ({ status: 500 }) };
export async function requestUrl(req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) {
	const res = http.handler(req);
	return { status: res.status, text: res.text ?? '', headers: res.headers ?? {} };
}

export class Component {
	loaded = false;
	load() {
		this.loaded = true;
	}
	unload() {
		this.loaded = false;
	}
	register() {}
	registerEvent() {}
	registerDomEvent(el: HTMLElement, type: string, cb: EventListener) {
		el.addEventListener(type, cb);
	}
	registerInterval(id: number) {
		return id;
	}
}

export const MarkdownRenderer = {
	async render(_app: unknown, markdown: string, el: HTMLElement) {
		el.createDiv({ cls: 'rendered-markdown', text: markdown });
	},
};

export const openModals: Modal[] = [];
export class Modal {
	contentEl = document.createElement('div');
	modalEl = document.createElement('div');
	title = '';
	constructor(public app: unknown) {
		this.modalEl.appendChild(this.contentEl);
		document.body.appendChild(this.modalEl);
	}
	setTitle(title: string) {
		this.title = title;
		return this;
	}
	open() {
		openModals.push(this);
		(this as unknown as { onOpen?: () => void }).onOpen?.();
	}
	close() {
		const i = openModals.indexOf(this);
		if (i >= 0) openModals.splice(i, 1);
		(this as unknown as { onClose?: () => void }).onClose?.();
		this.modalEl.remove();
	}
}

export class FuzzySuggestModal<T> extends Modal {
	emptyStateText = '';
	setPlaceholder() {}
	getItems(): T[] {
		return [];
	}
}

class ButtonComponent {
	buttonEl: HTMLButtonElement;
	constructor(parent: HTMLElement) {
		this.buttonEl = parent.ownerDocument.createElement('button');
		parent.appendChild(this.buttonEl);
	}
	setButtonText(text: string) {
		this.buttonEl.textContent = text;
		return this;
	}
	onClick(fn: (event: MouseEvent) => void) {
		this.buttonEl.addEventListener('click', fn);
		return this;
	}
	setCta() {
		return this;
	}
	setWarning() {
		return this;
	}
	setDisabled(disabled: boolean) {
		this.buttonEl.disabled = disabled;
		return this;
	}
	setIcon() {
		return this;
	}
	setTooltip() {
		return this;
	}
}

class ValueComponent<V> {
	private handler: ((value: V) => unknown) | null = null;
	value!: V;
	inputEl = document.createElement('input');
	options: string[] = [];
	setValue(value: V) {
		this.value = value;
		return this;
	}
	onChange(fn: (value: V) => unknown) {
		this.handler = fn;
		return this;
	}
	trigger(value: V) {
		this.value = value;
		return this.handler?.(value);
	}
	setPlaceholder() {
		return this;
	}
	setTooltip() {
		return this;
	}
	addOption(value: string) {
		this.options.push(value);
		return this;
	}
}

export class Setting {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	components: unknown[] = [];
	constructor(container: HTMLElement) {
		this.settingEl = container.ownerDocument.createElement('div');
		this.nameEl = this.settingEl.createDiv();
		container.appendChild(this.settingEl);
	}
	setName(name: string) {
		this.settingEl.setAttribute('data-name', name);
		this.nameEl.appendText(name);
		return this;
	}
	setDesc() {
		return this;
	}
	setHeading() {
		return this;
	}
	addButton(cb: (b: ButtonComponent) => void) {
		const b = new ButtonComponent(this.settingEl);
		cb(b);
		this.components.push(b);
		return this;
	}
	addExtraButton(cb: (b: ButtonComponent) => void) {
		return this.addButton(cb);
	}
	private addValue(cb: (c: ValueComponent<never>) => void) {
		const c = new ValueComponent<never>();
		cb(c);
		this.components.push(c);
		return this;
	}
	addToggle(cb: (c: ValueComponent<never>) => void) {
		return this.addValue(cb);
	}
	addDropdown(cb: (c: ValueComponent<never>) => void) {
		return this.addValue(cb);
	}
	addText(cb: (c: ValueComponent<never>) => void) {
		return this.addValue(cb);
	}
}

export interface MenuItemStub {
	title: string;
	click: () => void;
}
export const menus: MenuItemStub[][] = [];
export class Menu {
	items: MenuItemStub[] = [];
	addItem(cb: (item: unknown) => void) {
		const entry: MenuItemStub = { title: '', click: () => undefined };
		const item = {
			setTitle(title: string) {
				entry.title = title;
				return item;
			},
			setIcon() {
				return item;
			},
			setWarning() {
				return item;
			},
			setChecked() {
				return item;
			},
			onClick(fn: () => void) {
				entry.click = fn;
				return item;
			},
		};
		cb(item);
		this.items.push(entry);
		return this;
	}
	addSeparator() {
		return this;
	}
	showAtMouseEvent() {
		menus.push(this.items);
	}
}

export class ItemView extends Component {
	app: unknown;
	containerEl = document.createElement('div');
	contentEl = document.createElement('div');
	constructor(public leaf: { app: unknown }) {
		super();
		this.app = leaf.app;
		this.containerEl.appendChild(this.contentEl);
		document.body.appendChild(this.containerEl);
	}
	async setState() {}
}

export class AbstractInputSuggest<T> {
	constructor(
		public app: unknown,
		public inputEl: HTMLInputElement,
	) {}
	setValue(value: string) {
		this.inputEl.value = value;
	}
	close() {}
	/** Test helper: what the suggester would offer for `query`. */
	suggest(query: string): T[] {
		return (this as unknown as { getSuggestions(q: string): T[] }).getSuggestions(query);
	}
}

export class PluginSettingTab {
	containerEl = document.createElement('div');
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
}

export class Plugin extends Component {
	data: unknown = null;
	views = new Map<string, (leaf: unknown) => unknown>();
	commands: { id: string; callback?: () => unknown }[] = [];
	constructor(
		public app: { workspace: { onLayoutReady: (cb: () => unknown) => void } },
		public manifest: unknown,
	) {
		super();
	}
	async loadData() {
		return this.data;
	}
	async saveData(data: unknown) {
		this.data = JSON.parse(JSON.stringify(data));
	}
	registerView(type: string, factory: (leaf: unknown) => unknown) {
		this.views.set(type, factory);
	}
	addRibbonIcon() {}
	addCommand(command: { id: string; callback?: () => unknown }) {
		this.commands.push(command);
	}
	addSettingTab() {}
}

export class TAbstractFile {
	constructor(public path: string) {}
	get name() {
		return this.path.split('/').pop() ?? '';
	}
}

export class TFile extends TAbstractFile {
	stat = { mtime: 0, ctime: 0, size: 0 };
	get extension() {
		return this.name.includes('.') ? (this.name.split('.').pop() ?? '') : '';
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot() {
		return this.path === '' || this.path === '/';
	}
}

export type ViewStateResult = Record<string, unknown>;
export type WorkspaceLeaf = { app: unknown; view?: unknown };
