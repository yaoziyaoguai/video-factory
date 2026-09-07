import type {
  StudioCandidateFreshness,
  StudioCandidateRisk,
  StudioTopicCategory,
} from "../shared/api.js";

const CATEGORY_RULES: Array<[StudioTopicCategory, RegExp]> = [
  ["society", /台风|暴雨|地震|救灾|事故|伤亡|去世|逝世|病逝|死亡|身亡|遇难|失联|警方|民警|法院|获刑|索赔|不担责|枪杀|威胁|轰炸|公共安全|社会|空袭|战争|抗战|国家公祭|冲突|外交|制裁|绑架|遭绑|辱骂|诈骗|维权|食物中毒|国际关系|中东局势|民族情绪|扫黄|涉黄|沉没|落水|冲入|伊朗|以色列|叙利亚|政府党组|政府任职|政协|援.*装备.*牵制|对外军援/],
  ["education", /教育|学校|中学|小学|高校|高考|中考|考试|四六级|考研|公考|留学|大学|学生|新生|教师|作业|学习|校门/],
  ["parenting", /亲子|育儿|母婴|宝妈|宝宝|家庭教育|开学第一周|儿子|女儿|孩子|家长|父母|家庭关系/],
  ["automotive", /汽车|新车|新能源车|电动车|电动自行车|燃油车|智驾|车企|车展|通勤实测|充换电站|蔚来|比亚迪|特斯拉/],
  ["gaming", /游戏|电竞|手游|端游|主机|Steam|赛事开赛|烽火(?:职业)?联赛|玩家|英雄联盟|王者荣耀|和平精英|名人堂皮肤|游戏皮肤|圣枪|\b(?:LOL|LPL|KPL|Caps|BLG|TES|JDG|EDG|WBG|RNG|AL)\b/i],
  ["fashion-beauty", /时尚|穿搭|美妆|护肤|口红|防晒|香水|发型|潮流/],
  ["food", /美食|早餐|小吃|餐厅|菜谱|厨房|做饭|烘焙|咖啡|茶饮|排队攻略/],
  ["travel", /旅行|旅游|文旅|景区|酒店|民宿|高铁路线|出境游|周末路线|地铁|公交|公交车|航班|航班延误|机场|火车票|高铁票|12306|铁路出行/],
  ["agriculture-rural", /三农|农业|农机|麦归仓|粮食|丰收|乡村振兴|春耕|秋收|农田/],
  ["finance-career", /经济|消费|金融|股票|股市|基金|证券|银行|收益|房价|楼市|养老金|工资|职场|上班|下班|就业|求职|招聘|裁员|升职|加班|创业|供应链|营收|毛利率|净利润|同比|财报|成交量|资金回流|板块|战略合作|关税|加税|产能过剩|对华贸易/],
  ["technology", /\bAI\b|人工智能|机器人|模型|科技|芯片|半导体|处理器|存储|手机|平板|互联网|软件|开源|算法|核聚变|智能制造|中国智造|苹果|英特尔|小米|千问|豆包|飞书|阿里云|Token|Agent|iPhone|\bApp\b|PC端|华为|荣耀|OPPO|vivo|一加手机|大疆|3C认证|入网许可|型号核准|设备认证/i],
  ["health-sports", /健康|医疗|医生|医院|癌症|疫苗|减肥|碳水|油脂|湿热|运动|健身|比赛|冠军|奥运|男篮|女篮|足球|篮球|中超|英超|世锦赛|体育|球员|球队|网球|温网|澳网|法网|美网|郑钦文|辛纳|阿尔卡拉斯|德约|大满贯|\bWTA\b|\bATP\b|克莱|热火|湖人|勇士|\b(?:NBA|CBA)\b/i],
  ["local-culture", /县城|乡村|非遗|民俗|方言|地方|城市|夜市|老街|祠堂|宁夏|华人|港澳台/],
  ["entertainment", /电影|电视剧|综艺|明星|演员|导演|艺人|歌手|音乐|演唱会|动漫|影视|港片|票房|片单|本周看什么|部作品|假面骑士|复联|金晨|迪丽热巴/],
];

const PUBLIC_EVENT_CONTEXT = /警方|法院|检察院|政府|官方|部门|机构|医院|伤亡|受伤|死亡|遇难|失联|战争|空袭|轰炸|外交|国际冲突|中东局势|伊朗|以色列|叙利亚/;

export function classifyTopicCategory(title: string, track = "", evidenceKeywords: readonly string[] = []): StudioTopicCategory {
  const publicEventContext = PUBLIC_EVENT_CONTEXT.test(title);
  if (!publicEventContext && /亲子|孩子|父母|家庭关系/.test(title) && /冲突|沟通|回应|相处|情绪/.test(title)) return "parenting";
  if (!publicEventContext && /厨房|做饭/.test(title) && /如何|怎么|方法|教程|避免|预防|防止|检查/.test(title)) return "food";
  const titleCategory = matchCategoryRule(title);
  if (titleCategory) return titleCategory;
  // 编辑标题可能刻意抽象化；原始热点标题/证据关键词是更强的类别证据，缓存中的 category 只是派生值。
  const keywordCategory = matchCategoryRule(evidenceKeywords.join(" "));
  if (keywordCategory) return keywordCategory;
  return matchCategoryRule(track) ?? "lifestyle";
}

function matchCategoryRule(text: string): StudioTopicCategory | undefined {
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(text))?.[0];
}

export function topicRiskLevel(title: string): StudioCandidateRisk {
  const publicEventContext = PUBLIC_EVENT_CONTEXT.test(title);
  const interpersonalConflict = /亲子|孩子|家长|父母|家庭|同事|沟通|相处/.test(title) && !publicEventContext;
  const accidentPrevention = /厨房|做饭|居家/.test(title)
    && /如何|怎么|三步|方法|教程|避免|预防|防止|检查/.test(title)
    && !publicEventContext;
  let riskText = title;
  if (interpersonalConflict) riskText = riskText.replace(/冲突/g, "");
  if (accidentPrevention) riskText = riskText.replace(/事故/g, "");
  if (/伤亡|受伤|死亡|去世|逝世|病逝|身亡|遇难|地震|台风|暴雨|救灾|事故|战争|冲突|国际冲突|中东局势|枪杀|凶杀|绑架|遭绑|轰炸|空袭|恐袭|爆炸|自杀|威胁/.test(riskText)) return "high";
  if (/警方|法院|通报|外交|选举|制裁|抗战|国家公祭|医疗|疾病|癌症|疫苗|法律|法规|草案|违法|担责|索赔|不担责|诈骗|辱骂|食物中毒|维权|扫黄|涉黄|沉没|落水|冲入/.test(title)) return "review";
  return "low";
}

export function topicFreshness(collectedAt: string | undefined, now = new Date()): StudioCandidateFreshness {
  if (!collectedAt) return "evergreen";
  const age = now.getTime() - Date.parse(collectedAt);
  if (!Number.isFinite(age) || age < 0) return "today";
  if (age <= 3 * 60 * 60 * 1000) return "live";
  return age <= 30 * 60 * 60 * 1000 ? "today" : "evergreen";
}
