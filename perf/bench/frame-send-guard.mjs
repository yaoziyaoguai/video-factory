import { createHash } from "node:crypto";

export const SCRIPT_TITLES = ["城市夜景延时开场脚本", "第一人称晨跑独白脚本", "数据卡片式对比脚本"];
export const visibleLines = text => text.split("\n").map(line => line.trim()).filter(Boolean);
// 交付卡顺序可不同。排序保留重复行，因此每一行仍须有相同的出现次数。
export const lineSetHash = lines => createHash("sha256").update([...lines].sort().join("\n")).digest("hex");

const versionLabel = "脚本 · v1";
const oldCard = title => [title, versionLabel, title];
const currentCard = title => [versionLabel, `现名：${title}`, `${versionLabel}，现名：${title}`];
const rows = cards => JSON.stringify(cards.map(card => JSON.stringify(card)).sort());

export function compareSendGuards(a, b) {
  for (const guard of [a, b]) {
    if (guard.reviewed?.title !== SCRIPT_TITLES[0] || guard.reviewed.revisionNumber !== 1) {
      return "未选中指定稿的 v1";
    }
    if (!Array.isArray(guard.lines) || !guard.lines.length
      || !guard.lines.every(line => typeof line === "string" && line.length > 0 && line === line.trim() && !line.includes("\n"))
      || guard.golden !== lineSetHash(guard.lines)) {
      return "缺少可见行或可见行与哈希不符";
    }
    if (!Array.isArray(guard.referenceCards)
      || ![rows(SCRIPT_TITLES.map(oldCard)), rows(SCRIPT_TITLES.map(currentCard))].includes(rows(guard.referenceCards))) {
      return "聊天引用必须各有一张准确绑定 v1 的脚本卡";
    }
  }

  const before = rows(a.referenceCards);
  const after = rows(b.referenceCards);
  if (before === after) return a.golden === b.golden ? null : "可见行或次数改变";
  if (before !== rows(SCRIPT_TITLES.map(oldCard)) || after !== rows(SCRIPT_TITLES.map(currentCard))) {
    return "聊天引用的标题与版本不符合允许的差异";
  }

  // 双宽度仅允许三张聊天引用的单行标题各改一次。标题在产物页签等位置仍须逐行保留。
  const expected = [...a.lines];
  for (const title of SCRIPT_TITLES) {
    const index = expected.indexOf(title);
    if (index < 0 || a.lines.includes(`现名：${title}`)) return "可见行缺少审核过的原始标题";
    expected[index] = `现名：${title}`;
  }
  return lineSetHash(expected) === b.golden ? null : "出现三个已审核的现名差异以外的可见行变化";
}
