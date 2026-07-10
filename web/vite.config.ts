import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server proxies the JSON API and CSV export to the local FastAPI instance
// (uvicorn on :8000). Production serving (StaticFiles mount) comes in a later
// phase — see HANDOFF.md §8.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/export": "http://127.0.0.1:8000",
    },
  },
});
