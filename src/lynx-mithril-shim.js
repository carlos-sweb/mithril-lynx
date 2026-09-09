// lynx-mithril-shim.js
//
// Contract-complete reimplementation of mithril/render/render.js@2.3.8
// mapping the mithril render contract onto the Lynx Element PAPI (main thread).
//
// Satisfies the mapping table in CONTRACT.md (Findings A & B of the
// rspeedy-mithril-scaffold plan). Key mappings:
//   - Every wrapper node exposes `ownerDocument` (a fakeDocument implementing
//     createElement / createElementNS / createTextNode / createDocumentFragment).
//   - Events use `__AddEventListener(node, name, fn, {})` with real JS function
//     handlers (NO `__SetEvents`). Lynx tap events are normalized to
//     `{type, currentTarget, redraw:false, preventDefault(){}, stopPropagation(){}}`.
//   - Styles go through LynxStyleProxy, which accepts BOTH
//     `setProperty("font-size", v)` and `style["fontSize"] = v`; all keys are
//     camelized before `__SetInlineStyles(node, camelizedObject)`.
//   - Text uses the raw-text pattern: `__CreateText(id)` + child
//     `__CreateRawText(value)`; dynamic updates via `__SetAttribute(raw, "text", v)`
//     + `__FlushElementTree()`. NO `__SetInnerText`.
//   - Fragments are inert `{nodeType: 11, ownerDocument, _parent:null,
//     appendChild(){}}` objects; their children are created directly in the real
//     parent and the fragment itself is never `__AppendElement`d.
//   - requestAnimationFrame/cancelAnimationFrame are polyfilled on top of
//     queueMicrotask; the flush hook calls `__FlushElementTree()` after each
//     mithril redraw pass, and node-mutation helpers flush opportunistically
//     when no rAF is pending.
//
// Module format: CommonJS (`module.exports = function()` factory), matching the
// plan's `require("mithril")` usage in src/index.js.

"use strict"

var Vnode = require("mithril/render/vnode")
var cachedAttrsIsStaticMap = require("mithril/render/cachedAttrsIsStaticMap")

// ============================================================
// 1. Small helpers
// ============================================================

function camelize(str) {
	return str.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase() })
}

function parseCssText(text) {
	var out = {}
	if (text == null) return out
	var parts = String(text).split(";")
	for (var i = 0; i < parts.length; i++) {
		var part = parts[i]
		if (part == null) continue
		var idx = part.indexOf(":")
		if (idx === -1) continue
		var key = part.slice(0, idx).trim()
		var value = part.slice(idx + 1).trim()
		if (key !== "") out[key] = value
	}
	return out
}

function isLifecycleMethod(attr) {
	return attr === "oninit" || attr === "oncreate" || attr === "onupdate" || attr === "onremove" || attr === "onbeforeremove" || attr === "onbeforeupdate"
}

// ============================================================
// 2. delayedRemoval (port of mithril/render/delayedRemoval.js)
// ============================================================

var delayedRemoval = new WeakMap()

// ============================================================
// 3. rAF polyfill + flush machinery
// ============================================================

var rafCallbacks = []
var rafPending = false
var rafIdCounter = 0
var enqueue = typeof queueMicrotask === "function" ? queueMicrotask : function (fn) { Promise.resolve().then(fn) }

function requestAnimationFrame(cb) {
	rafIdCounter++
	var id = rafIdCounter
	rafCallbacks.push({ id: id, cb: cb })
	if (!rafPending) {
		rafPending = true
		enqueue(function () {
			rafPending = false
			var callbacks = rafCallbacks
			rafCallbacks = []
			for (var i = 0; i < callbacks.length; i++) {
				try { callbacks[i].cb() } catch (e) { /* swallow */ }
			}
		})
	}
	return id
}

function cancelAnimationFrame(id) {
	for (var i = 0; i < rafCallbacks.length; i++) {
		if (rafCallbacks[i].id === id) {
			rafCallbacks.splice(i, 1)
			return
		}
	}
}

// Install the polyfill BEFORE mithril is required so that mithril's
// mount-redraw sees requestAnimationFrame at load time.
var g = typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this)
g.requestAnimationFrame = requestAnimationFrame
g.cancelAnimationFrame = cancelAnimationFrame
if (typeof g.window === "undefined") {
	try { g.window = g } catch (e) { /* ignore */ }
}

// Flush machinery. renderDepth is > 0 while the shim's own render pass is
// running, so opportunistic flushes are suppressed and batched into the
// end-of-pass flush hook instead.
var renderDepth = 0
var styleProxies = []

function flushTree() {
	for (var i = 0; i < styleProxies.length; i++) {
		try { styleProxies[i]._flush() } catch (e) { /* ignore */ }
	}
	// __FlushElementTree is a main-thread-only PAPI global. This same shim
	// module is also used on the background thread in "renderer mode"
	// (renderer/background.js), driving a VirtualNodeWrapper tree that has
	// no real PAPI to flush — that side's own op-log dispatch is its
	// equivalent of a flush. Found via real-device testing: the jsdom test
	// polyfill leaves __FlushElementTree defined globally even after
	// switching to the simulated background thread (switchToBackgroundThread
	// only overwrites keys present in ITS OWN globals snapshot, never
	// deletes leftover ones), so this gap never surfaced as a test failure.
	if (typeof __FlushElementTree === "function") __FlushElementTree()
}

function maybeFlush() {
	if (renderDepth === 0 && !rafPending) flushTree()
}

// ============================================================
// 4. LynxStyleProxy
// ============================================================

// Accepts BOTH `setProperty("font-size", v)` and `style["fontSize"] = v`.
// All keys are camelized before being sent to `__SetInlineStyles`.
function LynxStyleProxy(wrapper) {
	this._wrapper = wrapper
	this._props = {}
	styleProxies.push(this)
}

LynxStyleProxy.prototype._flush = function () {
	var styles = {}
	var keys = Object.keys(this)
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i]
		if (key === "_wrapper" || key === "_props") continue
		var value = this[key]
		if (value == null) continue
		styles[camelize(key)] = String(value)
	}
	__SetInlineStyles(this._wrapper._handle, styles)
}

LynxStyleProxy.prototype.setProperty = function (name, value) {
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

LynxStyleProxy.prototype.removeProperty = function (name) {
	var key = camelize(name)
	delete this._props[key]
	if (Object.prototype.hasOwnProperty.call(this, key)) delete this[key]
	this._flush()
}

Object.defineProperty(LynxStyleProxy.prototype, "cssText", {
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
		var parsed = parseCssText(value)
		for (var key in parsed) this.setProperty(key, parsed[key])
	}
})

// ============================================================
// 5. LynxNodeWrapper
// ============================================================

var wrapperCache = new WeakMap()

function wrapperFor(handle) {
	if (handle == null) return null
	var wrapper = wrapperCache.get(handle)
	if (wrapper == null) {
		wrapper = new LynxNodeWrapper(handle)
		wrapperCache.set(handle, wrapper)
	}
	return wrapper
}

function LynxNodeWrapper(handle) {
	this._handle = handle
	this._style = new LynxStyleProxy(this)
	this._directProps = {}
	this._listeners = Object.create(null)
	this._isRawText = false
	this._text = null
	this._document = null
	this._pageId = 0
	this._tag = null
	this.vnodes = null
}

Object.defineProperty(LynxNodeWrapper.prototype, "nodeType", {
	get: function () { return this._isRawText ? 3 : 1 }
})

Object.defineProperty(LynxNodeWrapper.prototype, "ownerDocument", {
	get: function () {
		if (this._document != null) return this._document
		var p = __GetParent(this._handle)
		if (p != null) {
			var doc = wrapperFor(p).ownerDocument
			if (doc != null) {
				this._document = doc
				return doc
			}
		}
		return getDefaultDocument()
	}
})

Object.defineProperty(LynxNodeWrapper.prototype, "namespaceURI", {
	get: function () { return undefined }
})

Object.defineProperty(LynxNodeWrapper.prototype, "parentNode", {
	get: function () {
		var p = __GetParent(this._handle)
		return p != null ? wrapperFor(p) : null
	}
})

Object.defineProperty(LynxNodeWrapper.prototype, "firstChild", {
	get: function () {
		var c = __FirstElement(this._handle)
		return c != null ? wrapperFor(c) : null
	}
})

Object.defineProperty(LynxNodeWrapper.prototype, "nextSibling", {
	get: function () {
		var n = __NextElement(this._handle)
		return n != null ? wrapperFor(n) : null
	}
})

Object.defineProperty(LynxNodeWrapper.prototype, "textContent", {
	get: function () {
		if (this._isRawText) return this._text
		var out = ""
		var child = __FirstElement(this._handle)
		while (child != null) {
			out += wrapperFor(child).textContent
			child = __NextElement(child)
		}
		return out
	},
	set: function (value) {
		if (this._isRawText) {
			this.nodeValue = value
			return
		}
		var children = __GetChildren(this._handle)
		if (children.length > 0) __ReplaceElements(this._handle, [], children)
		if (value != null && value !== "") {
			var raw = createRawTextNode(String(value))
			__AppendElement(this._handle, raw._handle)
		}
		maybeFlush()
	}
})

Object.defineProperty(LynxNodeWrapper.prototype, "nodeValue", {
	get: function () {
		return this._isRawText ? this._text : null
	},
	set: function (value) {
		if (this._isRawText) {
			this._text = String(value)
			__SetAttribute(this._handle, "text", this._text)
			maybeFlush()
		}
	}
})

Object.defineProperty(LynxNodeWrapper.prototype, "innerHTML", {
	get: function () { return this.textContent },
	set: function () {
		throw new Error("m.trust / innerHTML is not supported by the Lynx shim (v1).")
	}
})

Object.defineProperty(LynxNodeWrapper.prototype, "style", {
	get: function () { return this._style },
	set: function (value) {
		if (value == null) this._style.cssText = ""
		else if (typeof value === "string") this._style.cssText = value
	}
})

// Direct properties: these are the keys mithril's hasPropertyKey() will find
// via `key in vnode.dom`, so they must exist on the wrapper.
var DIRECT_PROPS = ["value", "checked", "selectedIndex", "className", "id", "type"]
DIRECT_PROPS.forEach(function (p) {
	Object.defineProperty(LynxNodeWrapper.prototype, p, {
		configurable: true,
		enumerable: true,
		get: function () { return this._directProps[p] },
		set: function (v) {
			this._directProps[p] = v
			this._setDirectProp(p, v)
		}
	})
})

LynxNodeWrapper.prototype._setDirectProp = function (key, value) {
	if (key === "className") {
		__SetClasses(this._handle, value == null ? undefined : String(value))
	} else if (key === "id") {
		__SetID(this._handle, value == null ? null : String(value))
	} else if (key === "checked") {
		__SetAttribute(this._handle, key, value == null ? null : value)
	} else {
		__SetAttribute(this._handle, key, value == null ? null : String(value))
	}
}

LynxNodeWrapper.prototype.setAttribute = function (key, value) {
	if (key === "class") {
		__SetClasses(this._handle, value == null ? undefined : String(value))
	} else if (key === "id") {
		__SetID(this._handle, value == null ? null : String(value))
	} else if (key.slice(0, 5) === "data-") {
		__AddDataset(this._handle, key.slice(5), value)
	} else {
		__SetAttribute(this._handle, key, value == null ? null : String(value))
	}
}

LynxNodeWrapper.prototype.removeAttribute = function (key) {
	if (key === "class") {
		__SetClasses(this._handle, undefined)
	} else if (key === "id") {
		__SetID(this._handle, null)
	} else if (key.slice(0, 5) === "data-") {
		__AddDataset(this._handle, key.slice(5), null)
	} else {
		__SetAttribute(this._handle, key, null)
	}
}

LynxNodeWrapper.prototype.setAttributeNS = function (ns, key, value) {
	this.setAttribute(key, value)
}

LynxNodeWrapper.prototype.appendChild = function (child) {
	if (child == null) return child
	if (child.nodeType === 11) return child // inert fragment: children already placed by the engine
	__AppendElement(this._handle, child._handle)
	maybeFlush()
	return child
}

LynxNodeWrapper.prototype.insertBefore = function (child, ref) {
	if (child == null) return child
	if (child.nodeType === 11) return child
	if (ref == null) {
		__AppendElement(this._handle, child._handle)
	} else {
		__InsertElementBefore(this._handle, child._handle, ref._handle)
	}
	maybeFlush()
	return child
}

LynxNodeWrapper.prototype.removeChild = function (child) {
	if (child == null) return child
	if (child.nodeType === 11) return child
	__RemoveElement(this._handle, child._handle)
	maybeFlush()
	return child
}

LynxNodeWrapper.prototype.contains = function (other) {
	if (other == null) return false
	if (other === this) return true
	if (other._handle == null) return false
	var p = __GetParent(other._handle)
	while (p != null) {
		if (p === this._handle) return true
		p = __GetParent(p)
	}
	return false
}

LynxNodeWrapper.prototype.focus = function () {}

// Events: per-type registry of {listener, wrapped}. The wrapped handler is the
// real JS function passed to __AddEventListener; it normalizes the Lynx event
// and dispatches to the mithril EventDict (or a plain function).
LynxNodeWrapper.prototype.addEventListener = function (type, listener, opts) {
	var entry = this._listeners[type]
	if (entry != null && entry.listener === listener) return
	if (entry != null) {
		__RemoveEventListener(this._handle, type, entry.wrapped, entry.opts || {})
	}
	var self = this
	var wrapped = function (rawEv) {
		var ev = normalizeEvent(rawEv, self)
		if (typeof listener === "function") listener.call(ev.currentTarget, ev)
		else if (listener != null && typeof listener.handleEvent === "function") listener.handleEvent(ev)
	}
	this._listeners[type] = { listener: listener, wrapped: wrapped, opts: opts || {} }
	__AddEventListener(this._handle, type, wrapped, opts || {})
}

LynxNodeWrapper.prototype.removeEventListener = function (type, listener, opts) {
	var entry = this._listeners[type]
	if (entry == null) return
	if (listener != null && entry.listener !== listener) return
	delete this._listeners[type]
	__RemoveEventListener(this._handle, type, entry.wrapped, entry.opts || {})
}

// Normalize a Lynx event into a DOM-like event object. `redraw: false` disables
// mithril's automatic redraw-on-event; the demo must call shim.redraw() (or
// m.redraw()) explicitly.
function normalizeEvent(rawEv, node) {
	var ev = {
		type: rawEv != null && rawEv.type != null ? rawEv.type : "tap",
		currentTarget: node,
		redraw: false,
		preventDefault: function () {},
		stopPropagation: function () {}
	}
	if (rawEv != null) {
		for (var k in rawEv) {
			if (ev[k] === undefined) ev[k] = rawEv[k]
		}
	}
	return ev
}

// ============================================================
// 6. fakeDocument + fragment
// ============================================================

var defaultDocument = null

function getDefaultDocument() {
	if (defaultDocument == null) defaultDocument = createFakeDocument(0)
	return defaultDocument
}

function createRawTextNode(value) {
	var handle = __CreateRawText(String(value))
	var wrapper = wrapperFor(handle)
	wrapper._isRawText = true
	wrapper._text = String(value)
	return wrapper
}

function createElementWrapper(tag, pageId) {
	var handle
	if (tag === "view") handle = __CreateView(pageId)
	else if (tag === "text") handle = __CreateText(pageId)
	else handle = __CreateElement(tag, pageId, {})
	var wrapper = wrapperFor(handle)
	wrapper._tag = tag
	return wrapper
}

function createFakeDocument(pageId) {
	var document = {
		_pageId: pageId,
		createElement: function (tag, opts) {
			var wrapper = createElementWrapper(tag, pageId)
			wrapper._document = document
			return wrapper
		},
		createElementNS: function (ns, tag, opts) {
			return document.createElement(tag, opts)
		},
		createTextNode: function (value) {
			var wrapper = createRawTextNode(value)
			wrapper._document = document
			return wrapper
		},
		createDocumentFragment: function () {
			return createFragment(document)
		}
	}
	Object.defineProperty(document, "activeElement", {
		get: function () { return null }
	})
	return document
}

// Inert fragment: never __AppendElement'd. Children are created directly in the
// real parent by the engine (see createFragment below).
function createFragment(document) {
	return {
		nodeType: 11,
		ownerDocument: document,
		_parent: null,
		appendChild: function () {},
		insertBefore: function () {},
		removeChild: function () {}
	}
}

function getPreviousSibling(parentHandle, nodeHandle) {
	var child = __FirstElement(parentHandle)
	while (child != null) {
		var next = __NextElement(child)
		if (next === nodeHandle) return child
		child = next
	}
	return null
}

function getLastChild(parentHandle) {
	var child = __FirstElement(parentHandle)
	var last = null
	while (child != null) {
		last = child
		child = __NextElement(child)
	}
	return last
}

// ============================================================
// 7. Render engine (port of mithril/render/render.js@2.3.8)
// ============================================================

function factory() {
	var nameSpace = {
		svg: "http://www.w3.org/2000/svg",
		math: "http://www.w3.org/1998/Math/MathML"
	}

	var currentRedraw
	var currentRender
	var currentDOM

	function getDocument(dom) {
		return dom.ownerDocument
	}

	function getNameSpace(vnode) {
		return vnode.attrs && vnode.attrs.xmlns || nameSpace[vnode.tag]
	}

	//sanity check to discourage people from doing `vnode.state = ...`
	function checkState(vnode, original) {
		if (vnode.state !== original) throw new Error("'vnode.state' must not be modified.")
	}

	//Note: the hook is passed as the `this` argument to allow proxying the
	//arguments without requiring a full array allocation to do so. It also
	//takes advantage of the fact the current `vnode` is the first argument in
	//all lifecycle methods.
	function callHook(vnode) {
		var original = vnode.state
		try {
			return this.apply(original, arguments)
		} finally {
			checkState(vnode, original)
		}
	}

	function activeElement(dom) {
		try {
			return getDocument(dom).activeElement
		} catch (e) {
			return null
		}
	}

	//create
	function createNodes(parent, vnodes, start, end, hooks, nextSibling, ns) {
		for (var i = start; i < end; i++) {
			var vnode = vnodes[i]
			if (vnode != null) {
				createNode(parent, vnode, hooks, ns, nextSibling)
			}
		}
	}

	function createNode(parent, vnode, hooks, ns, nextSibling) {
		var tag = vnode.tag
		if (typeof tag === "string") {
			vnode.state = {}
			if (vnode.attrs != null) initLifecycle(vnode.attrs, vnode, hooks)
			switch (tag) {
				case "#": createText(parent, vnode, nextSibling); break
				case "<": createHTML(parent, vnode, ns, nextSibling); break
				case "[": createFragment(parent, vnode, hooks, ns, nextSibling); break
				default: createElement(parent, vnode, hooks, ns, nextSibling)
			}
		}
		else createComponent(parent, vnode, hooks, ns, nextSibling)
	}

	function createText(parent, vnode, nextSibling) {
		vnode.dom = getDocument(parent).createTextNode(vnode.children)
		insertDOM(parent, vnode.dom, nextSibling)
	}

	function createHTML(parent, vnode, ns, nextSibling) {
		throw new Error("m.trust / innerHTML is not supported by the Lynx shim (v1).")
	}

	function createFragment(parent, vnode, hooks, ns, nextSibling) {
		// Inert fragment: children are created directly in the real parent.
		// The fragment itself is never __AppendElement'd.
		if (vnode.children != null) {
			var children = vnode.children
			var before = nextSibling != null
				? getPreviousSibling(parent._handle, nextSibling._handle)
				: getLastChild(parent._handle)
			createNodes(parent, children, 0, children.length, hooks, nextSibling, ns)
			var firstHandle = before != null ? __NextElement(before) : __FirstElement(parent._handle)
			vnode.dom = firstHandle != null ? wrapperFor(firstHandle) : null
			vnode.domSize = children.length
		} else {
			vnode.dom = null
			vnode.domSize = 0
		}
	}

	function createElement(parent, vnode, hooks, ns, nextSibling) {
		var tag = vnode.tag
		var attrs = vnode.attrs
		var is = vnode.is

		ns = getNameSpace(vnode) || ns

		var element = ns ?
			is ? getDocument(parent).createElementNS(ns, tag, {is: is}) : getDocument(parent).createElementNS(ns, tag) :
			is ? getDocument(parent).createElement(tag, {is: is}) : getDocument(parent).createElement(tag)
		vnode.dom = element

		if (attrs != null) {
			setAttrs(vnode, attrs, ns)
		}

		insertDOM(parent, element, nextSibling)

		if (!maybeSetContentEditable(vnode)) {
			if (vnode.children != null) {
				var children = vnode.children
				createNodes(element, children, 0, children.length, hooks, null, ns)
				if (vnode.tag === "select" && attrs != null) setLateSelectAttrs(vnode, attrs)
			}
		}
	}

	function initComponent(vnode, hooks) {
		var sentinel
		if (typeof vnode.tag.view === "function") {
			vnode.state = Object.create(vnode.tag)
			sentinel = vnode.state.view
			if (sentinel.$$reentrantLock$$ != null) return
			sentinel.$$reentrantLock$$ = true
		} else {
			vnode.state = void 0
			sentinel = vnode.tag
			if (sentinel.$$reentrantLock$$ != null) return
			sentinel.$$reentrantLock$$ = true
			vnode.state = (vnode.tag.prototype != null && typeof vnode.tag.prototype.view === "function") ? new vnode.tag(vnode) : vnode.tag(vnode)
		}
		initLifecycle(vnode.state, vnode, hooks)
		if (vnode.attrs != null) initLifecycle(vnode.attrs, vnode, hooks)
		vnode.instance = Vnode.normalize(callHook.call(vnode.state.view, vnode))
		if (vnode.instance === vnode) throw Error("A view cannot return the vnode it received as argument")
		sentinel.$$reentrantLock$$ = null
	}

	function createComponent(parent, vnode, hooks, ns, nextSibling) {
		initComponent(vnode, hooks)
		if (vnode.instance != null) {
			createNode(parent, vnode.instance, hooks, ns, nextSibling)
			vnode.dom = vnode.instance.dom
			vnode.domSize = vnode.instance.domSize
		}
		else {
			vnode.domSize = 0
		}
	}

	//update
	function updateNodes(parent, old, vnodes, hooks, nextSibling, ns) {
		var o, v
		if (old === vnodes || old == null && vnodes == null) return
		else if (old == null || old.length === 0) createNodes(parent, vnodes, 0, vnodes.length, hooks, nextSibling, ns)
		else if (vnodes == null || vnodes.length === 0) removeNodes(parent, old, 0, old.length)
		else {
			var isOldKeyed = old[0] != null && old[0].key != null
			var isKeyed = vnodes[0] != null && vnodes[0].key != null
			var start = 0, oldStart = 0
			if (!isOldKeyed) while (oldStart < old.length && old[oldStart] == null) oldStart++
			if (!isKeyed) while (start < vnodes.length && vnodes[start] == null) start++
			if (isOldKeyed !== isKeyed) {
				removeNodes(parent, old, oldStart, old.length)
				createNodes(parent, vnodes, start, vnodes.length, hooks, nextSibling, ns)
			} else if (!isKeyed) {
				// Don't index past the end of either list (causes deopts).
				var commonLength = old.length < vnodes.length ? old.length : vnodes.length
				// Rewind if necessary to the first non-null index on either side.
				start = start < oldStart ? start : oldStart
				for (; start < commonLength; start++) {
					o = old[start]
					v = vnodes[start]
					if (o === v || o == null && v == null) continue
					else if (o == null) createNode(parent, v, hooks, ns, getNextSibling(old, start + 1, nextSibling))
					else if (v == null) removeNode(parent, o)
					else updateNode(parent, o, v, hooks, getNextSibling(old, start + 1, nextSibling), ns)
				}
				if (old.length > commonLength) removeNodes(parent, old, start, old.length)
				if (vnodes.length > commonLength) createNodes(parent, vnodes, start, vnodes.length, hooks, nextSibling, ns)
			} else {
				// keyed diff
				var oldEnd = old.length - 1, end = vnodes.length - 1, map, oe, ve, topSibling

				// bottom-up
				while (oldEnd >= oldStart && end >= start) {
					oe = old[oldEnd]
					ve = vnodes[end]
					if (oe.key !== ve.key) break
					if (oe !== ve) updateNode(parent, oe, ve, hooks, nextSibling, ns)
					if (ve.dom != null) nextSibling = ve.dom
					oldEnd--, end--
				}
				// top-down
				while (oldEnd >= oldStart && end >= start) {
					o = old[oldStart]
					v = vnodes[start]
					if (o.key !== v.key) break
					oldStart++, start++
					if (o !== v) updateNode(parent, o, v, hooks, getNextSibling(old, oldStart, nextSibling), ns)
				}
				// swaps and list reversals
				while (oldEnd >= oldStart && end >= start) {
					if (start === end) break
					if (o.key !== ve.key || oe.key !== v.key) break
					topSibling = getNextSibling(old, oldStart, nextSibling)
					moveDOM(parent, oe, topSibling)
					if (oe !== v) updateNode(parent, oe, v, hooks, topSibling, ns)
					if (++start <= --end) moveDOM(parent, o, nextSibling)
					if (o !== ve) updateNode(parent, o, ve, hooks, nextSibling, ns)
					if (ve.dom != null) nextSibling = ve.dom
					oldStart++; oldEnd--
					oe = old[oldEnd]
					ve = vnodes[end]
					o = old[oldStart]
					v = vnodes[start]
				}
				// bottom up once again
				while (oldEnd >= oldStart && end >= start) {
					if (oe.key !== ve.key) break
					if (oe !== ve) updateNode(parent, oe, ve, hooks, nextSibling, ns)
					if (ve.dom != null) nextSibling = ve.dom
					oldEnd--, end--
					oe = old[oldEnd]
					ve = vnodes[end]
				}
				if (start > end) removeNodes(parent, old, oldStart, oldEnd + 1)
				else if (oldStart > oldEnd) createNodes(parent, vnodes, start, end + 1, hooks, nextSibling, ns)
				else {
					// inspired by ivi https://github.com/ivijs/ivi/ by Boris Kaul
					var originalNextSibling = nextSibling, vnodesLength = end - start + 1, oldIndices = new Array(vnodesLength), li = 0, i = 0, pos = 2147483647, matched = 0, lisIndices
					for (i = 0; i < vnodesLength; i++) oldIndices[i] = -1
					for (i = end; i >= start; i--) {
						if (map == null) map = getKeyMap(old, oldStart, oldEnd + 1)
						ve = vnodes[i]
						var oldIndex = map[ve.key]
						if (oldIndex != null) {
							pos = (oldIndex < pos) ? oldIndex : -1 // becomes -1 if nodes were re-ordered
							oldIndices[i - start] = oldIndex
							oe = old[oldIndex]
							old[oldIndex] = null
							if (oe !== ve) updateNode(parent, oe, ve, hooks, nextSibling, ns)
							if (ve.dom != null) nextSibling = ve.dom
							matched++
						}
					}
					nextSibling = originalNextSibling
					if (matched !== oldEnd - oldStart + 1) removeNodes(parent, old, oldStart, oldEnd + 1)
					if (matched === 0) createNodes(parent, vnodes, start, end + 1, hooks, nextSibling, ns)
					else {
						if (pos === -1) {
							// the indices of the indices of the items that are part of the
							// longest increasing subsequence in the oldIndices list
							lisIndices = makeLisIndices(oldIndices)
							li = lisIndices.length - 1
							for (i = end; i >= start; i--) {
								v = vnodes[i]
								if (oldIndices[i - start] === -1) createNode(parent, v, hooks, ns, nextSibling)
								else {
									if (lisIndices[li] === i - start) li--
									else moveDOM(parent, v, nextSibling)
								}
								if (v.dom != null) nextSibling = vnodes[i].dom
							}
						} else {
							for (i = end; i >= start; i--) {
								v = vnodes[i]
								if (oldIndices[i - start] === -1) createNode(parent, v, hooks, ns, nextSibling)
								if (v.dom != null) nextSibling = vnodes[i].dom
							}
						}
					}
				}
			}
		}
	}

	function updateNode(parent, old, vnode, hooks, nextSibling, ns) {
		var oldTag = old.tag, tag = vnode.tag
		if (oldTag === tag && old.is === vnode.is) {
			vnode.state = old.state
			vnode.events = old.events
			if (shouldNotUpdate(vnode, old)) return
			if (typeof oldTag === "string") {
				if (vnode.attrs != null) {
					updateLifecycle(vnode.attrs, vnode, hooks)
				}
				switch (oldTag) {
					case "#": updateText(old, vnode); break
					case "<": updateHTML(parent, old, vnode, ns, nextSibling); break
					case "[": updateFragment(parent, old, vnode, hooks, nextSibling, ns); break
					default: updateElement(old, vnode, hooks, ns)
				}
			}
			else updateComponent(parent, old, vnode, hooks, nextSibling, ns)
		}
		else {
			removeNode(parent, old)
			createNode(parent, vnode, hooks, ns, nextSibling)
		}
	}

	function updateText(old, vnode) {
		if (old.children.toString() !== vnode.children.toString()) {
			old.dom.nodeValue = vnode.children
		}
		vnode.dom = old.dom
	}

	function updateHTML(parent, old, vnode, ns, nextSibling) {
		if (old.children !== vnode.children) {
			removeDOM(parent, old)
			createHTML(parent, vnode, ns, nextSibling)
		}
		else {
			vnode.dom = old.dom
			vnode.domSize = old.domSize
		}
	}

	function updateFragment(parent, old, vnode, hooks, nextSibling, ns) {
		updateNodes(parent, old.children, vnode.children, hooks, nextSibling, ns)
		var domSize = 0, children = vnode.children
		vnode.dom = null
		if (children != null) {
			for (var i = 0; i < children.length; i++) {
				var child = children[i]
				if (child != null && child.dom != null) {
					if (vnode.dom == null) vnode.dom = child.dom
					domSize += child.domSize || 1
				}
			}
		}
		vnode.domSize = domSize
	}

	function updateElement(old, vnode, hooks, ns) {
		var element = vnode.dom = old.dom
		ns = getNameSpace(vnode) || ns

		if (old.attrs != vnode.attrs || (vnode.attrs != null && !cachedAttrsIsStaticMap.get(vnode.attrs))) {
			updateAttrs(vnode, old.attrs, vnode.attrs, ns)
		}
		if (!maybeSetContentEditable(vnode)) {
			updateNodes(element, old.children, vnode.children, hooks, null, ns)
		}
	}

	function updateComponent(parent, old, vnode, hooks, nextSibling, ns) {
		vnode.instance = Vnode.normalize(callHook.call(vnode.state.view, vnode))
		if (vnode.instance === vnode) throw Error("A view cannot return the vnode it received as argument")
		updateLifecycle(vnode.state, vnode, hooks)
		if (vnode.attrs != null) updateLifecycle(vnode.attrs, vnode, hooks)
		if (vnode.instance != null) {
			if (old.instance == null) createNode(parent, vnode.instance, hooks, ns, nextSibling)
			else updateNode(parent, old.instance, vnode.instance, hooks, nextSibling, ns)
			vnode.dom = vnode.instance.dom
			vnode.domSize = vnode.instance.domSize
		}
		else {
			if (old.instance != null) removeNode(parent, old.instance)
			vnode.domSize = 0
		}
	}

	function getKeyMap(vnodes, start, end) {
		var map = Object.create(null)
		for (; start < end; start++) {
			var vnode = vnodes[start]
			if (vnode != null) {
				var key = vnode.key
				if (key != null) map[key] = start
			}
		}
		return map
	}

	// Lifted from ivi https://github.com/ivijs/ivi/
	// takes a list of unique numbers (-1 is special and can
	// occur multiple times) and returns an array with the indices
	// of the items that are part of the longest increasing
	// subsequence
	var lisTemp = []
	function makeLisIndices(a) {
		var result = [0]
		var u = 0, v = 0, i = 0
		var il = lisTemp.length = a.length
		for (var i = 0; i < il; i++) lisTemp[i] = a[i]
		for (var i = 0; i < il; ++i) {
			if (a[i] === -1) continue
			var j = result[result.length - 1]
			if (a[j] < a[i]) {
				lisTemp[i] = j
				result.push(i)
				continue
			}
			u = 0
			v = result.length - 1
			while (u < v) {
				// Fast integer average without overflow.
				// eslint-disable-next-line no-bitwise
				var c = (u >>> 1) + (v >>> 1) + (u & v & 1)
				if (a[result[c]] < a[i]) {
					u = c + 1
				}
				else {
					v = c
				}
			}
			if (a[i] < a[result[u]]) {
				if (u > 0) lisTemp[i] = result[u - 1]
				result[u] = i
			}
		}
		u = result.length
		v = result[u - 1]
		while (u-- > 0) {
			result[u] = v
			v = lisTemp[v]
		}
		lisTemp.length = 0
		return result
	}

	function getNextSibling(vnodes, i, nextSibling) {
		for (; i < vnodes.length; i++) {
			if (vnodes[i] != null && vnodes[i].dom != null) return vnodes[i].dom
		}
		return nextSibling
	}

	// This handles fragments with zombie children (removed from vdom, but persisted in DOM through onbeforeremove)
	function moveDOM(parent, vnode, nextSibling) {
		if (vnode.dom != null) {
			if (vnode.domSize == null || vnode.domSize === 1) {
				// don't allocate for the common case
				insertDOM(parent, vnode.dom, nextSibling)
			} else {
				var doms = domFor(vnode)
				for (var i = 0; i < doms.length; i++) insertDOM(parent, doms[i], nextSibling)
			}
			maybeFlush()
		}
	}

	function insertDOM(parent, dom, nextSibling) {
		if (nextSibling != null) parent.insertBefore(dom, nextSibling)
		else parent.appendChild(dom)
	}

	function maybeSetContentEditable(vnode) {
		if (vnode.attrs == null || (
			vnode.attrs.contenteditable == null && // attribute
			vnode.attrs.contentEditable == null // property
		)) return false
		var children = vnode.children
		if (children != null && children.length === 1 && children[0].tag === "<") {
			var content = children[0].children
			if (vnode.dom.innerHTML !== content) vnode.dom.innerHTML = content
		}
		else if (children != null && children.length !== 0) throw new Error("Child node of a contenteditable must be trusted.")
		return true
	}

	//remove
	function removeNodes(parent, vnodes, start, end) {
		for (var i = start; i < end; i++) {
			var vnode = vnodes[i]
			if (vnode != null) removeNode(parent, vnode)
		}
	}

	function tryBlockRemove(parent, vnode, source, counter) {
		var original = vnode.state
		var result = callHook.call(source.onbeforeremove, vnode)
		if (result == null) return

		var generation = currentRender
		var doms = domFor(vnode)
		for (var i = 0; i < doms.length; i++) delayedRemoval.set(doms[i], generation)
		counter.v++

		Promise.resolve(result).finally(function () {
			checkState(vnode, original)
			tryResumeRemove(parent, vnode, counter)
		})
	}

	function tryResumeRemove(parent, vnode, counter) {
		if (--counter.v === 0) {
			onremove(vnode)
			removeDOM(parent, vnode)
		}
	}

	function removeNode(parent, vnode) {
		var counter = {v: 1}
		if (typeof vnode.tag !== "string" && typeof vnode.state.onbeforeremove === "function") tryBlockRemove(parent, vnode, vnode.state, counter)
		if (vnode.attrs && typeof vnode.attrs.onbeforeremove === "function") tryBlockRemove(parent, vnode, vnode.attrs, counter)
		tryResumeRemove(parent, vnode, counter)
	}

	function removeDOM(parent, vnode) {
		if (vnode.dom == null) return
		if (vnode.domSize == null || vnode.domSize === 1) {
			parent.removeChild(vnode.dom)
		} else {
			var doms = domFor(vnode)
			for (var i = 0; i < doms.length; i++) parent.removeChild(doms[i])
		}
	}

	function domFor(vnode) {
		var doms = []
		var dom = vnode.dom
		var domSize = vnode.domSize
		var generation = delayedRemoval.get(dom)
		if (dom != null) {
			do {
				var nextSibling = dom.nextSibling
				if (delayedRemoval.get(dom) === generation) {
					doms.push(dom)
					domSize--
				}
				dom = nextSibling
			} while (domSize)
		}
		return doms
	}

	function onremove(vnode) {
		if (typeof vnode.tag !== "string" && typeof vnode.state.onremove === "function") callHook.call(vnode.state.onremove, vnode)
		if (vnode.attrs && typeof vnode.attrs.onremove === "function") callHook.call(vnode.attrs.onremove, vnode)
		if (typeof vnode.tag !== "string") {
			if (vnode.instance != null) onremove(vnode.instance)
		} else {
			if (vnode.events != null) vnode.events._ = null
			var children = vnode.children
			if (Array.isArray(children)) {
				for (var i = 0; i < children.length; i++) {
					var child = children[i]
					if (child != null) onremove(child)
				}
			}
		}
	}

	//attrs
	function setAttrs(vnode, attrs, ns) {
		for (var key in attrs) {
			setAttr(vnode, key, null, attrs[key], ns)
		}
	}

	function setAttr(vnode, key, old, value, ns) {
		if (key === "key" || value == null || isLifecycleMethod(key) || (old === value && !isFormAttribute(vnode, key)) && typeof value !== "object") return
		if (key[0] === "o" && key[1] === "n") return updateEvent(vnode, key, value)
		if (key.slice(0, 6) === "xlink:") vnode.dom.setAttributeNS("http://www.w3.org/1999/xlink", key.slice(6), value)
		else if (key === "style") updateStyle(vnode.dom, old, value)
		else if (hasPropertyKey(vnode, key, ns)) {
			if (key === "value") {
				// Only do the coercion if we're actually going to check the value.
				/* eslint-disable no-implicit-coercion */
				//setting input[value] to same value by typing on focused element moves cursor to end in Chrome
				//setting input[type=file][value] to same value causes an error to be generated if it's non-empty
				//minlength/maxlength validation isn't performed on script-set values(#2256)
				if ((vnode.tag === "input" || vnode.tag === "textarea") && vnode.dom.value === "" + value) return
				//setting select[value] to same value while having select open blinks select dropdown in Chrome
				if (vnode.tag === "select" && old !== null && vnode.dom.value === "" + value) return
				//setting option[value] to same value while having select open blinks select dropdown in Chrome
				if (vnode.tag === "option" && old !== null && vnode.dom.value === "" + value) return
				//setting input[type=file][value] to different value is an error if it's non-empty
				// Not ideal, but it at least works around the most common source of uncaught exceptions for now.
				if (vnode.tag === "input" && vnode.attrs.type === "file" && "" + value !== "") { console.error("`value` is read-only on file inputs!"); return }
				/* eslint-enable no-implicit-coercion */
			}
			// If you assign an input type that is not supported by IE 11 with an assignment expression, an error will occur.
			if (vnode.tag === "input" && key === "type") vnode.dom.setAttribute(key, value)
			else vnode.dom[key] = value
		} else {
			if (typeof value === "boolean") {
				if (value) vnode.dom.setAttribute(key, "")
				else vnode.dom.removeAttribute(key)
			}
			else vnode.dom.setAttribute(key === "className" ? "class" : key, value)
		}
	}

	function removeAttr(vnode, key, old, ns) {
		if (key === "key" || old == null || isLifecycleMethod(key)) return
		if (key[0] === "o" && key[1] === "n") updateEvent(vnode, key, undefined)
		else if (key === "style") updateStyle(vnode.dom, old, null)
		else if (
			hasPropertyKey(vnode, key, ns)
			&& key !== "className"
			&& key !== "title" // creates "null" as title
			&& !(key === "value" && (
				vnode.tag === "option"
				|| vnode.tag === "select" && vnode.dom.selectedIndex === -1 && vnode.dom === activeElement(vnode.dom)
			))
			&& !(vnode.tag === "input" && key === "type")
		) {
			vnode.dom[key] = null
		} else {
			var nsLastIndex = key.indexOf(":")
			if (nsLastIndex !== -1) key = key.slice(nsLastIndex + 1)
			if (old !== false) vnode.dom.removeAttribute(key === "className" ? "class" : key)
		}
	}

	function setLateSelectAttrs(vnode, attrs) {
		if ("value" in attrs) {
			if (attrs.value === null) {
				if (vnode.dom.selectedIndex !== -1) vnode.dom.value = null
			} else {
				var normalized = "" + attrs.value // eslint-disable-line no-implicit-coercion
				if (vnode.dom.value !== normalized || vnode.dom.selectedIndex === -1) {
					vnode.dom.value = normalized
				}
			}
		}
		if ("selectedIndex" in attrs) setAttr(vnode, "selectedIndex", null, attrs.selectedIndex, undefined)
	}

	function updateAttrs(vnode, old, attrs, ns) {
		// Some attributes may NOT be case-sensitive (e.g. data-***),
		// so removal should be done first to prevent accidental removal for newly setting values.
		var val
		if (old != null) {
			if (old === attrs && !cachedAttrsIsStaticMap.has(attrs)) {
				console.warn("Don't reuse attrs object, use new object for every redraw, this will throw in next major")
			}
			for (var key in old) {
				if (((val = old[key]) != null) && (attrs == null || attrs[key] == null)) {
					removeAttr(vnode, key, val, ns)
				}
			}
		}
		if (attrs != null) {
			for (var key in attrs) {
				setAttr(vnode, key, old && old[key], attrs[key], ns)
			}
		}
	}

	function isFormAttribute(vnode, attr) {
		return attr === "value" || attr === "checked" || attr === "selectedIndex" || attr === "selected" && (vnode.dom === activeElement(vnode.dom) || vnode.tag === "option" && vnode.dom.parentNode === activeElement(vnode.dom))
	}

	function hasPropertyKey(vnode, key, ns) {
		// Filter out namespaced keys
		return ns === undefined && (
			// If it's a custom element, just keep it.
			vnode.tag.indexOf("-") > -1 || vnode.is ||
			// If it's a normal element, let's try to avoid a few browser bugs.
			key !== "href" && key !== "list" && key !== "form" && key !== "width" && key !== "height"// && key !== "type"
			// Defer the property check until *after* we check everything.
		) && key in vnode.dom
	}

	//style
	function updateStyle(element, old, style) {
		if (old === style) {
			// Styles are equivalent, do nothing.
		} else if (style == null) {
			// New style is missing, just clear it.
			element.style = ""
		} else if (typeof style !== "object") {
			// New style is a string, let engine deal with patching.
			element.style = style
		} else if (old == null || typeof old !== "object") {
			// `old` is missing or a string, `style` is an object.
			element.style = ""
			// Add new style properties
			for (var key in style) {
				var value = style[key]
				if (value != null) {
					if (key.includes("-")) element.style.setProperty(key, String(value))
					else element.style[key] = String(value)
				}
			}
		} else {
			// Both old & new are (different) objects.
			// Remove style properties that no longer exist
			// Style properties may have two cases(dash-case and camelCase),
			// so removal should be done first to prevent accidental removal for newly setting values.
			for (var key in old) {
				if (old[key] != null && style[key] == null) {
					if (key.includes("-")) element.style.removeProperty(key)
					else element.style[key] = ""
				}
			}
			// Update style properties that have changed
			for (var key in style) {
				var value = style[key]
				if (value != null && (value = String(value)) !== String(old[key])) {
					if (key.includes("-")) element.style.setProperty(key, value)
					else element.style[key] = value
				}
			}
		}
	}

	// Here's an explanation of how this works:
	// 1. The event names are always (by design) prefixed by `on`.
	// 2. The EventListener interface accepts either a function or an object
	//    with a `handleEvent` method.
	// 3. The object does not inherit from `Object.prototype`, to avoid
	//    any potential interference with that (e.g. setters).
	// 4. The event name is remapped to the handler before calling it.
	// 5. In function-based event handlers, `ev.target === this`. We replicate
	//    that below.
	// 6. In function-based event handlers, `return false` prevents the default
	//    action and stops event propagation. We replicate that below.
	function EventDict() {
		// Save this, so the current redraw is correctly tracked.
		this._ = currentRedraw
	}
	EventDict.prototype = Object.create(null)
	EventDict.prototype.handleEvent = function (ev) {
		var handler = this["on" + ev.type]
		var result
		if (typeof handler === "function") result = handler.call(ev.currentTarget, ev)
		else if (typeof handler.handleEvent === "function") handler.handleEvent(ev)
		var self = this
		if (self._ != null) {
			if (ev.redraw !== false) (0, self._)()
			if (result != null && typeof result.then === "function") {
				Promise.resolve(result).then(function () {
					if (self._ != null && ev.redraw !== false) (0, self._)()
				})
			}
		}
		if (result === false) {
			ev.preventDefault()
			ev.stopPropagation()
		}
	}

	//event
	function updateEvent(vnode, key, value) {
		if (vnode.events != null) {
			vnode.events._ = currentRedraw
			if (vnode.events[key] === value) return
			if (value != null && (typeof value === "function" || typeof value === "object")) {
				if (vnode.events[key] == null) vnode.dom.addEventListener(key.slice(2), vnode.events, false)
				vnode.events[key] = value
			} else {
				if (vnode.events[key] != null) vnode.dom.removeEventListener(key.slice(2), vnode.events, false)
				vnode.events[key] = undefined
			}
		} else if (value != null && (typeof value === "function" || typeof value === "object")) {
			vnode.events = new EventDict()
			vnode.dom.addEventListener(key.slice(2), vnode.events, false)
			vnode.events[key] = value
		}
	}

	//lifecycle
	function initLifecycle(source, vnode, hooks) {
		if (typeof source.oninit === "function") callHook.call(source.oninit, vnode)
		if (typeof source.oncreate === "function") hooks.push(callHook.bind(source.oncreate, vnode))
	}

	function updateLifecycle(source, vnode, hooks) {
		if (typeof source.onupdate === "function") hooks.push(callHook.bind(source.onupdate, vnode))
	}

	function shouldNotUpdate(vnode, old) {
		do {
			if (vnode.attrs != null && typeof vnode.attrs.onbeforeupdate === "function") {
				var force = callHook.call(vnode.attrs.onbeforeupdate, vnode, old)
				if (force !== undefined && !force) break
			}
			if (typeof vnode.tag !== "string" && typeof vnode.state.onbeforeupdate === "function") {
				var force = callHook.call(vnode.state.onbeforeupdate, vnode, old)
				if (force !== undefined && !force) break
			}
			return false
		} while (false); // eslint-disable-line no-constant-condition
		vnode.dom = old.dom
		vnode.domSize = old.domSize
		vnode.instance = old.instance
		vnode.attrs = old.attrs
		vnode.children = old.children
		vnode.text = old.text
		return true
	}

	return function (dom, vnodes, redraw) {
		if (!dom) throw new TypeError("DOM element being rendered to does not exist.")
		if (currentDOM != null && dom.contains(currentDOM)) {
			throw new TypeError("Node is currently being rendered to and thus is locked.")
		}
		var prevRedraw = currentRedraw
		var prevDOM = currentDOM
		var hooks = []
		var active = activeElement(dom)
		var namespace = dom.namespaceURI

		currentDOM = dom
		currentRedraw = typeof redraw === "function" ? redraw : undefined
		currentRender = {}
		renderDepth++
		try {
			// First time rendering into a node clears it out
			if (dom.vnodes == null) dom.textContent = ""
			vnodes = Vnode.normalizeChildren(Array.isArray(vnodes) ? vnodes : [vnodes])
			updateNodes(dom, dom.vnodes, vnodes, hooks, null, namespace === "http://www.w3.org/1999/xhtml" ? undefined : namespace)
			dom.vnodes = vnodes
			// `document.activeElement` can return null: https://html.spec.whatwg.org/multipage/interaction.html#dom-document-activeelement
			if (active != null && activeElement(dom) !== active && typeof active.focus === "function") active.focus()
			for (var i = 0; i < hooks.length; i++) hooks[i]()
		} finally {
			renderDepth--
			currentRedraw = prevRedraw
			currentDOM = prevDOM
		}
		// Flush hook: after each mithril redraw pass, push the tree to Lynx.
		flushTree()
	}
}

// ============================================================
// 8. Convenience API
// ============================================================

var mithrilRender = factory()
var rootWrapper = null
var rootComponent = null
var currentVnode = null
var runRender = null
var redraw = null

function flush() {
	if (runRender != null && rootWrapper != null) {
		if (rootComponent != null) currentVnode = Vnode(rootComponent)
		runRender(rootWrapper, currentVnode, redraw)
	} else {
		flushTree()
	}
}

// Initial render. Re-render ONLY via mithril's own render/redraw
// (shim.redraw() / m.redraw()), never by calling this again manually.
function render(rootWrapperArg, vnode) {
	rootWrapper = rootWrapperArg
	rootComponent = vnode != null && typeof vnode.tag !== "string" ? vnode.tag : null
	currentVnode = vnode
	redraw = function () { flush() }
	// runRender must hold the render FUNCTION itself (mithrilRender), not the
	// result of calling it (which is undefined) — flush() re-invokes it on redraw.
	runRender = mithrilRender
	runRender(rootWrapper, currentVnode, redraw)
}

function redrawNow() {
	if (redraw != null) redraw()
}

function createPageWrapper(pageElement) {
	var pageId = __GetElementUniqueID(pageElement)
	var document = createFakeDocument(pageId)
	var wrapper = wrapperFor(pageElement)
	wrapper._document = document
	wrapper._pageId = pageId
	wrapper._tag = "page"
	return wrapper
}

function renderToPage(pageElement, vnode) {
	var wrapper = createPageWrapper(pageElement)
	render(wrapper, vnode)
	return wrapper
}

// Legacy compatibility with the old shim's API surface.
function createLynxWindow(pageElement) {
	var wrapper = pageElement != null ? createPageWrapper(pageElement) : null
	return {
		document: wrapper != null ? wrapper.ownerDocument : getDefaultDocument(),
		__root: wrapper
	}
}

// ============================================================
// 9. Exports
// ============================================================

module.exports = factory
module.exports.render = render
module.exports.redraw = redrawNow
module.exports.createPageWrapper = createPageWrapper
module.exports.renderToPage = renderToPage
module.exports.createLynxWindow = createLynxWindow
module.exports.LynxNodeWrapper = LynxNodeWrapper
module.exports.LynxStyleProxy = LynxStyleProxy
module.exports.normalizeEvent = normalizeEvent
