import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "motion/react";
import "@fontsource-variable/manrope";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import { App } from "./App.js";
import "./frame-base.css";
import "./auth.css";


const root = document.getElementById("root");
if (!root) {
  throw new Error("Studio root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 400, damping: 36 }}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MotionConfig>
  </StrictMode>,
);