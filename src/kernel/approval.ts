/**
 * SPEC-004 §2 审批门。
 *
 * 「能改一切」必须配一个默认拒绝的闸门：安全默认值不能依赖调用方记得配置。
 */
export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalRequest {
  id: string;
  action: string;
  risk: RiskLevel;
  agentId: string;
  detail?: string;
}

export interface ApprovalRecord {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  source: 'policy' | 'allowlist' | 'default_deny';
  ts: string;
}

export type ApprovalPolicy = (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;

export class ApprovalGate {
  #policy: ApprovalPolicy | undefined;
  #allowlist = new Set<string>();
  #history: ApprovalRecord[] = [];

  constructor(options: { policy?: ApprovalPolicy } = {}) {
    this.#policy = options.policy;
  }

  get history(): ApprovalRecord[] {
    return [...this.#history];
  }

  isAllowed(action: string): boolean {
    return this.#allowlist.has(action);
  }

  /** 上一次决策（便于宿主与测试读取） */
  get last(): ApprovalRecord | undefined {
    return this.#history[this.#history.length - 1];
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    let decision: ApprovalDecision;
    let source: ApprovalRecord['source'];

    if (this.#allowlist.has(request.action)) {
      decision = 'allow_always';
      source = 'allowlist';
    } else if (this.#policy === undefined) {
      decision = 'deny';
      source = 'default_deny';
    } else {
      decision = await this.#policy(request);
      source = 'policy';
    }

    if (decision === 'allow_always') this.#allowlist.add(request.action);

    this.#history.push({ request, decision, source, ts: new Date().toISOString() });
    return decision;
  }
}
