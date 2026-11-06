import type {
  RevisionRef, Target, ArtifactRevision, ToolDelivery, DeliveryReceipt,
  ToolPrepareProposal, Proposal, AcceptProposal, AdmissionReceipt,
  ExecutionInput, RecoveryQuery, ExecutionObservation,
  ToolReadProposal, ToolReadRun, ToolListProduction, ProductionIndexPage, Run,
  ToolSearchMaterials, MaterialSearchResult, ToolReadTrends, TrendReadResult,
  ToolImportMaterial, MaterialImportResult,
  ToolStartWork, ToolReadWork, ToolConfirmStage, ToolReadMaterialBatch, ToolRecordWorkFeedback,
  Work, MaterialBatch, FeedbackReceipt, ContentSource,
} from "./generated/contracts.js";

// read_work 的可读结果附带该事项相关意见（与 executor 上下文共用同一只读查询）；
// 公共 Work DTO 不携带意见库。artifact 意见带 target；消息原文内容意见带 work+contentSource。
export interface WorkFeedbackView {
  messageId: string;
  text: string;
  target: Target | null;
  workId: string | null;
  contentSource: ContentSource | null;
  applied: false;
  disposition: "noted" | "next_version";
}

export type WorkWithFeedback = Work & { relatedFeedback: WorkFeedbackView[] };

declare const requestContextBrand: unique symbol;
declare const userContextBrand: unique symbol;
declare const submitPermitBrand: unique symbol;

// 仅说明宿主内的调用边界。品牌类型不是权限证明；实现必须核对持久事实与当前 epoch。
export interface RequestContext {
  readonly [requestContextBrand]: true;
  readonly actorId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly executionEpoch: number;
  readonly toolCallId: string;
  readonly target: Readonly<Target> | null;
  /** 宿主注入的当前真实用户消息；steering 只有被原生接受后才更新，模型不能自选旧消息当本次授权。 */
  readonly actionSourceMessageId: string;
  /** 仅宿主从 SDK 原生恢复事件设置，不接受模型参数。 */
  readonly nativeRecovery?: boolean;
}

// 只由认证 HTTP 入口创建。普通 Pi 工具无法得到该上下文或批准接口。
export interface UserActionContext {
  readonly [userContextBrand]: true;
  readonly actorId: string;
  readonly actionId: string;
  readonly source: "proposal_button" | "bound_confirmation_message";
}

export interface PiBusinessTools {
  readArtifact(context: RequestContext, input: RevisionRef): Promise<ArtifactRevision>;
  deliverArtifacts(context: RequestContext, input: ToolDelivery): Promise<DeliveryReceipt>;
  prepareProduction(context: RequestContext, input: ToolPrepareProposal): Promise<Proposal>;
  // 三个窄只读查询：核对运行请求与会话归属，不产生业务写入。
  readProposal(context: RequestContext, input: ToolReadProposal): Promise<Proposal>;
  readRun(context: RequestContext, input: ToolReadRun): Promise<Run>;
  listProduction(context: RequestContext, input: ToolListProduction): Promise<ProductionIndexPage>;
  // T3 免费素材/资讯三工具：signal 接 Pi 回合中止（用户停止或回合超时取消网络流）。
  searchMaterials(context: RequestContext, input: ToolSearchMaterials, signal?: AbortSignal): Promise<MaterialSearchResult>;
  readTrends(context: RequestContext, input: ToolReadTrends, signal?: AbortSignal): Promise<TrendReadResult>;
  importMaterial(context: RequestContext, input: ToolImportMaterial, signal?: AbortSignal): Promise<MaterialImportResult>;
  // 视频创作事项：只在用户正式开始一条视频后建立；确认只记录普通认可，不能受理制作。
  startWork(context: RequestContext, input: ToolStartWork): Promise<Work>;
  readWork(context: RequestContext, input: ToolReadWork): Promise<WorkWithFeedback>;
  confirmStage(context: RequestContext, input: ToolConfirmStage): Promise<Work>;
  readMaterialBatch(context: RequestContext, input: ToolReadMaterialBatch): Promise<MaterialBatch>;
  recordWorkFeedback(context: RequestContext, input: ToolRecordWorkFeedback): Promise<FeedbackReceipt>;
}

export interface AdmissionService {
  acceptFromUser(context: UserActionContext, proposalId: string, input: AcceptProposal): Promise<AdmissionReceipt>;
}

// 只有持久创建边界核对成功后才签发；序列化/反序列化不能恢复它。
export interface SubmitPermit {
  readonly [submitPermitBrand]: true;
  readonly attemptId: string;
  readonly executionEpoch: number;
}

export interface MediaExecutionPort {
  // signal 中止当前进程内的渲染/HTTP/配音等待；不代表撤销已提交的供应商任务。
  submit(input: ExecutionInput, permit: SubmitPermit, signal?: AbortSignal): Promise<ExecutionObservation>;
  query(input: RecoveryQuery): Promise<ExecutionObservation>;
  cancel(input: RecoveryQuery): Promise<ExecutionObservation>;
  /** 终态但账务未核的尝试是否继续周期供应商查询。Ark 任务状态接口不是账单接口 → false；缺省 true（Faux）。 */
  readonly reconcileTerminalBilling?: boolean;
  /** 查询是否必须有供应商任务身份。为 true 时无 task ID 的 provider unknown 返回稳定未知，不再自动外查；缺省 false。 */
  readonly queryRequiresProviderTaskId?: boolean;
  /** 异步清理钩子；本地渲染须等待受控进程结束与效果收据落盘后 resolves。 */
  close?(): void | Promise<void>;
}

// submit/query/cancel 的结果只作为观测；ProductionService 才能事务性决定状态、费用和事件。
// 不在这一端口传 Authorization、API key、可执行脚本、任意路径或不受控 URL。
// RecoveryQuery 区分 provider/local；本地渲染不得借用上游媒体账户身份恢复。
