// No-op stand-in for @lynx-js/webpack-dev-transport/client.
//
// `dev.hmr: true` makes Rsbuild/Rspeedy inject the official transport
// client, which opens its OWN WebSocket to /rsbuild-hmr and full-reloads
// via reloadApp.js — a second reload channel on top of this package's
// in-bundle dev-reload-client.js. plugin.js re-aliases the module here
// (order "post", so it wins over the alias @lynx-js/rsbuild-plugin
// registers) so `module.hot` stays live without a competing channel. Same
// fix as mithril-lynx v1's F2 (src/dev-transport-noop.js).
export default class DevTransportClientNoop {}
