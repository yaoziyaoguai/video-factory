import type { StudioTopicCategory } from "./api.js";

export function inferVisualCategory(value: string): StudioTopicCategory {
  value = affirmativeTopicText(value);
  if (/亲子|育儿|母婴|家长|宝宝/.test(value)) return "parenting";
  if (/汽车|新车|新能源车|电动车|智驾|车企/.test(value)) return "automotive";
  if (/游戏|电竞|手游|主机|玩家/i.test(value)) return "gaming";
  if (/时尚|穿搭|美妆|护肤|口红|防晒/.test(value)) return "fashion-beauty";
  if (/美食|早餐|小吃|餐厅|菜谱|做饭|咖啡/.test(value)) return "food";
  if (/旅行|旅游|文旅|景区|酒店|民宿/.test(value)) return "travel";
  if (/三农|农业|农机|粮食|丰收|乡村振兴/.test(value)) return "agriculture-rural";
  const technologySubject = /\bAI\b|人工智能|科技|编程|算法|芯片|操作系统/i;
  const technologyTask = /(?:模型|软件|应用|手机|电脑).{0,24}(?:功能|权限|系统|设置|安装|配置|性能|操作|评测|开发)|(?:使用|操作|评测|安装|配置|开发).{0,16}(?:模型|软件|应用|手机|电脑)/;
  if (technologySubject.test(value) || technologyTask.test(value)) return "technology";
  if (/职场|工作|工资|就业|消费|财经|收入/.test(value)) return "finance-career";
  if (/比赛|体育|足球|篮球|训练|健康|运动|冠军|赛事|联赛|球队|TYL/i.test(value)) return "health-sports";
  if (/学校|学习|教育|考试|课程/.test(value)) return "education";
  if (/电影|音乐|明星|综艺|娱乐/.test(value)) return "entertainment";
  if (/城市|社区|文化|华人|街区|地方/.test(value)) return "local-culture";
  if (/警方|法院|通报|事故|伤亡|死亡|去世|逝世|病逝|身亡|遇难|社会|空袭|战争|冲突|外交|制裁/.test(value)) return "society";
  return "lifestyle";
}


function affirmativeTopicText(value: string): string {
  return value.split(/[，,。；;！？!?\n]|但是|而是|但要|但会/)
    .filter((clause) => !/(?:不(?:是|做|谈|讲|用|要|需|涉及|讨论|宣称|声称|承诺|保证)|无需|不要|不必|没有|拒绝|放下|远离)/.test(clause))
    .join(" ");
}
