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
    // src-tauri/target 里的 DLL 会被 cargo 持续写入；Vite 监听它会 EBUSY 直接崩掉（Windows）。
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    outDir: "dist",
  },
});
