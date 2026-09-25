// src/list-attributes.js
//
// The attribute catalog of Lynx's built-in `<list>` / `<list-item>`
// elements, shared by both threads. Source: the official element reference
// (lynxjs.org/api/elements/built-in/list), plus the list-item platform-info
// set ReactLynx itself sends to native (`platformInfoAttributes` in
// @lynx-js/react's runtime/lib/snapshot/snapshot/platformInfo.js).
//
// Why a catalog at all: these attributes are TYPED on the native side
// (booleans, numbers, the `item-snap` object). Mithril's plain attribute
// path can't carry that — it turns `true` into `setAttribute(key, "")` and
// `false` into `removeAttribute(key)` (render.js `setAttr`), and fake-dom's
// generic setAttribute stringifies. fake-dom exposes every name below as a
// real property on `list`/`list-item` elements, which makes Mithril take its
// property path instead (`key in vnode.dom` -> `vnode.dom[key] = value`) and
// hand over the raw value, `false` included.

/** Every documented `<list>` attribute. The CSS-only `list-main-axis-gap` /
 * `list-cross-axis-gap` go through `style`, not here. */
export const LIST_ATTRIBUTES = Object.freeze([
	"list-type",
	"span-count",
	"scroll-orientation",
	"enable-scroll",
	"enable-nested-scroll",
	"sticky",
	"sticky-offset",
	"bounces",
	"initial-scroll-index",
	"need-visible-item-info",
	"upper-threshold-item-count",
	"lower-threshold-item-count",
	"scroll-event-throttle",
	"item-snap",
	"update-animation",
	"need-layout-complete-info",
	"layout-id",
	"preload-buffer-count",
	"scroll-bar-enable",
	"harmony-scroll-edge-effect",
	"experimental-recycle-sticky-item",
]);

/** `<list-item>` attributes native needs BEFORE it renders an item (they
 * drive layout: spans, sticky slots, placeholder size, reuse pools), so they
 * travel inside `update-list-info`'s insert/update actions, not only as
 * element attributes. */
export const LIST_ITEM_PLATFORM_ATTRIBUTES = Object.freeze([
	"item-key",
	"full-span",
	"sticky-top",
	"sticky-bottom",
	"estimated-height",
	"estimated-height-px",
	"estimated-main-axis-size-px",
	"reuse-identifier",
	"recyclable",
]);

/** Platform-info attributes that exist only inside `update-list-info` and
 * are never set on the element itself (ReactLynx's
 * `platformInfoVirtualAttributes`). */
export const LIST_ITEM_VIRTUAL_ATTRIBUTES = Object.freeze(["reuse-identifier", "recyclable"]);

/** Typed attributes exposed as properties on the fake-dom element, per tag. */
export const TYPED_ATTRIBUTES_BY_TAG = Object.freeze({
	list: LIST_ATTRIBUTES,
	"list-item": LIST_ITEM_PLATFORM_ATTRIBUTES,
});
