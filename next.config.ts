import type { NextConfig } from "next";
const CopyWebpackPlugin = require("copy-webpack-plugin");
const path = require("path");

const nextConfig: NextConfig = {
  output: "export",   // static HTML export for deployment
  webpack: (config) => {
    const cesiumPkg = path.dirname(require.resolve("cesium/package.json"));

    // Copy Cesium static assets into public/ so the browser can load them
    config.plugins.push(
      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.join(cesiumPkg, "Build/Cesium/Workers"),
            to: path.join(__dirname, "public/cesium/Workers"),
          },
          {
            from: path.join(cesiumPkg, "Build/Cesium/ThirdParty"),
            to: path.join(__dirname, "public/cesium/ThirdParty"),
          },
          {
            from: path.join(cesiumPkg, "Build/Cesium/Assets"),
            to: path.join(__dirname, "public/cesium/Assets"),
          },
          {
            from: path.join(cesiumPkg, "Build/Cesium/Widgets"),
            to: path.join(__dirname, "public/cesium/Widgets"),
          },
        ],
      })
    );

    return config;
  },
};

export default nextConfig;
