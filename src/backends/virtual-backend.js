// src/backends/virtual-backend.js
//
// The background-thread half of the patch protocol: `fake-dom.js` calls
// these methods instead of touching real elements, and every call appends
// one op to a flat array (see ../patch-protocol.js for the op format and
// why it's flat). `takeOps()` is called once per commit (see ../commit.js)
// to drain the array for sending across the thread boundary.

import { Op, pushOp } from "../patch-protocol.js";

export function createVirtualBackend() {
	let nextId = 1;
	let ops = [];

	return {
		// Exposed for tests that want to assert on id allocation directly;
		// application code should never need it.
		allocId() {
			return nextId++;
		},
		createElement(tag) {
			const id = nextId++;
			pushOp(ops, Op.CreateElement, tag, id);
			return id;
		},
		createElementNS(ns, tag) {
			const id = nextId++;
			pushOp(ops, Op.CreateElementNS, ns, tag, id);
			return id;
		},
		createText(text) {
			const id = nextId++;
			pushOp(ops, Op.CreateText, text, id);
			return id;
		},
		insertBefore(parentId, childId, refId) {
			pushOp(ops, Op.InsertBefore, parentId, childId, refId ?? -1);
		},
		removeChild(parentId, childId) {
			pushOp(ops, Op.RemoveChild, parentId, childId);
		},
		setAttribute(id, name, value) {
			pushOp(ops, Op.SetAttribute, id, name, value);
		},
		removeAttribute(id, name) {
			pushOp(ops, Op.RemoveAttribute, id, name);
		},
		setAttributeNS(id, ns, name, value) {
			pushOp(ops, Op.SetAttributeNS, id, ns, name, value);
		},
		setClasses(id, value) {
			// Encoded as a SetAttribute on the synthetic "class" name — the
			// patch applier special-cases that name into `__SetClasses`, the
			// same split fake-dom.js already does on the way in.
			pushOp(ops, Op.SetAttribute, id, "class", value);
		},
		setStyleProperty(id, name, value) {
			pushOp(ops, Op.SetStyleProperty, id, name, value);
		},
		removeStyleProperty(id, name) {
			pushOp(ops, Op.RemoveStyleProperty, id, name);
		},
		setText(id, value) {
			pushOp(ops, Op.SetText, id, value);
		},
		addEvent(id, type) {
			pushOp(ops, Op.AddEvent, id, type);
		},
		removeEvent(id, type) {
			pushOp(ops, Op.RemoveEvent, id, type);
		},
		setGestureDetector(id, gestureId, gestureType, arenaPolicy) {
			pushOp(ops, Op.SetGestureDetector, id, gestureId, gestureType, arenaPolicy);
		},
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
