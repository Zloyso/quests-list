/**
 * Drag and drop on pointer events, so it works with a mouse and on touch screens
 * (HTML5 drag and drop does not work with touch in mobile Obsidian).
 * Mouse: drag the whole element. Touch and pen: drag by the handle.
 */

export type DropPosition = 'before' | 'after' | 'inside';

export interface DropSpot {
	el: HTMLElement;
	position: DropPosition;
}

export interface DragOptions {
	/** Text shown next to the pointer. */
	label: string;
	/** Where the item would land for the element under the pointer, or null when it cannot be dropped there. */
	locate(target: Element | null, x: number, y: number): DropSpot | null;
	drop(spot: DropSpot): void;
}

const THRESHOLD = 5;
const EDGE = 40;
const SCROLL_STEP = 14;
const SPOT_CLASSES = ['quests-drop-before', 'quests-drop-after', 'quests-drop-inside'];

/** Before or after `el`, depending on which half the pointer is over. */
export function halfOf(el: HTMLElement, y: number): DropPosition {
	const rect = el.getBoundingClientRect();
	return y < rect.top + rect.height / 2 ? 'before' : 'after';
}

/** For dropping onto items that can also hold things: top quarter = before, bottom quarter = after, middle = inside. */
export function zoneOf(el: HTMLElement, y: number): DropPosition {
	const rect = el.getBoundingClientRect();
	const quarter = rect.height / 4;
	return y < rect.top + quarter ? 'before' : y > rect.bottom - quarter ? 'after' : 'inside';
}

export function makeDraggable(el: HTMLElement, handle: HTMLElement | null, getOptions: () => DragOptions): void {
	handle?.addClass('quests-drag-handle');
	el.addEventListener('pointerdown', (event: PointerEvent) => {
		if (event.button !== 0) {
			return;
		}
		const target = event.target as HTMLElement;
		const fromHandle = handle?.contains(target) ?? false;
		if (event.pointerType !== 'mouse' && !fromHandle) {
			return;
		}
		if (!fromHandle && target.closest('input, textarea, select, button, a, .quests-no-drag')) {
			return;
		}
		track(event, el, getOptions);
	});
}

function track(down: PointerEvent, el: HTMLElement, getOptions: () => DragOptions): void {
	const doc = el.doc;
	const win = el.win;
	let options: DragOptions | null = null;
	let ghost: HTMLElement | null = null;
	let spot: DropSpot | null = null;
	let x = down.clientX;
	let y = down.clientY;
	let scrollTimer = 0;

	const setSpot = (next: DropSpot | null) => {
		if (next?.el === spot?.el && next?.position === spot?.position) {
			return;
		}
		spot?.el.removeClass(...SPOT_CLASSES);
		spot = next;
		spot?.el.addClass(`quests-drop-${spot.position}`);
	};

	const update = () => {
		if (!options || !ghost) {
			return;
		}
		ghost.setCssProps({ '--quests-x': `${x}px`, '--quests-y': `${y}px` });
		setSpot(options.locate(doc.elementFromPoint(x, y), x, y));
	};

	const autoScroll = () => {
		const scroller = doc.elementFromPoint(x, y)?.closest<HTMLElement>('.quests-scroll');
		if (!scroller) {
			return;
		}
		const rect = scroller.getBoundingClientRect();
		const before = scroller.scrollTop;
		if (y < rect.top + EDGE) {
			scroller.scrollTop -= SCROLL_STEP;
		} else if (y > rect.bottom - EDGE) {
			scroller.scrollTop += SCROLL_STEP;
		}
		if (scroller.scrollTop !== before) {
			update();
		}
	};

	const start = () => {
		options = getOptions();
		el.addClass('is-dragging');
		doc.body.addClass('quests-is-dragging');
		ghost = doc.body.createDiv({ cls: 'quests-drag-ghost', text: options.label });
		scrollTimer = win.setInterval(autoScroll, 30);
	};

	const onMove = (event: PointerEvent) => {
		if (event.pointerId !== down.pointerId) {
			return;
		}
		x = event.clientX;
		y = event.clientY;
		if (!options) {
			if (Math.hypot(x - down.clientX, y - down.clientY) < THRESHOLD) {
				return;
			}
			start();
		}
		event.preventDefault();
		update();
	};

	const finish = (commit: boolean) => {
		win.removeEventListener('pointermove', onMove);
		win.removeEventListener('pointerup', onUp);
		win.removeEventListener('pointercancel', onCancel);
		win.removeEventListener('keydown', onKey, true);
		win.clearInterval(scrollTimer);
		if (!options) {
			return;
		}
		const target = spot;
		setSpot(null);
		ghost?.remove();
		el.removeClass('is-dragging');
		doc.body.removeClass('quests-is-dragging');
		// The click that follows releasing the mouse must not open the item.
		const swallow = (event: Event) => {
			event.stopPropagation();
			event.preventDefault();
		};
		win.addEventListener('click', swallow, { capture: true, once: true });
		win.setTimeout(() => win.removeEventListener('click', swallow, { capture: true }), 0);
		if (commit && target) {
			options.drop(target);
		}
	};

	const onUp = (event: PointerEvent) => {
		if (event.pointerId === down.pointerId) {
			finish(true);
		}
	};
	const onCancel = (event: PointerEvent) => {
		if (event.pointerId === down.pointerId) {
			finish(false);
		}
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			finish(false);
		}
	};

	win.addEventListener('pointermove', onMove, { passive: false });
	win.addEventListener('pointerup', onUp);
	win.addEventListener('pointercancel', onCancel);
	win.addEventListener('keydown', onKey, true);
}
