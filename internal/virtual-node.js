// internal/virtual-node.js
//
// Background-thread-only "virtual" mirror of LynxNodeWrapper/LynxStyleProxy
// (src/lynx-mithril-shim.js). Implements the EXACT SAME duck-typed DOM
// surface Mithril's render.js needs (per ../CONTRACT.md) — createElement,
// appendChild, style, addEventListener, etc — but backed by a plain-JS
// shadow tree instead of real Element PAPI calls, since the background
// thread has no PAPI access at all.
//
// Every node gets a unique `vid` (vid 0 is reserved for the page root, by
// convention shared with renderer/main-thread.js — no handshake needed).
// Every WRITE emits a serializable op addressed by vid; ops describe the
// SAME method calls a real LynxNodeWrapper would receive (createElement,
// appendChild, setProp, setAttribute, setStyleProps, ...), so
// renderer/main-thread.js's applyPatch() can replay them by calling those
// exact methods on real LynxNodeWrapper instances — no PAPI-mapping logic
// is duplicated here; the real wrapper's own (already-tested) setters do
// that mapping on replay.
//
// Because the render algorithm (factory() in the shim) is UNMODIFIED and
// only ever talks to `dom.*` methods generically, this file is a complete,
// independent implementation of the wrapper contract — it does not import
// or extend the real LynxNodeWrapper.

"use strict"

var DIRECT_PROPS = ["value", "checked", "selectedIndex", "className", "id", "type"]

function camelize(str) {
	return str.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase() })
}

// Mirrors the real LynxStyleProxy's registry exactly: render.js sometimes
// writes a style property via plain camelCase assignment
// (`element.style.fontSize = "20px"`) with no prior setProperty() call, so
// no accessor exists yet to trigger a flush on write. Flushing every
// registered proxy at the end of a render/redraw pass (mirroring the real
// shim's flushTree(), see createVirtualDocument's returned flushStyleProxies)
// is the safety net that catches those. The registry is scoped to one
// createVirtualDocument() call (passed in as `register`), not module-level —
// a real app only ever creates one document, but this keeps independent
// virtual trees (as in tests) from leaking proxies into each other.
function VirtualStyleProxy(wrapper, register) {
	this._wrapper = wrapper
	this._props = {}
	register(this)
}

VirtualStyleProxy.prototype._flush = function () {
	var styles = {}
	var keys = Object.keys(this)
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i]
		if (key === "_wrapper" || key === "_props") continue
		var value = this[key]
		if (value == null) continue
		styles[camelize(key)] = String(value)
	}
	this._wrapper._emit({ op: "setStyleProps", vid: this._wrapper._vid, styles: styles })
}

VirtualStyleProxy.prototype.setProperty = function (name, value) {
	var key = camelize(name)
	if (value == null || value === "") {
		this.removeProperty(name)
		return
	}
	var self = this
	if (!Object.prototype.hasOwnProperty.call(this, key)) {
		Object.defineProperty(this, key, {
			configurable: true,
			enumerable: true,
			get: function () { return self._props[key] },
			set: function (v) {
				if (v == null || v === "") delete self._props[key]
				else self._props[key] = String(v)
				self._flush()
			}
		})
	}
	this._props[key] = String(value)
	this._flush()
}

VirtualStyleProxy.prototype.removeProperty = function (name) {
	var key = camelize(name)
	delete this._props[key]
	if (Object.prototype.hasOwnProperty.call(this, key)) delete this[key]
	this._flush()
}

Object.defineProperty(VirtualStyleProxy.prototype, "cssText", {
	get: function () {
		var out = []
		for (var key in this._props) out.push(key + ":" + this._props[key])
		return out.join(";")
	},
	set: function (value) {
		var self = this
		Object.keys(this).forEach(function (key) {
			if (key !== "_wrapper" && key !== "_props") delete self[key]
		})
		this._props = {}
		if (value) {
			// Only used for the shim's first-render `dom.style = ""` clear path
			// in practice — a non-empty string assignment isn't exercised by
			// render.js itself (see CONTRACT.md §f), so no parsing is needed here.
			this._flush()
		}
	}
})

function VirtualNodeWrapper(vid, emit, registerStyleProxy) {
	this._vid = vid
	this._emit = emit
	this._style = new VirtualStyleProxy(this, registerStyleProxy)
	this._directProps = {}
	this._listeners = Object.create(null)
	this._isRawText = false
	this._text = null
	this._document = null
	this._tag = null
	this._parent = null
	this._children = []
	this.vnodes = null
}

Object.defineProperty(VirtualNodeWrapper.prototype, "nodeType", {
	get: function () { return this._isRawText ? 3 : 1 }
})

Object.defineProperty(VirtualNodeWrapper.prototype, "ownerDocument", {
	get: function () { return this._document }
})

Object.defineProperty(VirtualNodeWrapper.prototype, "namespaceURI", {
	get: function () { return undefined }
})

Object.defineProperty(VirtualNodeWrapper.prototype, "parentNode", {
	get: function () { return this._parent }
})

Object.defineProperty(VirtualNodeWrapper.prototype, "firstChild", {
	get: function () { return this._children.length > 0 ? this._children[0] : null }
})

Object.defineProperty(VirtualNodeWrapper.prototype, "nextSibling", {
	get: function () {
		if (this._parent == null) return null
		var siblings = this._parent._children
		var index = siblings.indexOf(this)
		return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null
	}
})

Object.defineProperty(VirtualNodeWrapper.prototype, "textContent", {
	get: function () {
		if (this._isRawText) return this._text
		var out = ""
		for (var i = 0; i < this._children.length; i++) out += this._children[i].textContent
		return out
	},
	set: function (value) {
		if (this._isRawText) {
			this.nodeValue = value
			return
		}
		// Mirrors the real wrapper: only ever called with "" (first-render
		// clear). A genuinely non-empty assignment isn't exercised by
		// render.js (see CONTRACT.md) so it's intentionally not implemented.
		if (this._children.length > 0) {
			var removed = this._children.slice()
			for (var i = 0; i < removed.length; i++) this.removeChild(removed[i])
		}
	}
})

Object.defineProperty(VirtualNodeWrapper.prototype, "nodeValue", {
	get: function () { return this._isRawText ? this._text : null },
	set: function (value) {
		if (this._isRawText) {
			this._text = String(value)
			this._emit({ op: "setText", vid: this._vid, value: this._text })
		}
	}
})

Object.defineProperty(VirtualNodeWrapper.prototype, "innerHTML", {
	get: function () { return this.textContent },
	set: function () {
		throw new Error("m.trust / innerHTML is not supported by the Lynx shim (renderer mode).")
	}
})

Object.defineProperty(VirtualNodeWrapper.prototype, "style", {
	get: function () { return this._style },
	set: function (value) {
		if (value == null) this._style.cssText = ""
		else if (typeof value === "string") this._style.cssText = value
	}
})

DIRECT_PROPS.forEach(function (p) {
	Object.defineProperty(VirtualNodeWrapper.prototype, p, {
		configurable: true,
		enumerable: true,
		get: function () { return this._directProps[p] },
		set: function (v) {
			this._directProps[p] = v
			this._emit({ op: "setProp", vid: this._vid, key: p, value: v })
		}
	})
})

VirtualNodeWrapper.prototype.setAttribute = function (key, value) {
	this._emit({ op: "setAttribute", vid: this._vid, key: key, value: value == null ? null : String(value) })
}

VirtualNodeWrapper.prototype.removeAttribute = function (key) {
	this._emit({ op: "removeAttribute", vid: this._vid, key: key })
}

VirtualNodeWrapper.prototype.setAttributeNS = function (ns, key, value) {
	this.setAttribute(key, value)
}

VirtualNodeWrapper.prototype.appendChild = function (child) {
	if (child == null) return child
	if (child.nodeType === 11) return child // inert fragment
	if (child._parent != null) {
		var oldSiblings = child._parent._children
		var oldIndex = oldSiblings.indexOf(child)
		if (oldIndex >= 0) oldSiblings.splice(oldIndex, 1)
	}
	this._children.push(child)
	child._parent = this
	this._emit({ op: "appendChild", parentVid: this._vid, childVid: child._vid })
	return child
}

VirtualNodeWrapper.prototype.insertBefore = function (child, ref) {
	if (child == null) return child
	if (child.nodeType === 11) return child
	if (ref == null) return this.appendChild(child)
	if (child._parent != null) {
		var oldSiblings = child._parent._children
		var oldIndex = oldSiblings.indexOf(child)
		if (oldIndex >= 0) oldSiblings.splice(oldIndex, 1)
	}
	var refIndex = this._children.indexOf(ref)
	this._children.splice(refIndex >= 0 ? refIndex : this._children.length, 0, child)
	child._parent = this
	this._emit({ op: "insertBefore", parentVid: this._vid, childVid: child._vid, refVid: ref._vid })
	return child
}

VirtualNodeWrapper.prototype.removeChild = function (child) {
	if (child == null) return child
	if (child.nodeType === 11) return child
	var index = this._children.indexOf(child)
	if (index >= 0) this._children.splice(index, 1)
	child._parent = null
	this._emit({ op: "removeChild", parentVid: this._vid, childVid: child._vid })
	return child
}

VirtualNodeWrapper.prototype.contains = function (other) {
	if (other == null) return false
	var node = other
	while (node != null) {
		if (node === this) return true
		node = node._parent
	}
	return false
}

VirtualNodeWrapper.prototype.focus = function () {}

// Events: unlike the real wrapper (which wraps + registers a real PAPI
// listener per type), this only needs to know WHETHER a type transitions
// between "has a handler" and "has none" — that's what the main thread
// needs to know to attach/detach its forwarding listener. The actual
// listener function/object is resolved by dispatchEvent() at CALL time, not
// registration time, so Mithril swapping vnode.events' handlers across
// redraws (a very common pattern) never needs a new op.
VirtualNodeWrapper.prototype.addEventListener = function (type, listener) {
	var hadListener = this._listeners[type] != null
	this._listeners[type] = listener
	if (!hadListener) this._emit({ op: "addEvent", vid: this._vid, type: type })
}

VirtualNodeWrapper.prototype.removeEventListener = function (type, listener) {
	if (this._listeners[type] !== listener) return
	delete this._listeners[type]
	this._emit({ op: "removeEvent", vid: this._vid, type: type })
}

// Invoked when renderer/background.js receives a forwarded real-PAPI event.
VirtualNodeWrapper.prototype.dispatchEvent = function (ev) {
	var listener = this._listeners[ev.type]
	if (listener == null) return
	if (typeof listener === "function") listener.call(ev.currentTarget, ev)
	else if (typeof listener.handleEvent === "function") listener.handleEvent(ev)
}

function createRawTextNode(vid, emit, registerStyleProxy, value) {
	var wrapper = new VirtualNodeWrapper(vid, emit, registerStyleProxy)
	wrapper._isRawText = true
	wrapper._text = String(value)
	emit({ op: "createText", vid: vid, value: wrapper._text })
	return wrapper
}

function createElementWrapper(vid, emit, registerStyleProxy, tag) {
	var wrapper = new VirtualNodeWrapper(vid, emit, registerStyleProxy)
	wrapper._tag = tag
	emit({ op: "createElement", vid: vid, tag: tag })
	return wrapper
}

// Inert fragment — same "never attached, children go straight to the real
// parent" contract as the real shim's createFragment().
function createFragment(document) {
	return {
		nodeType: 11,
		ownerDocument: document,
		appendChild: function () {},
		insertBefore: function () {},
		removeChild: function () {}
	}
}

// createVirtualDocument(emit, onCreateNode) — emit(op) is called
// synchronously for every mutation; the caller (renderer/background.js) is
// responsible for batching and flushing the accumulated ops across the
// thread boundary. onCreateNode(wrapper) is called for every node created
// (root included) so the caller can index wrappers by vid. Each call gets
// its own independent style-proxy registry and vid counter — see
// VirtualStyleProxy's comment for why this isn't module-level.
function createVirtualDocument(emit, onCreateNode) {
	var nextVid = 1 // vid 0 is reserved for the page root.
	var notify = onCreateNode || function () {}
	var styleProxies = []
	var registerStyleProxy = function (proxy) { styleProxies.push(proxy) }

	var document = {
		createElement: function (tag) {
			var wrapper = createElementWrapper(nextVid++, emit, registerStyleProxy, tag)
			wrapper._document = document
			notify(wrapper)
			return wrapper
		},
		createElementNS: function (ns, tag) {
			return document.createElement(tag)
		},
		createTextNode: function (value) {
			var wrapper = createRawTextNode(nextVid++, emit, registerStyleProxy, value)
			wrapper._document = document
			notify(wrapper)
			return wrapper
		},
		createDocumentFragment: function () {
			return createFragment(document)
		}
	}
	Object.defineProperty(document, "activeElement", {
		get: function () { return null }
	})

	function createRootWrapper() {
		var root = new VirtualNodeWrapper(0, emit, registerStyleProxy)
		root._document = document
		root._tag = "page"
		notify(root)
		return root
	}

	function flushStyleProxies() {
		for (var i = 0; i < styleProxies.length; i++) {
			try { styleProxies[i]._flush() } catch (e) { /* ignore */ }
		}
	}

	return { document: document, createRootWrapper: createRootWrapper, flushStyleProxies: flushStyleProxies }
}

export { createVirtualDocument, VirtualNodeWrapper, VirtualStyleProxy }
