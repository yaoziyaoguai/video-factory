import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "../../frame-base.css";
import "../agent.css";
import { PreviewWorkbench } from "./PreviewWorkbench.js";
import "./preview.css";

createRoot(document.getElementById("root")!).render(<PreviewWorkbench />);
