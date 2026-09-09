// Shared event-name constants for the main-thread <-> background-thread
// channel, ported from lynx-examples/examples/vanilla/src/common/constant.ts.
// Native engine lifecycle events keep their exact native names; custom
// app-level events are namespaced to avoid colliding with other libraries
// dispatching on the same shared event bus.

export const renderPageEventName = "__RenderPage";
export const updatePageEventName = "__UpdatePage";
export const destroyLifetimeEventName = "__DestroyLifetime";

export const updateDataFromMainThreadEventName = "MithrilLynx:UpdateDataFromMainThread";
export const updateDataFromBackgroundEventName = "MithrilLynx:UpdateDataFromBackground";
export const dispatchEventToBackgroundEventName = "MithrilLynx:DispatchEventToBackground";

// Renderer mode (Phase 4): background thread ships op-log patches to main
// thread; main thread forwards real PAPI events back to background by vid.
export const rendererPatchEventName = "MithrilLynx:RendererPatch";
export const rendererEventEventName = "MithrilLynx:RendererEvent";

// Cross-thread function registry (Phase 6, worklet substitute): call/return
// correlation for genuinely cross-thread calls. "ToMainThread"/"ToBackground"
// name which side the CALL travels to — each has its own result event.
export const callMainThreadEventName = "MithrilLynx:CallMainThread";
export const callMainThreadResultEventName = "MithrilLynx:CallMainThreadResult";
export const callBackgroundEventName = "MithrilLynx:CallBackground";
export const callBackgroundResultEventName = "MithrilLynx:CallBackgroundResult";
