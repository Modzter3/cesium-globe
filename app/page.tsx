"use client";

import dynamic from "next/dynamic";

// CesiumJS accesses `window` and `document` — must be client-only
const GlobeViewer = dynamic(() => import("@/components/GlobeViewer"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0b0e14",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.4)",
        fontSize: "0.85rem",
        letterSpacing: "0.1em",
        fontFamily: "system-ui",
      }}
    >
      LOADING GLOBE…
    </div>
  ),
});

export default function Home() {
  return <GlobeViewer />;
}
