import { ProviderRegistry } from "./provider-registry.js";
import type {
  Artifact,
  ArtifactDraft,
  ArtifactKind,
  HumanDecisionDraft,
  HumanIntervention,
  HumanInterventionDraft,
  NodeDefinition,
  NodeExecutionResult,
  NodeRun,
  NodeStatus,
  Provider,
  ProviderSelector,
  QualityGateDefinition,
  QualityGateResult,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStatus,
} from "./types.js";

export interface WorkflowRunnerOptions {
  providers?: ProviderRegistry;
  clock?: () => string;
  idFactory?: (prefix: string) => string;
  checkpoint?: <TInitialInput>(run: WorkflowRun<TInitialInput>) => Promise<void> | void;
}

class InMemoryWorkflowContext<TInitialInput> implements WorkflowContext<TInitialInput> {
  constructor(
    readonly runId: string,
    readonly workflowId: string,
    readonly initialInput: TInitialInput,
    private readonly providers: ProviderRegistry,
    readonly now: () => string,
    readonly nextId: (prefix: string) => string,
    readonly artifacts: Artifact[] = [],
    readonly outputs: Map<string, unknown> = new Map<string, unknown>(),
  ) {}

  addArtifact<TData = unknown>(draft: ArtifactDraft<TData>): Artifact<TData> {
    const artifact: Artifact<TData> = {
      id: this.nextId("artifact"),
      kind: draft.kind,
      createdAt: this.now(),
      provenance: draft.provenance ?? {},
    };

    if ("data" in draft) {
      artifact.data = draft.data;
    }
    if (draft.uri) {
      artifact.uri = draft.uri;
    }
    if (draft.sha256) {
      artifact.sha256 = draft.sha256;
    }
    if (draft.sizeBytes !== undefined) {
      artifact.sizeBytes = draft.sizeBytes;
    }
    if (draft.contentType) {
      artifact.contentType = draft.contentType;
    }
    if (draft.schemaVersion) {
      artifact.schemaVersion = draft.schemaVersion;
    }
    if (draft.parentArtifactIds) {
      artifact.parentArtifactIds = [...draft.parentArtifactIds];
    }
    if (draft.producer) {
      artifact.producer = { ...draft.producer };
    }

    this.artifacts.push(artifact);
    return artifact;
  }

  findArtifacts(kind?: ArtifactKind): Artifact[] {
    return kind ? this.artifacts.filter((artifact) => artifact.kind === kind) : [...this.artifacts];
  }

  resolveProvider<TInput = unknown, TOutput = unknown>(selector: ProviderSelector): Provider<TInput, TOutput> {
    return this.providers.resolve<TInput, TOutput>(selector);
  }
}

export class WorkflowRunner {
  private readonly providers: ProviderRegistry;
  private readonly clock: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly checkpoint?: WorkflowRunnerOptions["checkpoint"];

  constructor(options: WorkflowRunnerOptions = {}) {
    this.providers = options.providers ?? new ProviderRegistry();
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? createIncrementingIdFactory();
    this.checkpoint = options.checkpoint;
  }

  async run<TInitialInput>(definition: WorkflowDefinition, initialInput: TInitialInput): Promise<WorkflowRun<TInitialInput>> {
    validateWorkflowDefinition(definition);

    const runId = this.idFactory("run");
    const context = new InMemoryWorkflowContext(
      runId,
      definition.id,
      initialInput,
      this.providers,
      this.clock,
      this.idFactory,
    );
    const run: WorkflowRun<TInitialInput> = {
      id: runId,
      revision: 0,
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: "running",
      initialInput,
      startedAt: this.clock(),
      nodeRuns: [],
      artifacts: context.artifacts,
      interventions: [],
      decisions: [],
    };

    await this.checkpoint?.(run);
    return this.continueRun(definition, run, context);
  }

  async resume<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    decision: HumanDecisionDraft,
  ): Promise<WorkflowRun<TInitialInput>> {
    validateWorkflowDefinition(definition);
    validateResumeRequest(definition, previousRun, decision);

    const run = cloneWorkflowRun(previousRun);
    const waitingNode = run.nodeRuns.find((nodeRun) => nodeRun.intervention?.id === decision.interventionId);
    if (!waitingNode) {
      throw new Error(`Unknown intervention '${decision.interventionId}'.`);
    }

    run.decisions.push({
      ...decision,
      id: this.idFactory("decision"),
      createdAt: this.clock(),
    });
    run.revision += 1;

    if (decision.action === "reject") {
      waitingNode.status = "rejected";
      waitingNode.finishedAt = this.clock();
      run.status = "rejected";
      run.finishedAt = this.clock();
      return run;
    }

    waitingNode.status = "succeeded";
    waitingNode.finishedAt = this.clock();
    run.status = "running";
    delete run.finishedAt;

    const outputs = new Map<string, unknown>();
    for (const nodeRun of run.nodeRuns) {
      if (nodeRun.status === "succeeded" && nodeRun.output !== undefined) {
        outputs.set(nodeRun.nodeId, nodeRun.output);
      }
    }
    const context = new InMemoryWorkflowContext(
      run.id,
      definition.id,
      run.initialInput,
      this.providers,
      this.clock,
      this.idFactory,
      run.artifacts,
      outputs,
    );

    return this.continueRun(definition, run, context);
  }

  private async continueRun<TInitialInput>(
    definition: WorkflowDefinition,
    run: WorkflowRun<TInitialInput>,
    context: InMemoryWorkflowContext<TInitialInput>,
  ): Promise<WorkflowRun<TInitialInput>> {
    const completedNodeIds = new Set(run.nodeRuns.map((nodeRun) => nodeRun.nodeId));

    for (const node of orderNodes(definition.nodes)) {
      if (completedNodeIds.has(node.id)) {
        continue;
      }

      const nodeRun = await this.runNode(
        node,
        context as InMemoryWorkflowContext<unknown>,
        async (runningNode) => {
          run.nodeRuns.push(runningNode);
          await this.checkpoint?.(run);
        },
      );

      if (nodeRun.output !== undefined) {
        context.outputs.set(node.id, nodeRun.output);
      }
      if (nodeRun.intervention) {
        run.interventions.push(nodeRun.intervention);
      }

      const terminalStatus = workflowStatusFromNode(nodeRun.status);
      if (terminalStatus) {
        run.status = terminalStatus;
        run.finishedAt = this.clock();
        await this.checkpoint?.(run);
        return run;
      }

      await this.checkpoint?.(run);
    }

    run.status = "succeeded";
    run.finishedAt = this.clock();
    await this.checkpoint?.(run);
    return run;
  }

  private async runNode<TInput, TOutput>(
    node: NodeDefinition<TInput, TOutput>,
    context: InMemoryWorkflowContext<unknown>,
    onStarted: (nodeRun: NodeRun<TOutput>) => Promise<void> | void,
  ): Promise<NodeRun<TOutput>> {
    const nodeRun: NodeRun<TOutput> = {
      nodeId: node.id,
      ...(node.role ? { role: node.role } : {}),
      status: "running",
      startedAt: context.now(),
      artifactIds: [],
      qualityGateResults: [],
    };

    await onStarted(nodeRun);

    try {
      const input = node.getInput ? node.getInput(context) : (context.initialInput as TInput);
      const result = await executeNode(node, input, context);

      for (const draft of result.artifacts ?? []) {
        const artifact = context.addArtifact(draft);
        nodeRun.artifactIds.push(artifact.id);
      }

      if (result.output !== undefined) {
        nodeRun.output = result.output;
      }

      const status = result.status ?? "succeeded";
      validateNodeResultStatus(node.id, status, result);
      if (status !== "succeeded") {
        nodeRun.status = status;
        if (result.error !== undefined) {
          nodeRun.error = result.error;
        }
        const intervention =
          result.status === "needs_human" ? createInterventionIfNeeded(node, result.intervention, context) : undefined;
        if (intervention) {
          nodeRun.intervention = intervention;
        }
        nodeRun.finishedAt = context.now();
        return nodeRun;
      }

      const gateResult = await evaluateQualityGates(node, context, result.output as TOutput);
      nodeRun.qualityGateResults = gateResult.results;
      if (gateResult.status !== "succeeded") {
        nodeRun.status = gateResult.status;
        if (gateResult.intervention) {
          nodeRun.intervention = gateResult.intervention;
        }
        nodeRun.finishedAt = context.now();
        return nodeRun;
      }

      nodeRun.status = "succeeded";
      nodeRun.finishedAt = context.now();
      return nodeRun;
    } catch (error) {
      nodeRun.status = "failed";
      nodeRun.error = error instanceof Error ? error.message : String(error);
      nodeRun.finishedAt = context.now();
      return nodeRun;
    }
  }
}

function validateResumeRequest<TInitialInput>(
  definition: WorkflowDefinition,
  run: WorkflowRun<TInitialInput>,
  decision: HumanDecisionDraft,
): void {
  if (run.workflowId !== definition.id || run.workflowVersion !== definition.version) {
    throw new Error("Workflow definition does not match the persisted run.");
  }
  if (run.status !== "needs_human") {
    throw new Error(`Run '${run.id}' is not waiting for human input.`);
  }
  if (!decision.actor.trim()) {
    throw new Error("Human decision actor is required.");
  }
  const waitingNode = run.nodeRuns.find((nodeRun) => nodeRun.status === "needs_human");
  if (waitingNode?.intervention?.id !== decision.interventionId) {
    throw new Error(`Intervention '${decision.interventionId}' is not active for run '${run.id}'.`);
  }
  const allowedActions = waitingNode.intervention.options ?? [waitingNode.intervention.requiredAction];
  if (!allowedActions.includes(decision.action)) {
    throw new Error(`Intervention '${decision.interventionId}' does not allow action '${decision.action}'.`);
  }
}

function cloneWorkflowRun<TInitialInput>(run: WorkflowRun<TInitialInput>): WorkflowRun<TInitialInput> {
  return {
    ...run,
    nodeRuns: run.nodeRuns.map((nodeRun) => {
      const clone: NodeRun = {
        ...nodeRun,
        artifactIds: [...nodeRun.artifactIds],
        qualityGateResults: nodeRun.qualityGateResults.map((result) => ({
          ...result,
          reasons: [...result.reasons],
        })),
      };
      if (nodeRun.intervention) {
        clone.intervention = { ...nodeRun.intervention };
      }
      return clone;
    }),
    artifacts: run.artifacts.map((artifact) => ({
      ...artifact,
      provenance: { ...artifact.provenance },
      ...(artifact.parentArtifactIds ? { parentArtifactIds: [...artifact.parentArtifactIds] } : {}),
      ...(artifact.producer ? { producer: { ...artifact.producer } } : {}),
    })),
    interventions: run.interventions.map((intervention) => ({ ...intervention })),
    decisions: run.decisions.map((decision) => ({ ...decision })),
  };
}

function createIncrementingIdFactory(): (prefix: string) => string {
  let next = 1;
  return (prefix: string) => `${prefix}-${next++}`;
}

async function executeNode<TInput, TOutput>(
  node: NodeDefinition<TInput, TOutput>,
  input: TInput,
  context: WorkflowContext,
): Promise<NodeExecutionResult<TOutput>> {
  if (node.execute) {
    return node.execute(input, context);
  }

  const selector = node.providerId
    ? { capability: node.capability, providerId: node.providerId }
    : { capability: node.capability };
  const provider = context.resolveProvider<TInput, TOutput>(selector);
  const output = await provider.run(input, context);
  return { status: "succeeded", output };
}

async function evaluateQualityGates<TOutput>(
  node: { id: string; qualityGates?: QualityGateDefinition<TOutput>[] },
  context: WorkflowContext,
  output: TOutput,
): Promise<{
  status: Extract<NodeStatus, "succeeded" | "needs_human" | "rejected">;
  results: QualityGateResult[];
  intervention?: HumanIntervention;
}> {
  const results: QualityGateResult[] = [];

  for (const gate of node.qualityGates ?? []) {
    const result = await gate.evaluate(context, output);
    results.push(result);

    if (result.status === "needs_human") {
      return {
        status: "needs_human",
        results,
        intervention: createIntervention(node.id, {
          reason: result.reasons.join(" "),
          requiredAction: "approve",
        }, context),
      };
    }

    if (result.status === "failed") {
      return { status: "rejected", results };
    }
  }

  return { status: "succeeded", results };
}

function createInterventionIfNeeded(
  node: { id: string },
  draft: HumanInterventionDraft | undefined,
  context: WorkflowContext,
): HumanIntervention | undefined {
  if (!draft) {
    return undefined;
  }

  return createIntervention(node.id, draft, context);
}

function createIntervention(
  nodeId: string,
  draft: HumanInterventionDraft,
  context: WorkflowContext,
): HumanIntervention {
  return {
    ...draft,
    id: context.nextId("intervention"),
    nodeId,
    createdAt: context.now(),
  };
}

function validateNodeResultStatus(
  nodeId: string,
  status: string,
  result: NodeExecutionResult<unknown>,
): void {
  if (status === "skipped") {
    throw new Error(
      `Node '${nodeId}' returned unsupported status 'skipped'. Conditional skip semantics are not implemented.`,
    );
  }

  if (status === "needs_human" && !("intervention" in result)) {
    throw new Error(`Node '${nodeId}' returned 'needs_human' without an intervention.`);
  }
}

function workflowStatusFromNode(status: NodeStatus): WorkflowStatus | undefined {
  if (status === "failed") {
    return "failed";
  }
  if (status === "needs_human") {
    return "needs_human";
  }
  if (status === "rejected") {
    return "rejected";
  }
  return undefined;
}

function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  if (!definition.nodes.length) {
    throw new Error("Workflow must contain at least one node.");
  }

  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) {
      throw new Error(`Duplicate node id '${node.id}'.`);
    }
    ids.add(node.id);
  }

  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`Node '${node.id}' depends on unknown node '${dependency}'.`);
      }
    }
  }
}

function orderNodes(nodes: NodeDefinition[]): NodeDefinition[] {
  const remaining = new Map(nodes.map((node) => [node.id, node]));
  const ordered: NodeDefinition[] = [];

  while (remaining.size > 0) {
    const ready = Array.from(remaining.values()).filter((node) =>
      (node.dependsOn ?? []).every((dependency) => !remaining.has(dependency)),
    );

    if (!ready.length) {
      throw new Error("Workflow contains a dependency cycle.");
    }

    for (const node of ready) {
      ordered.push(node);
      remaining.delete(node.id);
    }
  }

  return ordered;
}
