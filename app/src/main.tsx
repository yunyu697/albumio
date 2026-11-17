import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installShortcutDispatcher } from "./keys";
import { hydrateTheme } from "./theme";
import "./styles/app.css";

// 主题在 React 挂载前就落到 <html data-theme="...">，避免首屏闪深色。
hydrateTheme();
installShortcutDispatcher();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
