import { AlertCircle, Check, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { parseStudioSeriesInput, type StudioSeriesInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

interface SeriesDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: StudioSeriesInput) => Promise<void>;
}

export function SeriesDialog({ open, onClose, onSubmit }: SeriesDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, submitting);
  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const data = new FormData(event.currentTarget);
      const name = required(data, "name");
      await onSubmit(parseStudioSeriesInput({
        name,
        premise: required(data, "premise"),
        audience: required(data, "audience"),
        platform: valueOr(data, "platform", "douyin"),
        category: valueOr(data, "category", inferSeriesCategory(`${name} ${required(data, "premise")}`)),
        track: seriesTrack(name),
        pillars: [valueOr(data, "pillar1", "真实问题拆解"), valueOr(data, "pillar2", "方法与结果复盘")],
        tone: valueOr(data, "tone", "克制、具体、有结论"),
        visualStyle: valueOr(data, "visualStyle", "真实操作、人物反应与环境细节"),
        seasonTitle: valueOr(data, "seasonTitle", "第一季"),
        seasonArc: valueOr(data, "seasonArc", required(data, "premise")),
        planningPeriod: valueOr(data, "planningPeriod", currentQuarterLabel()),
        releaseCadence: valueOr(data, "releaseCadence", "weekly"),
        targetEpisodeCount: positiveInteger(data, "targetEpisodeCount", 12),
        continuityRules: lines(data, "continuityRules"),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section ref={dialogRef} className="run-dialog series-dialog" role="dialog" aria-modal="true" aria-labelledby="series-dialog-title" tabIndex={-1}>
        <header className="dialog-header">
          <div><p className="eyebrow">系列策划</p><h2 id="series-dialog-title">创建系列</h2><p>只填三项就能开始，系统会先补齐一套经济实用的制作默认值。</p></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} title="关闭"><X aria-hidden="true" size={19} /></button>
        </header>
        <form className="run-form series-form" onSubmit={submit}>
          <label className="field field-wide"><span>系列名称</span><input name="name" required data-dialog-initial-focus placeholder="例如：AI 下班实验室" /></label>
          <label className="field field-wide"><span>系列承诺</span><textarea name="premise" required rows={3} placeholder="每一集稳定为观众解决什么问题" /></label>
          <label className="field"><span>目标受众</span><input name="audience" required placeholder="最想持续服务的那群人" /></label>
          <details className="series-advanced field-wide">
            <summary><SlidersHorizontal aria-hidden="true" size={16} /><span><strong>更多设置</strong><small>本季篇章、连续性、内容支柱与视觉方向</small></span></summary>
            <div className="series-advanced-grid">
              <label className="field"><span>本季名称</span><input name="seasonTitle" defaultValue="第一季" /></label>
              <label className="field"><span>本季主线</span><input name="seasonArc" placeholder="这一季最终要带观众走到哪里" /></label>
              <label className="field"><span>计划周期</span><input name="planningPeriod" defaultValue={currentQuarterLabel()} placeholder="例如：2026 Q3" /></label>
              <label className="field"><span>更新频率</span><select name="releaseCadence" defaultValue="weekly"><option value="weekly">每周 1 集</option><option value="biweekly">每两周 1 集</option><option value="monthly">每月 1 集</option><option value="flexible">灵活更新</option></select></label>
              <label className="field"><span>本季目标集数</span><input name="targetEpisodeCount" type="number" min="1" max="100" defaultValue="12" /></label>
              <label className="field"><span>首发平台</span><select name="platform" defaultValue="douyin"><option value="douyin">抖音</option><option value="xiaohongshu">小红书</option><option value="bilibili">哔哩哔哩</option><option value="shipinhao">视频号</option></select></label>
              <label className="field"><span>内容分类</span><select name="category" defaultValue=""><option value="">自动判断</option><option value="technology">科技</option><option value="lifestyle">生活</option><option value="finance-career">财经职场</option><option value="society">社会</option><option value="health-sports">健康体育</option><option value="education">教育</option><option value="entertainment">文娱</option><option value="local-culture">华人地方</option><option value="food">美食</option><option value="travel">文旅出行</option><option value="gaming">游戏电竞</option><option value="automotive">汽车</option><option value="fashion-beauty">时尚美妆</option><option value="parenting">亲子家庭</option><option value="agriculture-rural">三农乡村</option></select></label>
              <label className="field"><span>表达语气</span><input name="tone" defaultValue="克制、具体、有结论" /></label>
              <label className="field"><span>内容支柱 1</span><input name="pillar1" defaultValue="真实问题拆解" /></label>
              <label className="field"><span>内容支柱 2</span><input name="pillar2" defaultValue="方法与结果复盘" /></label>
              <label className="field field-wide"><span>视觉方向</span><input name="visualStyle" defaultValue="真实操作、人物反应与环境细节" /></label>
              <label className="field field-wide"><span>连续性规则</span><textarea name="continuityRules" rows={3} placeholder={'每行一条，例如：每集必须承接上一集结论\n固定片头只保留 2 秒'} /></label>
            </div>
          </details>
          {error ? <p className="form-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          <footer className="dialog-actions">
            <button className="button button-ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="submit" disabled={submitting}><Check aria-hidden="true" size={17} />{submitting ? "正在创建..." : "创建系列"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function required(data: FormData, key: string): string {
  const value = data.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error("请完整填写系列定义。");
  return value.trim();
}

function valueOr(data: FormData, key: string, fallback: string): string {
  const value = data.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function lines(data: FormData, key: string): string[] {
  const value = data.get(key);
  return typeof value === "string"
    ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : [];
}

function positiveInteger(data: FormData, key: string, fallback: number): number {
  const value = Number(data.get(key));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function currentQuarterLabel(): string {
  const now = new Date();
  return `${now.getFullYear()} Q${Math.floor(now.getMonth() / 3) + 1}`;
}

function inferSeriesCategory(value: string): StudioSeriesInput["category"] {
  if (/亲子|育儿|母婴|家长|宝宝/.test(value)) return "parenting";
  if (/汽车|新车|新能源车|电动车|智驾/.test(value)) return "automotive";
  if (/游戏|电竞|手游|主机|玩家/i.test(value)) return "gaming";
  if (/时尚|穿搭|美妆|护肤|防晒/.test(value)) return "fashion-beauty";
  if (/美食|早餐|小吃|餐厅|菜谱|做饭/.test(value)) return "food";
  if (/旅行|旅游|文旅|景区|酒店|民宿/.test(value)) return "travel";
  if (/三农|农业|农机|粮食|丰收|乡村振兴/.test(value)) return "agriculture-rural";
  if (/\bAI\b|人工智能|模型|科技|软件|应用/i.test(value)) return "technology";
  if (/职场|工作|工资|就业|消费|财经/.test(value)) return "finance-career";
  if (/运动|健康|足球|篮球|训练/.test(value)) return "health-sports";
  if (/学习|教育|考试|课程/.test(value)) return "education";
  if (/电影|音乐|明星|综艺/.test(value)) return "entertainment";
  if (/城市|社区|文化|华人|地方/.test(value)) return "local-culture";
  if (/社会|新闻|公共|事件/.test(value)) return "society";
  return "lifestyle";
}

function seriesTrack(name: string): string {
  let hash = 2166136261;
  for (const character of name) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `series-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
