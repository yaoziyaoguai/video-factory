// 平台标识是内部枚举值（guokr、ithome…），直接印给用户等于把采集口径暴露出去。
// 客户端和服务端各写过一份映射，客户端的 16 条对服务端的 4 条，两边不一致时
// 同一份证据会在两个界面上显示成不同的名字；这里合成唯一来源。
const PLATFORM_LABELS: Record<string, string> = {
  douyin: "抖音",
  kuaishou: "快手",
  xiaohongshu: "小红书",
  shipinhao: "视频号",
  bilibili: "哔哩哔哩",
  weibo: "微博",
  zhihu: "知乎",
  baidu: "百度",
  toutiao: "今日头条",
  thepaper: "澎湃新闻",
  "36kr": "36氪",
  ithome: "IT之家",
  sspai: "少数派",
  hupu: "虎扑",
  tieba: "百度贴吧",
  guokr: "果壳",
};

// manual 是用户自己补充的参考来源，不是任何外部榜单；未知平台也不能默认当“热榜”
// （DG-UX-02：把自己的输入或未知来源误标成热榜，用户无法判断哪些事实有依据）。
export function platformLabel(platform: string): string {
  if (platform === "manual") return "用户补充";
  return PLATFORM_LABELS[platform] ?? "其他来源";
}
