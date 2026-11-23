import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { AgentWorkbench } from "./agent/AgentWorkbench.js";

// Frame 是新的产品入口；旧页面不再决定导航、对话或制作过程。
export function App() {
  return <AuthGate>{({ logout, ownerId }) => <Routes key={ownerId}>
    <Route path="/agent" element={<AgentWorkbench onLogout={logout} storageOwner={ownerId} />} />
    <Route path="/agent/:conversationId" element={<AgentWorkbench onLogout={logout} storageOwner={ownerId} />} />
    <Route path="*" element={<Navigate to="/agent" replace />} />
  </Routes>}</AuthGate>;
}
