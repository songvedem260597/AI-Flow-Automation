import { defineConfig } from "plasmo"

export default defineConfig({
  manifest: {
    host_permissions: [
      "https://*/*",
      "http://*/*"
    ],
    permissions: [
      "sidePanel",
      "tabs",
      "storage",
      "activeTab",
      "scripting",
      "notifications",
      "windows"
    ],
    // content_scripts is auto-discovered by Plasmo from src/contents/*.ts.
    // src/contents/content-script.ts is the shared ChatGPT / flow.google /
    // x / grok content script. Do NOT add a manual content_scripts block
    // here — Plasmo will emit the hashed bundle and manifest entry itself.
  },
  commonDependencies: {
    "zustand": "^5.0.3",
    "framer-motion": "^11.15.0"
  },
  sidePanels: ["./src/sidepanel.tsx"]
})
