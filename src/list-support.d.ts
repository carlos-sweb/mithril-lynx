// Ambient declaration for the ESM src/list-support.js.
//
// Import this from your app's main-thread.ts (alongside setupRenderer()
// from "mithril-lynx/main-thread") and call registerListRenderer() once
// per list your app uses — see that file's own header, and
// docs/native-papi/papi-06-virtualized-lists.md in mithril-lynx-ui, for
// why the render function itself has to be registered here rather than
// passed in from background.ts directly.

export function registerListRenderer(key: string, renderItem: (item: unknown, index: number) => unknown): void;
