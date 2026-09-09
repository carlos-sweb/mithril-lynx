# Mithril 2.3.8 `render/render.js` — Extracted Contract

Source: `node_modules/mithril/render/render.js` (910 lines), mithril **2.3.8**.
All line numbers cite that file unless prefixed with `hyperscript.js:` (which cites `node_modules/mithril/render/hyperscript.js`).

---

## a. Factory signature & how the render function is obtained

- **Line 8**: `module.exports = function() {` — the module exports a **zero-argument factory function**.
- The factory closes over module-level mutable state:
  - `currentRedraw` (line 14) — the active `redraw` callback, captured by `EventDict` for auto-redraw.
  - `currentRender` (line 15) — a per-render generation marker object (used by `delayedRemoval`).
  - `currentDOM` (line 880) — the DOM node currently being rendered to (reentrancy lock).
- The **render function is the closure returned by the factory**: lines 882–909, `return function(dom, vnodes, redraw) { ... }`.
- Module dependencies (lines 3–6): `./vnode`, `./delayedRemoval`, `./domFor`, `./cachedAttrsIsStaticMap`.
- The factory pattern means each call to `require("mithril/render/render")()` produces an **independent renderer instance** with its own `currentRedraw`/`currentDOM`/`currentRender` state.

## b. Render function signature: `render(dom, vnodes, redraw)`

Defined at **line 882**: `return function(dom, vnodes, redraw) {`

| Param | Contract |
|---|---|
| `dom` | The DOM element to render into. **Line 883**: throws `TypeError("DOM element being rendered to does not exist.")` if falsy. **Lines 884–886**: throws `TypeError("Node is currently being rendered to and thus is locked.")` if `currentDOM != null && dom.contains(currentDOM)` (reentrancy guard). |
| `vnodes` | A vnode or array of vnodes. **Line 899**: normalized via `Vnode.normalizeChildren(Array.isArray(vnodes) ? vnodes : [vnodes])`. |
| `redraw` | Optional. **Line 894**: `currentRedraw = typeof redraw === "function" ? redraw : undefined`. Consumed by `EventDict.handleEvent` (lines 811–817) to auto-redraw after events. |

Body sequence:
1. **Line 898**: first render into a node clears it — `if (dom.vnodes == null) dom.textContent = ""`.
2. **Line 900**: `updateNodes(dom, dom.vnodes, vnodes, hooks, null, namespace === "http://www.w3.org/1999/xhtml" ? undefined : namespace)` — diffs old (`dom.vnodes`) vs new (`vnodes`); the XHTML namespace is normalized to `undefined` (which enables the property-key path in `hasPropertyKey`).
3. **Line 901**: `dom.vnodes = vnodes` — **prior vnodes are stored on the DOM node itself**.
4. **Line 903**: focus restoration — if `document.activeElement` changed and the old active element still has `.focus`, it is refocused.
5. **Line 904**: post-render hooks (`oncreate`/`onupdate`) flushed in order.
6. **Lines 905–908**: `finally` restores `currentRedraw`/`currentDOM` to their previous values.

## c. DOM surface accessed on the `dom` parameter

All access goes through the `dom` node passed to `render()` (or its descendants). `getDocument(dom)` (lines 17–19) returns `dom.ownerDocument`.

| API | Lines | Usage |
|---|---|---|
| `ownerDocument` | 18 | `getDocument()`; source of all document-level factories |
| `createTextNode` | 76 | `createText` — `vnode.dom = getDocument(parent).createTextNode(vnode.children)` |
| `createElement` / `createElementNS` | 120–122 | `createElement` for HTML, `createElementNS(ns, tag)` for svg/math; `{is: is}` third arg for custom elements |
| `createDocumentFragment` | 96, 104, 551 | `createHTML` (96), `createFragment` (104), `moveDOM` for multi-node moves (551) |
| `insertBefore` / `appendChild` | 558–561 | `insertDOM`: `insertBefore(dom, nextSibling)` if `nextSibling != null`, else `appendChild(dom)` |
| `removeChild` | 610–617 | `removeDOM`: single `removeChild(vnode.dom)` or per-node via `domFor` for fragments |
| `nodeValue` | 422 | `updateText` — `old.dom.nodeValue = vnode.children` |
| `value` | 654–658, 666, 699, 703 | Read for same-value coercion skips (input/textarea/select/option); written via generic `vnode.dom[key] = value` (666); select late-attrs (699, 703) |
| `checked` | 730 | Only as a key name in `isFormAttribute`; written via generic property path (666) |
| `selectedIndex` | 685, 699, 702, 707 | `removeAttr` guard (685), `setLateSelectAttrs` (699, 702, 707) |
| `className` | 672, 681, 693 | `setAttr` maps `className` → `"class"` attribute (672); `removeAttr` excludes it from property-null path (681) and maps to `"class"` (693) |
| `setAttribute` | 665, 669–670, 672 | input `type` (665), boolean attrs (669–670), generic attrs (672) |
| `removeAttribute` | 670, 693 | boolean-false (670), generic removal (693) |
| `setAttributeNS` | 645 | `xlink:`-prefixed keys → `setAttributeNS("http://www.w3.org/1999/xlink", key.slice(6), value)` |
| `style` | 646, 678, 747–787 | `updateStyle` dual-mode (see §f) |
| `innerHTML` | 89, 92, 571 | `createHTML` (89 svg-wrapped, 92 plain), contenteditable sync (571) |
| `textContent` | 898 | First-render clear |
| `firstChild` | 90, 94, 98, 109 | `createHTML` unwrap (90, 94, 98), `createFragment` dom anchor (109) |
| `parentNode` | 730 | `isFormAttribute` — `option` whose parent is the active element |
| `contains` | 884 | Reentrancy lock check |
| `namespaceURI` | 891 | Namespace detection for the diff call |
| `focus` | 903 | Focus restoration |
| `nextSibling` | domFor.js:12 | Fragment iteration in `domFor` |

**Not used (verified by grep across the whole package):**
- `getAttribute` — render.js only *writes* attributes (`setAttribute`/`removeAttribute`/`setAttributeNS`); it never reads them.
- `nodeType` — appears nowhere in mithril. Do not rely on it in a reimplementation.

## d. Prior-vnode storage & diffing of repeated `render()` calls

**Storage**: old vnodes live on the DOM node as `dom.vnodes` — read at line 898 (first-render check) and 900 (diff input), written at line 901.

**`updateNodes(parent, old, vnodes, hooks, nextSibling, ns)`** (lines 270–395):

1. **Trivial cases** (271–273): `old === vnodes` or both null → no-op; `old` empty → create all; `vnodes` empty → remove all.
2. **Keyed detection** (275–276): lists are keyed iff `old[0].key != null` / `vnodes[0].key != null` (first non-null node, 278–279).
3. **Keyed/unkeyed mismatch** (280–282): remove all old + create all new.
4. **Unkeyed diff** (283–299): walk the common length index-by-index; `o === v` or both null → skip; null old → create; null new → remove; else `updateNode`. Tails handled by `removeNodes` (298) / `createNodes` (299).
5. **Keyed diff** (300–392), with the documented optimizations (comment block 184–268):
   - **Bottom-up tail match** (305–312): while tail keys equal, update in place — identical tails are guaranteed part of the LIS, so no moves (tail optimization, comment 244–245).
   - **Top-down head match** (314–320): same for the head.
   - **Swaps & reversals** (322–336): two-node cross-swap fast path.
   - **Bottom-up again** (338–345): re-check tails after head/tail consumption.
   - **Leftovers** (346–347): remove remaining old or create remaining new.
   - **LIS-based middle diff** (348–391): builds `oldIndices` (350–351), maps new keys → old indices via `getKeyMap` (352–365; impl 478–488), nulls matched old entries, removes unmatched old (367), creates all if nothing matched (368), then either moves non-LIS nodes (`makeLisIndices`, 370–383; impl 494–534, lifted from ivi) or a simple create loop when order was preserved (384–390).
6. **`getNextSibling`** (536–541): next sibling is found by scanning the *old* list forward from `i+1` for a node with a `dom` — this is what makes top-down DOM insertion correct.
7. **`moveDOM`** (544–556): moves single nodes directly; multi-node fragments are moved via a `createDocumentFragment` + `domFor` loop.

**`updateNode`** (396–419): same `tag` + same `is` → in-place update (state/events carried over at 399–400; `shouldNotUpdate` short-circuit at 401, impl 852–878); otherwise `removeNode` + `createNode`. Per-tag updates: `updateText` (420–425), `updateHTML` (426–435), `updateFragment` (436–450), `updateElement` (451–461), `updateComponent` (462–477).

## e. How `m()` (hyperscript) creates events & attrs

**Hyperscript side** (`render/hyperscript.js`):
- Selector parsing: `compileSelector` (hyperscript.js:21–42) — `#id`, `.class`, `[attr]`, `[attr=value]`; `class` → `className` (hyperscript.js:38); form-attribute keys (`value`/`checked`/`selectedIndex`/`selected`) mark the attrs object as non-static (hyperscript.js:17–19, 34).
- `class` attr → `className` (hyperscript.js:54–57); `input[type]` reordered first (hyperscript.js:69–74, workaround for #2622); `vnode.is = attrs.is` (hyperscript.js:77).

**Event side** (render.js):
- **Dispatch rule** (line 644): any attr key starting with `on` (`key[0] === "o" && key[1] === "n"`) is routed to `updateEvent` (826–842), never to the DOM attribute path.
- **`EventDict`** (800–823): a per-element event listener object, prototype `Object.create(null)` (804). Constructor captures `this._ = currentRedraw` (802). `handleEvent(ev)` (805–823):
  - Looks up `this["on" + ev.type]` (806).
  - Function handler → called with `ev.currentTarget` as `this` (808); object handler → `handler.handleEvent(ev)` (809).
  - Auto-redraw: if `this._ != null` and `ev.redraw !== false`, calls the captured redraw (811–812); also after the handler's returned promise resolves (813–817).
  - `return false` → `ev.preventDefault()` + `ev.stopPropagation()` (819–822).
- **`updateEvent`** (826–842): `addEventListener(key.slice(2), vnode.events, false)` — the **EventDict object itself is the listener** (831, 839); handlers stored as `vnode.events[key]`; removal via `removeEventListener` (834). `vnode.events` is carried across updates (line 400).

**Attribute side** (render.js):
- **`setAttr`** (642–674) precedence: skip `key`/null-value/lifecycle (643) → `on*` events (644) → `xlink:` (645) → `style` (646) → **`hasPropertyKey`** (647–666) → attribute fallback (667–673).
- **`hasPropertyKey`** (735–744): property assignment only when `ns === undefined` AND (custom element: tag contains `-` or `vnode.is`, OR key not in the browser-bug blacklist `href`/`list`/`form`/`width`/`height`) AND `key in vnode.dom`.
- Property path (666): `vnode.dom[key] = value`, with `value` coercion guards (648–663: input/textarea/select/option same-value skip; file-input read-only warning at 661) and `input[type]` forced through `setAttribute` (665).
- Attribute path (667–673): boolean → `setAttribute(key, "")` / `removeAttribute(key)`; else `setAttribute(key === "className" ? "class" : key, value)`.
- **`removeAttr`** (675–695): property-null path excludes `className`, `title`, `value` (option/select edge), `input[type]`; else `removeAttribute` with `className` → `"class"` mapping.
- **`updateAttrs`** (709–728): removals first (713–722), then sets (723–727); warns on reused attrs objects (714–716).
- **`isFormAttribute`** (729–731): `value`/`checked`/`selectedIndex`/`selected` (with active-element/option-parent conditions) — these bypass the `old === value` skip so form state always syncs.

## f. `updateStyle()` dual-mode (lines 747–787)

`updateStyle(element, old, style)`:

| Case | Lines | Behavior |
|---|---|---|
| `old === style` | 748–749 | No-op |
| `style == null` | 750–752 | `element.style = ""` (clear) |
| `typeof style !== "object"` | 753–755 | `element.style = style` (string passthrough) |
| `old` missing/string, `style` object | 756–766 | Clear, then for each key: **`key.includes("-")` → `element.style.setProperty(key, String(value))`** (763); **else `element.style[key] = String(value)`** (764) |
| Both objects | 767–786 | Remove stale keys first (772–777: `removeProperty` for dash-case, `= ""` for camelCase), then set changed keys (779–785: same dual-mode) |

Key contract points:
- **Dash-case keys** (`-` in the name) → `setProperty` / `removeProperty`; **camelCase keys** → direct `style[k]` assignment.
- All values coerced with `String()` (763–764, 781).
- Removal happens before setting (770–771) to avoid dash-case/camelCase aliasing bugs.

## g. Version & packaging

- **Version**: `2.3.8` (package.json `version` field).
- **No `main` / `module` field** in package.json (verified — only `unpkg`/`jsdelivr`/`repository`/`license`/`scripts`/`devDependencies`). The package is consumed by **file-path require**: `require("mithril/render/render")` resolves directly to `node_modules/mithril/render/render.js`.
- Entry points: `index.js` (browser bundle), `render.js` (top-level re-export of `render/render.js`), `hyperscript.js` (re-export of `render/hyperscript.js` + `trust`/`fragment`).
- 2.3.8 is the latest mithril release on npm (as of this scaffold's dependency pin).

---

## Reimplementation checklist (what a Lynx port must honor)

1. Factory `module.exports = function()` returning `function(dom, vnodes, redraw)` with per-instance `currentRedraw`/`currentRender`/`currentDOM` state.
2. Store prior vnodes on the target node (`dom.vnodes`); first render clears via `textContent = ""`.
3. Diff pipeline: trivial cases → keyed detection → unkeyed walk → keyed (tail/head/swaps/LIS) → leftover create/remove.
4. DOM surface: `createTextNode`, `createElement(NS)`, `createDocumentFragment`, `insertBefore`/`appendChild`, `removeChild`, `nodeValue`, `value`, `checked`, `selectedIndex`, `className`, `setAttribute`/`removeAttribute`/`setAttributeNS`, `style`, `innerHTML`, `textContent`, `firstChild`, `parentNode`, `ownerDocument`, `namespaceURI`, `contains`, `focus`. **No `getAttribute`, no `nodeType`.**
5. Events: `on*` keys → single `EventDict` object per element registered via `addEventListener`; `handleEvent` dispatches by `ev.type`, binds `this` to `ev.currentTarget`, auto-redraws, honors `return false`.
6. Attrs: `hasPropertyKey` gate (property vs attribute), `className`→`class` mapping, boolean attrs, `xlink:` namespace, `value`/`checked`/`selectedIndex` form-attribute exceptions.
7. Styles: dual-mode `updateStyle` — `setProperty` for `-` keys, `style[k] = v` for camelCase, `String()` coercion, remove-before-set.
