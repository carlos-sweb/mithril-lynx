// src/fake-dom.js
//
// A DOM implementation good enough for the REAL `render/render.js` (from
// `mithril-runtime`, https://github.com/carlos-sweb/mithril-runtime — a
// distribution of Mithril 2.3.8 that drops the browser-only route/trust/
// request APIs, with render/render.js itself otherwise unmodified from
// upstream, see CONTRACT.md §g) to run against — nothing more. The exact
// surface required is documented in `mithril-lynx/CONTRACT.md` (a prior,
// verified-by-grep extraction of what render.js actually touches on its
// `dom` parameter): createElement(NS)/createTextNode/createDocumentFragment,
// insertBefore/appendChild/removeChild, nodeValue, value/checked/
// selectedIndex, className, setAttribute/removeAttribute/setAttributeNS,
// style, innerHTML, textContent, firstChild, parentNode, ownerDocument,
// namespaceURI, contains, focus, nextSibling. render.js never calls
// `getAttribute` and never checks `nodeType` — so neither is implemented
// here.
//
// This file only runs on the BACKGROUND thread, against a `backend` that
// records patch ops instead of touching real elements (see
// backends/virtual-backend.js). The main thread never runs this file, or
// Mithril's render.js at all — it only replays the recorded ops through
// `apply-patch.js`, which calls the real Element PAPI directly. That split
// is the point of the whole architecture (see
// mithril-lynx-v2/.omo/plans/mithril-lynx-v2-desde-cero.md §3.1): only ONE
// side needs to be "a DOM", the other side only needs to be "a PAPI patch
// applier".

const DASH_CASE = /-/;

function camelToDash(name) {
	return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

class LynxNode {
	constructor(ownerDocument) {
		this.ownerDocument = ownerDocument;
		this._parent = null;
	}

	get parentNode() {
		return this._parent;
	}

	get nextSibling() {
		if (!this._parent) return null;
		const siblings = this._parent._children;
		const index = siblings.indexOf(this);
		return index === -1 ? null : (siblings[index + 1] ?? null);
	}
}

// Shared child-list bookkeeping for anything that can contain other nodes:
// real elements, fragments, and the document/root itself. `insertBefore`
// handles the one piece of real-DOM behavior render.js actually depends on
// for fragments (CONTRACT.md §c, `createDocumentFragment`): inserting a
// fragment moves ITS children into the target and leaves the fragment
// empty, rather than inserting the fragment node itself.
class LynxContainerNode extends LynxNode {
	constructor(ownerDocument) {
		super(ownerDocument);
		this._children = [];
	}

	get firstChild() {
		return this._children[0] ?? null;
	}

	contains(other) {
		let node = other;
		while (node) {
			if (node === this) return true;
			node = node._parent;
		}
		return false;
	}

	appendChild(child) {
		this.insertBefore(child, null);
		return child;
	}

	insertBefore(child, refChild) {
		if (child instanceof LynxFragment) {
			// Real DOM semantics: the fragment itself is never attached —
			// only its (already backend-created) children are moved in, in
			// order, then the fragment is left empty.
			const grandchildren = child._children.slice();
			child._children.length = 0;
			for (const gc of grandchildren) this.insertBefore(gc, refChild);
			return child;
		}
		if (child._parent) child._parent._removeChildBookkeeping(child);
		const index = refChild ? this._children.indexOf(refChild) : -1;
		if (index === -1) {
			this._children.push(child);
		} else {
			this._children.splice(index, 0, child);
		}
		child._parent = this;
		if (this._id != null && child._id != null) {
			this._backend.insertBefore(this._id, child._id, refChild ? refChild._id : -1);
		}
		return child;
	}

	removeChild(child) {
		this._removeChildBookkeeping(child);
		if (this._id != null && child._id != null) {
			this._backend.removeChild(this._id, child._id);
		}
		return child;
	}

	_removeChildBookkeeping(child) {
		const index = this._children.indexOf(child);
		if (index !== -1) this._children.splice(index, 1);
		child._parent = null;
	}
}

function createStyleProxy(element) {
	const methods = {
		setProperty(name, value) {
			element._backend.setStyleProperty(element._id, name, String(value));
		},
		removeProperty(name) {
			element._backend.removeStyleProperty(element._id, name);
		},
	};
	return new Proxy(methods, {
		get(target, prop) {
			return target[prop];
		},
		set(_target, prop, value) {
			if (typeof prop !== "string") return true;
			// Direct camelCase assignment path (CONTRACT.md §f, line 764/781).
			// Normalized to dash-case so the backend/PAPI only ever sees one
			// key shape regardless of which of Mithril's two style paths ran.
			const name = DASH_CASE.test(prop) ? prop : camelToDash(prop);
			if (value === "" || value == null) {
				element._backend.removeStyleProperty(element._id, name);
			} else {
				element._backend.setStyleProperty(element._id, name, String(value));
			}
			return true;
		},
	});
}

export class LynxElement extends LynxContainerNode {
	constructor(ownerDocument, backend, tag, ns) {
		super(ownerDocument);
		this._backend = backend;
		this.tag = tag;
		this.namespaceURI = ns;
		this._id = ns ? backend.createElementNS(ns, tag) : backend.createElement(tag);
		ownerDocument._nodesById.set(this._id, this);
		this._style = null;
		this._listeners = Object.create(null);
		// `hasPropertyKey` (CONTRACT.md §e) requires `"value" in vnode.dom` etc.
		// to be true for the property-write fast path to apply to form
		// elements — plain own properties satisfy the `in` check.
		this.value = undefined;
		this.checked = undefined;
		this.selectedIndex = undefined;
	}

	get style() {
		if (!this._style) this._style = createStyleProxy(this);
		return this._style;
	}

	set style(value) {
		if (value == null || value === "") {
			// `element.style = ""` (CONTRACT.md §f, lines 750-752): clear.
			// We don't track which properties were set, so this relies on the
			// backend/native side treating a style-reset op as "clear all" —
			// see backends/virtual-backend.js `Op.SetStyleProperty` with a
			// name of `*`.
			this._backend.removeStyleProperty(this._id, "*");
			return;
		}
		if (typeof value !== "object") {
			// `element.style = "color: red"` (string passthrough, §f lines
			// 753-755) — not supported: Lynx's style PAPI is key/value, not a
			// CSS-text parser. Documented limitation, not a silent bug.
			if (typeof console !== "undefined") {
				console.warn(
					"[mithril-lynx-v2] Assigning a CSS text string to `style` is not supported; use a style object.",
				);
			}
			return;
		}
		// Mithril itself never assigns a plain object to `.style` directly —
		// `updateStyle` always goes through `.setProperty`/property
		// assignment for object styles (§f). This branch exists only for
		// completeness against the DOM contract.
		for (const key of Object.keys(value)) {
			this.style[key] = value[key];
		}
	}

	get className() {
		return this._className ?? "";
	}

	set className(value) {
		// Mithril's `setAttr`/`removeAttr` map `className` -> the `"class"`
		// attribute (CONTRACT.md §e); routed here directly since `className`
		// is also a real property on this class (`hasPropertyKey` would
		// otherwise be tempted to use the property path instead).
		this._className = value;
		this._backend.setClasses(this._id, value == null ? "" : String(value));
	}

	setAttribute(name, value) {
		if (name === "class") {
			this.className = value;
			return;
		}
		this._backend.setAttribute(this._id, name, value == null ? null : String(value));
	}

	removeAttribute(name) {
		if (name === "class") {
			this.className = "";
			return;
		}
		this._backend.removeAttribute(this._id, name);
	}

	setAttributeNS(ns, name, value) {
		this._backend.setAttributeNS(this._id, ns, name, value == null ? null : String(value));
	}

	addEventListener(type, listener) {
		const isNew = !(type in this._listeners);
		this._listeners[type] = listener;
		if (isNew) this._backend.addEvent(this._id, type);
	}

	removeEventListener(type) {
		if (!(type in this._listeners)) return;
		delete this._listeners[type];
		this._backend.removeEvent(this._id, type);
	}

	/** Invoked by the background-side event router when a forwarded native
	 * event for this element's id arrives — see background.js. Mirrors what
	 * a real DOM does automatically for an EventListener OBJECT (as opposed
	 * to a plain function) registered via addEventListener: it calls
	 * `.handleEvent(ev)` on it. Mithril's own `EventDict` (render.js) relies
	 * on exactly this. */
	dispatchEvent(event) {
		const listener = this._listeners[event.type];
		if (!listener) return;
		if (typeof listener === "function") listener.call(event.currentTarget, event);
		else if (typeof listener.handleEvent === "function") listener.handleEvent(event);
	}

	set textContent(value) {
		// render.js only ever does `dom.textContent = ""` (first-render
		// clear, CONTRACT.md §b line 898) — implemented as "remove every
		// child", which is exactly what that assignment means for an
		// already-empty-or-not container.
		if (value !== "") {
			if (typeof console !== "undefined") {
				console.warn("[mithril-lynx-v2] Non-empty `textContent` assignment is not supported.");
			}
			return;
		}
		for (const child of this._children.slice()) this.removeChild(child);
	}

	set innerHTML(_value) {
		// `m.trust()`/contenteditable sync (CONTRACT.md §c) — Lynx elements
		// have no HTML-string target to parse into. Documented as
		// unsupported, matching this project's existing stance on other
		// browser-only Mithril features (e.g. `m.request`, see
		// mithril-lynx/AGENTS.md history) rather than silently doing nothing
		// with no signal.
		if (typeof console !== "undefined") {
			console.warn("[mithril-lynx-v2] `m.trust()` / innerHTML is not supported on Lynx elements.");
		}
	}

	focus() {
		// Native `<input>` focus on Lynx is managed by the platform, not by
		// a JS `.focus()` call reaching into the render pipeline — calling
		// into the backend here would mean patch application could disturb
		// focus mid-keystroke, which is the exact failure mode
		// mithril-lynx v1 was designed around (its `<input>` deliberately
		// has no bound `value` for the same reason). No-op by design.
	}
}

export class LynxText extends LynxNode {
	constructor(ownerDocument, backend, text) {
		super(ownerDocument);
		this._backend = backend;
		this._id = backend.createText(text);
	}

	get nodeValue() {
		return this._text;
	}

	set nodeValue(value) {
		this._text = value;
		this._backend.setText(this._id, value);
	}
}

// Fragments never get a backend id — see LynxContainerNode#insertBefore,
// which special-cases them by moving their children instead of attaching
// the fragment itself. `_id` stays `undefined` on purpose: the `if
// (this._id != null && child._id != null)` guards in insertBefore/
// removeChild are what keep a fragment-as-parent from ever trying to call
// the backend for itself.
export class LynxFragment extends LynxContainerNode {}

export class LynxDocument extends LynxContainerNode {
	constructor(backend) {
		super(null);
		this._backend = backend;
		this.ownerDocument = this;
		// id 0 is reserved for "the real page container" — pre-registered by
		// the main-thread patch applier before any ops are replayed (see
		// apply-patch.js). Explicit and inspectable, unlike an implicit
		// "whatever the first created element happens to be" convention.
		this._id = 0;
		this.namespaceURI = undefined;
		/** id -> node, for dispatching a forwarded native event (which only
		 * carries an id + type) to the right fake-dom element. Populated by
		 * every LynxElement/LynxText constructor; never by fragments, which
		 * have no id and are never event targets. */
		this._nodesById = new Map();
	}

	getNodeById(id) {
		return this._nodesById.get(id) ?? null;
	}

	focus() {
		// Never meaningfully called on the document root itself; present so
		// render.js's post-render focus-restoration check (CONTRACT.md §b)
		// never throws if `activeElement` happens to resolve to the root.
	}

	set textContent(value) {
		if (value !== "") return;
		for (const child of this._children.slice()) this.removeChild(child);
	}

	createElement(tag) {
		return new LynxElement(this, this._backend, tag, undefined);
	}

	createElementNS(ns, tag) {
		return new LynxElement(this, this._backend, tag, ns);
	}

	createTextNode(text) {
		return new LynxText(this, this._backend, text);
	}

	createDocumentFragment() {
		return new LynxFragment(this);
	}
}

export function createLynxDocument(backend) {
	return new LynxDocument(backend);
}
