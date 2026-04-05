import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // No static export — we need server-side API routes for OpenSky proxy

  /**
   * Empty turbopack config silences the "webpack config present but no
   * turbopack config" warning in Next.js 16.  Turbopack handles node:*
   * imports natively so no special config is needed there.
   */
  turbopack: {},

  /**
   * Webpack config — active when Vercel builds with `next build --webpack`.
   *
   * satellite.js ≥ 5 re-exports a WASM bulk-propagator from
   * `dist/wasm/index.js` that transitively imports `node:module` and
   * `node:worker_threads` (Emscripten pthreads runtime).  Webpack 5 cannot
   * handle the `node:` URI scheme in browser bundles.
   *
   * Fix: alias the WASM barrel's ABSOLUTE resolved path to an empty stub.
   * Absolute-path keys in `resolve.alias` bypass the package `exports` map
   * and match regardless of how the module was originally imported (relative
   * path inside `dist/index.js`).  The pure-JS exports (propagate,
   * json2satrec, etc.) in `dist/index.js` are unaffected.
   */
  webpack(config, { isServer }) {
    if (!isServer) {
      const wasmBarrel = path.resolve(
        __dirname,
        "node_modules/satellite.js/dist/wasm/index.js"
      );
      const stub = path.resolve(__dirname, "lib/satellite-wasm-stub.js");

      (config.resolve.alias as Record<string, string>)[wasmBarrel] = stub;

      config.resolve.fallback = {
        ...(config.resolve.fallback as Record<string, unknown>),
        module:         false,
        worker_threads: false,
        fs:             false,
        path:           false,
        os:             false,
        crypto:         false,
      };
    }

    return config;
  },
};

export default nextConfig;
