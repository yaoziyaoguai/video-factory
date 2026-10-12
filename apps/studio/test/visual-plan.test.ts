import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planVisualDirection, recommendTemplateForBrief, resolveExecutableVisualPlan } from "../src/shared/visual-plan.js";

describe("planVisualDirection", () => {
  it("builds a three-beat executable plan for an ordinary-life topic", () => {
    const plan = planVisualDirection({
      title: "下班后什么都不想做，是懒还是耗竭？",
      hook: "你不是懒，只是把最后一点力气用在了看起来正常。",
      category: "lifestyle",
    });

    assert.equal(plan.beats.length, 3);
    assert.equal(plan.beats.every(beat => beat.duration.includes("时长由脚本确定")), true);
    assert.match(plan.strategy, /不规定镜头数量或时长/);
    assert.equal(plan.beats[0]?.source, "stock");
    assert.match(plan.beats[0]?.searchQuery ?? "", /下班后什么都不想做/);
    assert.match(plan.beats[1]?.description ?? "", /环境|动作/);
  });

  it("uses positive topic intent rather than incidental or negated keywords", () => {
    for (const hook of ["先放下手机，看叶片在水里慢慢舒展。", "不谈 AI，也不做实验，只记录窗边的光。", "电脑留在包里，沿着河岸走一会儿。", "无需科技或软件演示，观察雨滴。", "不是对照实验，只有日常片段。"]) {
      const plan = planVisualDirection({ title: "留十二秒给日常", hook });
      assert.doesNotMatch(plan.strategy, /屏幕操作|受控实证/);
      assert.doesNotMatch(plan.beats[1]!.description, /录制真实操作|只改变/);
    }
    const technical = planVisualDirection({ title: "手机系统如何管理应用权限", hook: "打开设置逐项演示定位权限。" });
    assert.match(technical.strategy, /屏幕操作/);
    const separatedIntent = planVisualDirection({ title: "手机系统权限设置", hook: "不做实验，逐项讲解真实操作。" });
    assert.match(separatedIntent.strategy, /屏幕操作/);
    const explicit = planVisualDirection({ title: "AI 软件操作", hook: "技术演示", category: "lifestyle" });
    assert.doesNotMatch(explicit.strategy, /屏幕操作/);
  });

  it("does not classify explicitly denied claims as the subject or delete their original wording", () => {
    const original = "先放下手机。看茶叶在杯中慢慢舒展，把这十二秒留给自己。只记录日常，不宣称健康疗效。";
    for (const hook of [original, "观察窗边的光，不承诺财经收益。", "记录雨滴的变化，不保证工作收入。", "只展示水纹，不声称健康效果。"]) {
      const plan = planVisualDirection({ title: "给日常留十二秒", hook });
      assert.match(plan.strategy, /人物近景、生活动作与环境细节/);
      assert.match(plan.beats[1]!.description, /生活环境/);
      assert.ok(plan.beats[0]!.description.includes(hook), "分类分析不能删除创作者的原文");
    }
    const health = planVisualDirection({ title: "健康运动如何循序渐进", hook: "演示基础训练，不宣称治疗效果。" });
    assert.match(health.strategy, /动作特写、场地关系与数据卡片/);
  });

  it("honors a series visual direction while keeping source choices editable", () => {
    const plan = planVisualDirection({
      title: "AI 下班实验室 04｜真实任务实验",
      hook: "这一集直接验证真实任务。",
      category: "technology",
      visualStyle: "真实桌面操作与生活空镜",
    });

    assert.match(plan.strategy, /真实桌面操作与生活空镜/);
    assert.equal(plan.beats[1]?.source, "stock");
    assert.equal(plan.beats.every((beat) => Boolean(beat.searchQuery)), true);
  });

  it("uses the promised proof method across domains instead of letting topic keywords choose the video structure", () => {
    const controlledDemonstrations = [
      ["为什么手机拍咖啡总显得灰", "同一杯、同一手机、同一机位，只移动一盏侧灯验证差别。"],
      ["防晒霜真的能挡住紫外线吗", "同一光源下做涂抹前后对照实验。"],
      ["盐为什么让冰融得更快", "两块同样的冰只给一块加盐，记录完整变化。"],
    ] as const;

    for (const [title, hook] of controlledDemonstrations) {
      const plan = planVisualDirection({ title, hook });
      assert.match(plan.strategy, /受控实证/);
      assert.match(plan.beats[1]?.description ?? "", /相同条件|只改变|连续过程/);
      assert.equal(recommendTemplateForBrief({ title, hook }), "product-demo");
    }

    const recipe = planVisualDirection({
      title: "在家怎样做一杯手冲咖啡",
      hook: "按三个步骤做出干净风味。",
    });
    assert.match(recipe.strategy, /制作动作、食材质感/);
    assert.equal(recommendTemplateForBrief({ title: "在家怎样做一杯手冲咖啡", hook: "按三个步骤做出干净风味。" }), "knowledge-explainer");
  });

  it("resolves historical creator and screen directions against the selected production pool", () => {
    const plan = resolveExecutableVisualPlan({
      strategy: "优先使用创作者拍摄和屏幕录制。",
      beats: [
        { id: "one", role: "动作", duration: "0-3 秒", description: "手完成实验。", searchQuery: "实验 手 特写", source: "creator" },
        { id: "two", role: "证据", duration: "3-8 秒", description: "界面显示结果。", searchQuery: "设备 结果 界面", source: "screen" },
      ],
    }, { stock: true, generated: true, editorialCard: false });

    assert.deepEqual(plan.beats.map((beat) => beat.source), ["stock", "stock"]);
    assert.doesNotMatch(plan.strategy, /优先使用创作者拍摄/);
    assert.match(plan.strategy, /不假设存在未提供的创作者拍摄或屏幕录制/);
  });

  it("rejects an impossible production pool instead of sending a contradictory plan to the model", () => {
    assert.throws(() => resolveExecutableVisualPlan({
      strategy: "实拍动作。",
      beats: [{ id: "one", role: "动作", duration: "0-3 秒", description: "手完成实验。", searchQuery: "实验", source: "creator" }],
    }, { stock: false, generated: false, editorialCard: true }), /没有可执行的图库或生成能力/);
  });

  it("turns a long quoted headline into complete creator-facing shot directions", () => {
    const plan = planVisualDirection({
      title: "学校治理AI作弊，难点可能不是“禁不禁”，而是怎样证明学习发生过",
      hook: "丹麦推出紧急方案遏制AI作弊，但一份作业究竟怎样证明是学生完成的？",
      category: "education",
    });

    assert.match(plan.beats[1]?.description ?? "", /纸面推演或屏幕演示/);
    assert.match(plan.beats[2]?.description ?? "", /回答“学校治理AI作弊”/);
    assert.equal(plan.beats.every((beat) => !`${beat.description} ${beat.searchQuery}`.includes("…")), true);
    assert.equal(plan.beats.every((beat) => !beat.description.includes("“禁不禁”")), true);
  });

  it("keeps the actual topic after a series or test prefix separated by a colon", () => {
    const plan = planVisualDirection({
      title: "科学实验：盐为什么让冰块融得更快？",
      hook: "同样两块冰，撒盐的那块为什么先化成水？",
      category: "education",
    });

    assert.match(plan.beats[0]?.searchQuery ?? "", /盐为什么让冰块融得更快/);
    assert.match(plan.beats[2]?.description ?? "", /科学实验：盐为什么让冰块融得更快/);
  });
});
