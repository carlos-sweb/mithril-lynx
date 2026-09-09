// element.js
//
// Ergonomic imperative escape hatch for a main-thread node — whatever
// Mithril's oncreate(vnode)/onupdate(vnode) hooks hand you as `vnode.dom`
// (works for any real LynxNodeWrapper: main-thread-owned mode, or
// data-channel mode's main-thread half). Not part of render.js's own DOM
// contract (see ../CONTRACT.md) — these are Element PAPI capabilities apps
// reach for directly (focusing a native input, animating, calling a native
// custom element's method), so they live in their own small module instead
// of the shim.
//
// Project plan, Phase 5. Background-thread refs are the selector-query
// equivalent — see background.js's createRef().

const ANIMATION_OPERATION = { START: 0, PLAY: 1, PAUSE: 2, CANCEL: 3 };

function wrapRef(handle) {
	return handle == null ? null : wrapElement({ _handle: handle });
}

/**
 * Wraps a node (anything with a `_handle`, i.e. a real LynxNodeWrapper OR a
 * raw ElementRef from querySelector) with imperative PAPI methods render.js
 * itself never needs. setAttribute mirrors the real LynxNodeWrapper's own
 * class/id/data-prefixed/generic-attribute special-casing (see
 * ../CONTRACT.md) rather than delegating to node.setAttribute() directly —
 * a raw querySelector result has no such method, only a `_handle`.
 */
export function wrapElement(node) {
	const handle = node._handle;

	return {
		setStyleProperty(name, value) {
			__SetInlineStyles(handle, { [name]: value });
		},

		setStyleProperties(styles) {
			__SetInlineStyles(handle, styles);
		},

		setAttribute(name, value) {
			if (name === "class") __SetClasses(handle, value == null ? undefined : String(value));
			else if (name === "id") __SetID(handle, value == null ? null : String(value));
			else if (name.slice(0, 5) === "data-") __AddDataset(handle, name.slice(5), value);
			else __SetAttribute(handle, name, value == null ? null : value);
		},

		querySelector(selector, params) {
			return wrapRef(__QuerySelector(handle, selector, params || {}));
		},

		querySelectorAll(selector, params) {
			return __QuerySelectorAll(handle, selector, params || {}).map((ref) => wrapRef(ref));
		},

		animate(keyframes, options) {
			__ElementAnimate(handle, [ANIMATION_OPERATION.START, (options && options.name) || "", keyframes, options]);
		},

		playAnimation(name) {
			__ElementAnimate(handle, [ANIMATION_OPERATION.PLAY, name]);
		},

		pauseAnimation(name) {
			__ElementAnimate(handle, [ANIMATION_OPERATION.PAUSE, name]);
		},

		cancelAnimation(name) {
			__ElementAnimate(handle, [ANIMATION_OPERATION.CANCEL, name]);
		},

		/** Always resolves with { code, data } — check `code` yourself; PAPI's success/failure convention isn't assumed here. */
		invoke(method, params) {
			return new Promise((resolve) => {
				__InvokeUIMethod(handle, method, params || {}, (res) => resolve(res));
			});
		},
	};
}
