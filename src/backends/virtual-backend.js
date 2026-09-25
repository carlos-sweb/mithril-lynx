// src/backends/virtual-backend.js
//
// The background-thread half of the patch protocol: `fake-dom.js` calls
// these methods instead of touching real elements, and every call appends
// one op to a flat array (see ../patch-protocol.js for the op format and
// why it's flat). `takeOps()` is called once per commit (see ../commit.js)
// to drain the array for sending across the thread boundary.

import { Op, pushOp } from "../patch-protocol.js";

/**
 * Creates the background-thread patch backend: every call appends one op to a flat buffer.
 * @returns {{allocId: () => number, createElement: (tag: string) => number, createElementNS: (ns: string, tag: string) => number, createText: (text: string) => number, insertBefore: (parentId: number, childId: number, refId?: number) => void, removeChild: (parentId: number, childId: number) => void, setAttribute: (id: number, name: string, value: *) => void, removeAttribute: (id: number, name: string) => void, setAttributeNS: (id: number, ns: string|null, name: string, value: string|null) => void, setClasses: (id: number, value: string) => void, setStyleProperty: (id: number, name: string, value: string) => void, removeStyleProperty: (id: number, name: string) => void, setText: (id: number, value: string) => void, addEvent: (id: number, type: string) => void, removeEvent: (id: number, type: string) => void, setGestureDetector: (id: number, gestureId: number, gestureType: string, arenaPolicy: string) => void, removeGestureDetector: (id: number, gestureId: number) => void, takeOps: () => unknown[]|null}} The backend object.
 */
export function createVirtualBackend() {
	let nextId = 1;
	let ops = [];

	return {
		// Exposed for tests that want to assert on id allocation directly;
		// application code should never need it.
		/**
		 * @returns {number} A fresh element id.
		 */
		allocId() {
			return nextId++;
		},
		/**
		 * @param {string} tag - The tag name.
		 * @returns {number} The new element's id.
		 */
		createElement(tag) {
			const id = nextId++;
			pushOp(ops, Op.CreateElement, tag, id);
			return id;
		},
		/**
		 * @param {string} ns - The namespace URI.
		 * @param {string} tag - The tag name.
		 * @returns {number} The new element's id.
		 */
		createElementNS(ns, tag) {
			const id = nextId++;
			pushOp(ops, Op.CreateElementNS, ns, tag, id);
			return id;
		},
		/**
		 * @param {string} text - The initial text.
		 * @returns {number} The new text node's id.
		 */
		createText(text) {
			const id = nextId++;
			pushOp(ops, Op.CreateText, text, id);
			return id;
		},
		/**
		 * @param {number} parentId - Parent element id.
		 * @param {number} childId - Child id to insert.
		 * @param {number} [refId] - Id to insert before; `-1` (or omitted) appends.
		 * @returns {void}
		 */
		insertBefore(parentId, childId, refId) {
			pushOp(ops, Op.InsertBefore, parentId, childId, refId ?? -1);
		},
		/**
		 * @param {number} parentId - Parent element id.
		 * @param {number} childId - Child id to remove.
		 * @returns {void}
		 */
		removeChild(parentId, childId) {
			pushOp(ops, Op.RemoveChild, parentId, childId);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string} name - Attribute name.
		 * @param {*} value - Attribute value: a string, or a raw typed value for a catalogued list/list-item attribute.
		 * @returns {void}
		 */
		setAttribute(id, name, value) {
			pushOp(ops, Op.SetAttribute, id, name, value);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string} name - Attribute name.
		 * @returns {void}
		 */
		removeAttribute(id, name) {
			pushOp(ops, Op.RemoveAttribute, id, name);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string|null} ns - Attribute namespace.
		 * @param {string} name - Attribute name.
		 * @param {string|null} value - Attribute value.
		 * @returns {void}
		 */
		setAttributeNS(id, ns, name, value) {
			pushOp(ops, Op.SetAttributeNS, id, ns, name, value);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string} value - The class string.
		 * @returns {void}
		 */
		setClasses(id, value) {
			// Encoded as a SetAttribute on the synthetic "class" name — the
			// patch applier special-cases that name into `__SetClasses`, the
			// same split fake-dom.js already does on the way in.
			pushOp(ops, Op.SetAttribute, id, "class", value);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string} name - Dash-case style property name.
		 * @param {string} value - Style value.
		 * @returns {void}
		 */
		setStyleProperty(id, name, value) {
			pushOp(ops, Op.SetStyleProperty, id, name, value);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string} name - Dash-case style property name (`"*"` requests a bulk clear).
		 * @returns {void}
		 */
		removeStyleProperty(id, name) {
			pushOp(ops, Op.RemoveStyleProperty, id, name);
		},
		/**
		 * @param {number} id - Text node id.
		 * @param {string} value - The new text.
		 * @returns {void}
		 */
		setText(id, value) {
			pushOp(ops, Op.SetText, id, value);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string} type - Event type.
		 * @returns {void}
		 */
		addEvent(id, type) {
			pushOp(ops, Op.AddEvent, id, type);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {string} type - Event type.
		 * @returns {void}
		 */
		removeEvent(id, type) {
			pushOp(ops, Op.RemoveEvent, id, type);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {number} gestureId - Unique gesture id.
		 * @param {string} gestureType - Native gesture type name.
		 * @param {string} arenaPolicy - Claim/release policy.
		 * @returns {void}
		 */
		setGestureDetector(id, gestureId, gestureType, arenaPolicy) {
			pushOp(ops, Op.SetGestureDetector, id, gestureId, gestureType, arenaPolicy);
		},
		/**
		 * @param {number} id - Element id.
		 * @param {number} gestureId - Gesture id to remove.
		 * @returns {void}
		 */
		removeGestureDetector(id, gestureId) {
			pushOp(ops, Op.RemoveGestureDetector, id, gestureId);
		},
		/** Drains and returns the accumulated ops. Called once per commit. */
		takeOps() {
			if (ops.length === 0) return null;
			const out = ops;
			ops = [];
			return out;
		},
	};
}
