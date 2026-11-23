// 设置页标识与标题：独立小模块，供工作台与懒加载的 FrameSettings 共享，
// 避免主包为了一个标题表静态引入整个设置面板（审计第三阶段拆包）。
export type FramePage = "chat" | "models" | "services" | "skills" | "library" | "profile" | "team";
export const framePageTitle: Record<FramePage, string> = {
  chat: "对话", models: "模型配置", services: "免费服务", skills: "Skill 管理", library: "作品库", profile: "用户页", team: "成员与预算",
};

export function adminPage(page: string | null): page is "models" | "services" | "skills" | "team" {
  return page === "models" || page === "services" || page === "skills" || page === "team";
}
