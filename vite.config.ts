import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { handleDevApi } from "./src/server/devApi";

function pollybotApi(): Plugin {
  return {
    name: "pollybot-local-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleDevApi(request, response, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pollybotApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist-web",
  },
});
