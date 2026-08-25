import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTopicCategory, topicRiskLevel } from "../src/server/topic-taxonomy.js";

describe("topic taxonomy", () => {
  it("classifies Chinese-world topics independently from their production track", () => {
    assert.equal(classifyTopicCategory("AI 模型开始进入普通人的工作流", "daily-observer"), "technology");
    assert.equal(classifyTopicCategory("养老金与就业政策出现新变化", "daily-observer"), "finance-career");
    assert.equal(classifyTopicCategory("台风暴雨期间应该核验哪些信息", "breaking-news"), "society");
    assert.equal(classifyTopicCategory("县城非遗夜市为什么重新走红", "local-journal"), "local-culture");
    assert.equal(classifyTopicCategory("男篮决赛有哪些关键回合", "sports-context"), "health-sports");
    assert.equal(classifyTopicCategory("四六级查分通道开放", "daily-observer"), "education");
    assert.equal(classifyTopicCategory("新生家长进校铺床引发讨论", "daily-observer"), "education");
    assert.equal(classifyTopicCategory("以军空袭叙利亚后局势如何变化", "breaking-news"), "society");
    assert.equal(classifyTopicCategory("全国政协副主席陈武逝世", "daily-observer"), "society");
  });

  it("marks sensitive claims for review without treating every current topic as high risk", () => {
    assert.equal(topicRiskLevel("地震伤亡数据仍在更新"), "high");
    assert.equal(topicRiskLevel("以色列黑手党头目遭枪杀"), "high");
    assert.equal(topicRiskLevel("中国女子泰国遭绑"), "high");
    assert.equal(topicRiskLevel("警方通报引发讨论"), "review");
    assert.equal(topicRiskLevel("店主被索赔是否担责"), "review");
    assert.equal(topicRiskLevel("为什么要往死里扫黄"), "review");
    assert.equal(topicRiskLevel("癌症疫苗来了"), "review");
    assert.equal(topicRiskLevel("自动驾驶违法由车企担责，修订草案提请审议"), "review");
    assert.equal(topicRiskLevel("全国政协副主席陈武逝世"), "high");
    assert.equal(topicRiskLevel("年轻人重新学习做饭"), "low");
  });

  it("keeps high-intent verticals separate instead of collapsing them into lifestyle", () => {
    assert.equal(classifyTopicCategory("亲子家庭如何安排开学第一周"), "parenting");
    assert.equal(classifyTopicCategory("新款新能源车城市通勤实测"), "automotive");
    assert.equal(classifyTopicCategory("国产游戏电竞赛事今日开赛"), "gaming");
    assert.equal(classifyTopicCategory("周末高铁文旅路线走红"), "travel");
    assert.equal(classifyTopicCategory("本地早餐小吃排队攻略"), "food");
    assert.equal(classifyTopicCategory("夏季防晒美妆新品测评"), "fashion-beauty");
    assert.equal(classifyTopicCategory("国产农机装备加快新装上阵"), "agriculture-rural");
    assert.equal(classifyTopicCategory("蔚来全国建成充换电站"), "automotive");
    assert.equal(classifyTopicCategory("不吃碳水就能减肥吗"), "health-sports");
    assert.equal(classifyTopicCategory("18名船员失联家属发声"), "society");
  });

  it("classifies ambiguous real feed titles by editorial intent instead of the first loose keyword", () => {
    assert.equal(classifyTopicCategory("中学施发型令：不合格不让进校门"), "education");
    assert.equal(classifyTopicCategory("Caps名人堂皮肤是小炮和发条"), "gaming");
    assert.equal(classifyTopicCategory("苹果官宣 iPhone 18 Pro 发布会"), "technology");
    assert.equal(classifyTopicCategory("英特尔至强处理器扩展至 256 核心"), "technology");
    assert.equal(classifyTopicCategory("涂鸦智能上半年营收同比增长"), "finance-career");
    assert.equal(classifyTopicCategory("中国女子泰国遭绑"), "society");
    assert.equal(classifyTopicCategory("伊朗获麦加协议邀请：国际关系新变量"), "society");
    assert.equal(classifyTopicCategory("可控核聚变还要等多久"), "technology");
    assert.equal(classifyTopicCategory("克莱加盟会为热火带来加强吗"), "health-sports");
    assert.equal(classifyTopicCategory("人情味，BLG力保圣枪赢AL"), "gaming");
    assert.equal(classifyTopicCategory("为什么要往死里扫黄"), "society");
    assert.equal(classifyTopicCategory("尚太科技：对下半年毛利率修复趋势持审慎乐观态度"), "finance-career");
    assert.equal(classifyTopicCategory("癌症疫苗来了"), "health-sports");
    assert.equal(classifyTopicCategory("中国三次拒绝申办2036奥运会"), "health-sports");
    assert.equal(classifyTopicCategory("千问App上线阿里云Token Plan接入功能"), "technology");
    assert.equal(classifyTopicCategory("本周看什么：最近值得一看的10部作品"), "entertainment");
    assert.equal(classifyTopicCategory("成交量和资金回流决定股市能否止跌"), "finance-career");
    assert.equal(classifyTopicCategory("豆包工作与飞书打通企业级 Agent"), "technology");
    assert.equal(classifyTopicCategory("万千气象瞰宁夏"), "local-culture");
    assert.equal(classifyTopicCategory("菲律宾一轮船海上沉没全过程曝光"), "society");
    assert.equal(classifyTopicCategory("车辆冲入西湖 一男一女从水中爬出"), "society");
    assert.equal(classifyTopicCategory("电动自行车时速限制拟上调为20公里"), "automotive");
    assert.equal(classifyTopicCategory("美方炒作产能过剩：或将对华加税7.5%"), "finance-career");
    assert.equal(classifyTopicCategory("金晨我不是迪丽热巴"), "entertainment");
    assert.equal(classifyTopicCategory("空枪成功复刻港片特色了吗"), "entertainment");
    assert.equal(topicRiskLevel("菲律宾一轮船海上沉没全过程曝光"), "review");
  });
});
