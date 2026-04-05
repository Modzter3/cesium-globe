/**
 * Empty stub that replaces `satellite.js/dist/wasm/index.js` in the browser
 * webpack bundle.  The WASM bulk-propagator exports are not used by this
 * application, but they transitively import `node:module` and
 * `node:worker_threads` which webpack cannot handle in browser code.
 * Stubbing the entire wasm barrel module prevents those imports while
 * keeping the pure-JS satellite.js API (propagate, json2satrec, etc.) intact.
 */
