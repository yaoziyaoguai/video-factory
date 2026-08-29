import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/manrope";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "driver.js/dist/driver.css";
import { App } from "./App.js";
import "./styles.css";
import "./studio-v3.css";
import "./creator-tour.css";
import "./auth.css";
import "./studio-polish.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Studio root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
