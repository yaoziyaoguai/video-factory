// 契约 Error 载荷对应的服务端错误。所有 agent 路由的失败都走这里序列化，
// 不混入旧 Studio 的 {error: "..."} 结构。
export type AgentErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STALE_REVISION"
  | "IDEMPOTENCY_CONFLICT"
  | "DELIVERY_CLOSED"
  | "RUN_BUSY"
  | "AUTHORIZATION_REQUIRED"
  | "PROPOSAL_STALE"
  | "BUDGET_INSUFFICIENT"
  | "CAPABILITY_UNAVAILABLE"
  | "QUEUE_FULL"
  | "CURSOR_EXPIRED"
  | "REQUEST_NOT_RUNNING"
  | "TEMPORARILY_UNAVAILABLE"
  | "TARGET_SCOPE_MISMATCH";

const STATUS_BY_CODE: Record<AgentErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STALE_REVISION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DELIVERY_CLOSED: 409,
  RUN_BUSY: 409,
  AUTHORIZATION_REQUIRED: 403,
  PROPOSAL_STALE: 409,
  BUDGET_INSUFFICIENT: 503,
  CAPABILITY_UNAVAILABLE: 503,
  QUEUE_FULL: 429,
  CURSOR_EXPIRED: 410,
  REQUEST_NOT_RUNNING: 409,
  TEMPORARILY_UNAVAILABLE: 503,
  TARGET_SCOPE_MISMATCH: 409,
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly retryAction: "none" | "reauthenticate" | "reload" | "same_command" | "wait";
  readonly currentRevisionId: string | null;
  readonly requestIdField: string | null;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: {
      retryAction?: "none" | "reauthenticate" | "reload" | "same_command" | "wait";
      currentRevisionId?: string | null;
      requestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryAction = options.retryAction ?? defaultRetryAction(code);
    this.currentRevisionId = options.currentRevisionId ?? null;
    this.requestIdField = options.requestId ?? null;
  }

  get statusCode(): number {
    return STATUS_BY_CODE[this.code];
  }

  toPayload(): {
    code: AgentErrorCode;
    message: string;
    requestId: string | null;
    retryAction: string;
    currentRevisionId: string | null;
  } {
    return {
      code: this.code,
      message: this.message,
      requestId: this.requestIdField,
      retryAction: this.retryAction,
      currentRevisionId: this.currentRevisionId,
    };
  }
}

function defaultRetryAction(code: AgentErrorCode): "none" | "reauthenticate" | "reload" | "same_command" | "wait" {
  switch (code) {
    case "UNAUTHENTICATED":
      return "reauthenticate";
    case "CURSOR_EXPIRED":
      return "reload";
    case "IDEMPOTENCY_CONFLICT":
    case "STALE_REVISION":
    case "PROPOSAL_STALE":
    case "TARGET_SCOPE_MISMATCH":
    case "REQUEST_NOT_RUNNING":
    case "DELIVERY_CLOSED":
      return "none";
    case "QUEUE_FULL":
    case "TEMPORARILY_UNAVAILABLE":
      return "wait";
    case "BUDGET_INSUFFICIENT":
    case "CAPABILITY_UNAVAILABLE":
      return "none";
    default:
      return "none";
  }
}

// Pi 工具内部抛出的业务拒绝；SDK 会把 message 文本交给模型，测试据此断言错误码。
export class AgentToolError extends Error {
  readonly code: AgentErrorCode;
  readonly currentRevisionId: string | null;

  constructor(code: AgentErrorCode, message: string, currentRevisionId: string | null = null) {
    super(`${code}: ${message}`);
    this.name = "AgentToolError";
    this.code = code;
    this.currentRevisionId = currentRevisionId;
  }
}
