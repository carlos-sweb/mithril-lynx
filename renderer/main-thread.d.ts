// Ambient declaration for the ESM renderer/main-thread.js (the file itself
// is not type-checked; this describes its runtime export shape for TS
// consumers).

/**
 * Wires the Lynx engine's page lifecycle and the renderer-mode patch/event
 * channel: replays op-log patches from the background thread's virtual tree
 * against a real Element PAPI tree, and forwards real PAPI events back to
 * the background thread by vid. Call once, at main-thread.ts's top level.
 * See the project plan, Phase 4 ("renderer mode").
 */
export function setupRenderer(): void;
