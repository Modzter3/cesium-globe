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
        background: "#020a02",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
      }}
    >
      <svg width="40" height="40" viewBox="0 0 32 32" fill="none" aria-hidden>
        <circle cx="16" cy="16" r="14" stroke="rgba(0,255,136,0.5)" strokeWidth="1.5" />
        <ellipse cx="16" cy="16" rx="6" ry="14" stroke="rgba(0,255,136,0.3)" strokeWidth="1.2" />
        <line x1="2" y1="16" x2="30" y2="16" stroke="rgba(0,255,136,0.2)" strokeWidth="1" />
      </svg>
      <span style={{ color: "rgba(0,255,136,0.4)", fontSize: "0.72rem", letterSpacing: "0.18em", fontFamily: "monospace" }}>
        INITIALISING…
      </span>
    </div>
  ),
});

export default function Home() {
  return <GlobeViewer />;
}
