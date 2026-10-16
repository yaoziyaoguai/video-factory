import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "motion/react";
import { initializeStudioAppearance } from "./studio-appearance.js";
import "@fontsource-variable/manrope";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "driver.js/dist/driver.css";
import { App } from "./App.js";
import "./styles.css";
import "./studio-v3.css";
import "./creator-tour.css";
import "./auth.css";
import "./studio-cplus.css";
import "./studio-foundation.css";
import "./studio-library.css";
import "./studio-workspace.css";
import "./studio-creation-shell.css";
import "./studio-home.css";
import "./studio-topics.css";
import "./studio-collections.css";
import "./studio-creation-pages.css";
import "./studio-new-production.css";
import "./studio-production.css";

initializeStudioAppearance();
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
