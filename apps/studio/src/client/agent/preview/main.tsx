import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "../../frame-base.css";
import { AgentWorkbench } from "../AgentWorkbench.js";
import { installMockBackend } from "./mock-backend.js";

// 预览页 = 真实工作台 + 内存 Mock API：组件与交互全部走生产代码（审计第三阶段合并重复原型）。
// 先装 Mock 再渲染，让首次 bootstrap 即来自剧本数据；MemoryRouter 提供工作台需要的路由上下文。
installMockBackend();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoryRouter initialEntries={["/agent/conv-trail"]}>
      <Routes>
        <Route path="/agent" element={<AgentWorkbench />} />
        <Route path="/agent/:conversationId" element={<AgentWorkbench />} />
        <Route path="*" element={<Navigate to="/agent" replace />} />
      </Routes>
    </MemoryRouter>
  </StrictMode>,
);
