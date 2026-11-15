import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Tauri 以 file:// 加载 dist，资源必须相对路径
  base: "./",
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    target: "chrome110",
    outDir: "dist",
  },
});
