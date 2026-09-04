import { ProviderRegistry } from "./provider-registry.js";
import type {
  ApprovalPolicy,
  Artifact,
  ArtifactDraft,
  ArtifactKind,
  ExecutionConfigurationOverrideDraft,
  HumanDecisionDraft,
  HumanIntervention,
  HumanInterventionDraft,
  NodeDefinition,
  NodeExecutionReceipt,
  NodeExecutionReceiptDraft,
  NodeExecutionPlan,
  NodeExecutionReceiptStatus,
  NodeExecutionResult,
  NodeInputOverrideDraft,
  NodeOverrideDraft,
  NodeRevisionDraft,
  NodeRun,
  NodeStatus,
  Provider,
  ProviderSelector,
  QualityGateDefinition,
  QualityGateResult,
  SpendAuthorization,
  SpendAuthorizationDraft,
  SpendPlan,
  SpendQuote,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStatus,
} from "./types.js";

const MAX_MANUAL_VERSION_BYTES = 1_000_000;

export class NodeVersionConflictError extends Error {
  constructor(readonly nodeId: string, readonly expectedVersionId: string, readonly actualVersionId: string) {
    super(`Node '${nodeId}' effective version changed from '${expectedVersionId}' to '${actualVersionId}'.`);
    this.name = "NodeVersionConflictError";
  }
}

export interface WorkflowRunnerOptions {
  providers?: ProviderRegistry;
  clock?: () => string;
  idFactory?: (prefix: string) => string;
  checkpoint?: <TInitialInput>(run: WorkflowRun<TInitialInput>) => Promise<void> | void;
  shouldPause?: <TInitialInput>(run: WorkflowRun<TInitialInput>) => Promise<boolean> | boolean;
}

class InMemoryWorkflowContext<TInitialInput> implements WorkflowContext<TInitialInput> {
  readonly #providers: ProviderRegistry;
  readonly #publicContext: WorkflowContext<TInitialInput>;
  #activeSpendAuthorization: Readonly<SpendAuthorization> | undefined;
  #activeSpendAuthorizationExemptProviderId: string | undefined;
  #activeAutomaticMeteredProviderId: string | undefined;
  #activeOperationRequestId: string | undefined;
  #activeMeteredAttempts = 0;
  #activeMeteredAttemptObserver: ((attemptCount: number) => Promise<void> | void) | undefined;

  constructor(
    readonly runId: string,
    readonly workflowId: string,
    readonly initialInput: TInitialInput,
    providers: ProviderRegistry,
    readonly now: () => string,
    readonly nextId: (prefix: string) => string,
    readonly artifacts: Artifact[] = [],
    readonly outputs: Map<string, unknown> = new Map<string, unknown>(),
  ) {
    this.#providers = providers;
    const context = this;
    this.#publicContext = Object.freeze({
      get runId() { return context.runId; },
      get workflowId() { return context.workflowId; },
      get initialInput() { return context.initialInput; },
      get artifacts() { return context.artifacts; },
      get outputs() { return context.outputs; },
      get spendAuthorization() { return context.spendAuthorization; },
      get spendAuthorizationExemptProviderId() { return context.spendAuthorizationExemptProviderId; },
      get operationRequestId() { return context.operationRequestId; },
      now: () => context.now(),
      nextId: (prefix: string) => context.nextId(prefix),
      addArtifact: <TData = unknown>(draft: ArtifactDraft<TData>) => context.addArtifact(draft),
      findArtifacts: (kind?: ArtifactKind) => context.findArtifacts(kind),
      resolveProvider: <TInput = unknown, TOutput = unknown>(selector: ProviderSelector) =>
        context.resolveProvider<TInput, TOutput>(selector),
    });
  }

  publicContext(): WorkflowContext<TInitialInput> {
    return this.#publicContext;
  }

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
    const provider = this.#providers.resolve<TInput, TOutput>(selector);
    const safeContext = this.publicContext();
    if (provider.billing === "metered") {
      validateMeteredProvider(provider);
      const authorizationMatches = this.#activeSpendAuthorization
        && authorizationMatchesProvider(this.#activeSpendAuthorization, provider);
      const authorizationExempt = this.#activeSpendAuthorizationExemptProviderId === provider.id;
      const automaticExecutionAllowed = this.#activeAutomaticMeteredProviderId === provider.id;
      if (!authorizationMatches && !authorizationExempt && !automaticExecutionAllowed) {
        throw new Error(`Metered provider '${provider.id}' is outside the active spend authorization.`);
      }
      return bindProvider(provider, async (input) => {
          const activeAuthorization = this.#activeSpendAuthorization;
          if (!activeAuthorization || !authorizationMatchesProvider(activeAuthorization, provider)) {
            if (this.#activeSpendAuthorizationExemptProviderId === provider.id) return provider.run(input, safeContext);
            if (this.#activeAutomaticMeteredProviderId === provider.id) {
              if (this.#activeMeteredAttempts >= provider.maxAttempts) {
                throw new Error(`Metered provider '${provider.id}' exceeded the automatic attempt limit.`);
              }
              this.#activeMeteredAttempts += 1;
              await this.#activeMeteredAttemptObserver?.(this.#activeMeteredAttempts);
              return provider.run(input, safeContext);
            }
            throw new Error(`Metered provider '${provider.id}' is outside the active spend authorization.`);
          }
          if (this.#activeMeteredAttempts >= activeAuthorization.maxAttempts) {
            throw new Error(`Metered provider '${provider.id}' exceeded the authorized attempt limit.`);
          }
          this.#activeMeteredAttempts += 1;
          await this.#activeMeteredAttemptObserver?.(this.#activeMeteredAttempts);
          return provider.run(input, safeContext);
        });
    }
    return bindProvider(provider, (input) => provider.run(input, safeContext));
  }

  resolveProviderForNode<TInput = unknown, TOutput = unknown>(selector: ProviderSelector): Provider<TInput, TOutput> {
    return this.#providers.resolve<TInput, TOutput>(selector);
  }

  get spendAuthorization(): Readonly<SpendAuthorization> | undefined {
    return this.#activeSpendAuthorization;
  }

  get spendAuthorizationExemptProviderId(): string | undefined {
    return this.#activeSpendAuthorizationExemptProviderId;
  }

  get operationRequestId(): string | undefined {
    return this.#activeOperationRequestId;
  }

  async withSpendAuthorization<T>(
    authorization: Readonly<SpendAuthorization> | undefined,
    operationRequestId: string,
    execute: () => Promise<T>,
    onMeteredAttempt?: (attemptCount: number) => Promise<void> | void,
    spendAuthorizationExemptProviderId?: string,
    automaticMeteredProviderId?: string,
  ): Promise<T> {
    const previous = this.#activeSpendAuthorization;
    const previousExemptProviderId = this.#activeSpendAuthorizationExemptProviderId;
    const previousAutomaticProviderId = this.#activeAutomaticMeteredProviderId;
    const previousOperationRequestId = this.#activeOperationRequestId;
    const previousAttempts = this.#activeMeteredAttempts;
    const previousAttemptObserver = this.#activeMeteredAttemptObserver;
    this.#activeSpendAuthorization = authorization;
    this.#activeSpendAuthorizationExemptProviderId = spendAuthorizationExemptProviderId;
    this.#activeAutomaticMeteredProviderId = automaticMeteredProviderId;
    this.#activeOperationRequestId = operationRequestId;
    this.#activeMeteredAttempts = 0;
    this.#activeMeteredAttemptObserver = onMeteredAttempt;
    try {
      return await execute();
    } finally {
      this.#activeSpendAuthorization = previous;
      this.#activeSpendAuthorizationExemptProviderId = previousExemptProviderId;
      this.#activeAutomaticMeteredProviderId = previousAutomaticProviderId;
      this.#activeOperationRequestId = previousOperationRequestId;
      this.#activeMeteredAttempts = previousAttempts;
      this.#activeMeteredAttemptObserver = previousAttemptObserver;
    }
  }
}

function bindProvider<TInput, TOutput>(
  provider: Provider<TInput, TOutput>,
  run: Provider<TInput, TOutput>["run"],
): Provider<TInput, TOutput> {
  return {
    id: provider.id,
    capability: provider.capability,
    run,
    ...(provider.label !== undefined ? { label: provider.label } : {}),
    ...(provider.modelId !== undefined ? { modelId: provider.modelId } : {}),
    ...(provider.transport !== undefined ? { transport: provider.transport } : {}),
    ...(provider.billing !== undefined ? { billing: provider.billing } : {}),
    ...(provider.approvalPolicy !== undefined ? { approvalPolicy: provider.approvalPolicy } : {}),
    ...(provider.configurationSource !== undefined ? { configurationSource: provider.configurationSource } : {}),
    ...(provider.parameters !== undefined ? { parameters: cloneExecutionParameters(provider.parameters) } : {}),
    ...(provider.estimatedCostCny !== undefined ? { estimatedCostCny: provider.estimatedCostCny } : {}),
    ...(provider.maxCostCny !== undefined ? { maxCostCny: provider.maxCostCny } : {}),
    ...(provider.maxAttempts !== undefined ? { maxAttempts: provider.maxAttempts } : {}),
  };
}

export class WorkflowRunner {
  private readonly providers: ProviderRegistry;
  private readonly clock: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly checkpoint?: WorkflowRunnerOptions["checkpoint"];
  private readonly shouldPause?: WorkflowRunnerOptions["shouldPause"];

  constructor(options: WorkflowRunnerOptions = {}) {
    this.providers = options.providers ?? new ProviderRegistry();
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? createIncrementingIdFactory();
    this.checkpoint = options.checkpoint;
    this.shouldPause = options.shouldPause;
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
      executionPlan: createExecutionPlan(definition, context, "created"),
      artifacts: context.artifacts,
      interventions: [],
      decisions: [],
      spendAuthorizations: [],
    };

    await this.checkpoint?.(run);
    return this.continueRun(definition, run, context);
  }

  hydrateLegacyVersionStates<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    options: { allowVersionMismatch?: boolean } = {},
  ): WorkflowRun<TInitialInput> {
    validateWorkflowDefinition(definition);
    if (
      previousRun.workflowId !== definition.id
      || (!options.allowVersionMismatch && previousRun.workflowVersion !== definition.version)
    ) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    const run = cloneWorkflowRun(previousRun);
    const outputs = new Map<string, unknown>();
    for (const nodeRun of run.nodeRuns) {
      if (nodeRun.output !== undefined) outputs.set(nodeRun.nodeId, nodeRun.output);
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
    run.executionPlan ??= createExecutionPlan(definition, context as InMemoryWorkflowContext<unknown>, "reconstructed");
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    return run;
  }

  async resume<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    decision: HumanDecisionDraft,
  ): Promise<WorkflowRun<TInitialInput>> {
    validateWorkflowDefinition(definition);
    validateResumeRequest(definition, previousRun, decision);
    if (decision.action === "request_changes") {
      throw new Error("A request_changes decision must include a node revision.");
    }

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
    normalizeLegacyVersionStates(definition, run, context.publicContext());

    await this.checkpoint?.(run);
    return this.continueRun(definition, run, context);
  }

  applyNodeOverride<TInitialInput, TOutput = unknown>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    override: NodeOverrideDraft<TOutput>,
  ): WorkflowRun<TInitialInput> {
    validateWorkflowDefinition(definition);
    if (previousRun.workflowId !== definition.id || previousRun.workflowVersion !== definition.version) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    if (!override.actor.trim()) {
      throw new Error("Node override actor is required.");
    }
    if (
      (previousRun.status === "succeeded" || previousRun.status === "failed" || previousRun.status === "rejected")
      && override.allowTerminalEdit !== true
    ) {
      throw new Error(`Terminal run '${previousRun.id}' requires explicit confirmation before a node override.`);
    }
    const node = definition.nodes.find((candidate) => candidate.id === override.nodeId);
    const previousNodeRun = previousRun.nodeRuns.find((candidate) => candidate.nodeId === override.nodeId);
    if (!node || !previousNodeRun) {
      throw new Error(`Unknown completed node '${override.nodeId}'.`);
    }
    if (previousNodeRun.status === "running") {
      throw new Error(`Node '${override.nodeId}' cannot be overridden while it is running.`);
    }
    const descendants = descendantNodeIds(definition.nodes, override.nodeId);
    assertNoUncertainPaidOutcomeInvalidated(previousRun, new Set([override.nodeId, ...descendants]));

    const run = cloneWorkflowRun(previousRun);
    const nodeRun = run.nodeRuns.find((candidate) => candidate.nodeId === override.nodeId)!;
    const outputs = new Map<string, unknown>();
    for (const completed of run.nodeRuns) {
      if (completed.output !== undefined) {
        outputs.set(completed.nodeId, completed.output);
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
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    const outputState = nodeRun.outputState ?? createLegacyOutputState(node, nodeRun, run.nodeRuns);
    if (override.expectedVersionId && override.expectedVersionId !== outputState.effectiveVersionId) {
      throw new NodeVersionConflictError(node.id, override.expectedVersionId, outputState.effectiveVersionId);
    }
    const validatedOutput = override.output === undefined
      ? undefined
      : node.validateOverride
        ? node.validateOverride(override.output, context.publicContext())
        : override.output;
    assertManualVersionSize(validatedOutput, `${node.id} output`);
    const previousVersion = outputState.versions.find((candidate) => candidate.id === outputState.effectiveVersionId);
    assertFileReferenceChangesAuthorized(previousVersion?.output ?? nodeRun.output, validatedOutput, override.artifacts ?? []);
    const newArtifactIds = (override.artifacts ?? []).map((draft) => context.addArtifact(draft).id);
    const replacementKinds = new Set(
      newArtifactIds.map((artifactId) => run.artifacts.find((artifact) => artifact.id === artifactId)?.kind).filter(Boolean),
    );
    const inheritedArtifactIds = (previousVersion?.artifactIds ?? nodeRun.artifactIds)
      .filter((artifactId) => {
        const kind = run.artifacts.find((artifact) => artifact.id === artifactId)?.kind;
        return kind === undefined || !replacementKinds.has(kind);
      });
    const artifactIds = [...new Set([...inheritedArtifactIds, ...newArtifactIds])];
    const parentVersionId = outputState.effectiveVersionId;
    const versionId = context.nextId("version");
    const version = {
      id: versionId,
      nodeId: node.id,
      source: "human" as const,
      artifactIds,
      inputVersionIds: executionInputVersionIds(node, nodeRun, run.nodeRuns),
      parentVersionId,
      createdAt: context.now(),
      createdBy: override.actor,
      schemaVersion:
        override.schemaVersion
        ?? outputState.versions.find((candidate) => candidate.id === parentVersionId)?.schemaVersion
        ?? "1",
      ...(validatedOutput !== undefined ? { output: validatedOutput } : {}),
    };

    nodeRun.artifactIds = artifactIds;
    if (validatedOutput !== undefined) {
      nodeRun.output = validatedOutput;
    } else {
      delete nodeRun.output;
    }
    nodeRun.status = "succeeded";
    delete nodeRun.intervention;
    delete nodeRun.spendPlan;
    delete nodeRun.spendAuthorizationId;
    nodeRun.outputState = {
      ...outputState,
      effectiveVersionId: versionId,
      stale: false,
      versions: [...outputState.versions, version],
    };

    for (const descendant of run.nodeRuns) {
      if (!descendants.has(descendant.nodeId)) {
        continue;
      }
      descendant.status = "stale";
      delete descendant.intervention;
      delete descendant.spendPlan;
      delete descendant.spendAuthorizationId;
      delete descendant.operationRequestId;
      delete descendant.interrupted;
      if (descendant.outputState) {
        descendant.outputState.stale = true;
      }
      if (descendant.inputState) {
        descendant.inputState.stale = true;
      }
    }

    const invalidatedNodeIds = new Set([node.id, ...descendants]);
    run.interventions = run.interventions.filter((intervention) => !invalidatedNodeIds.has(intervention.nodeId));
    run.spendAuthorizations = (run.spendAuthorizations ?? [])
      .filter((authorization) => !invalidatedNodeIds.has(authorization.nodeId));

    run.revision += 1;
    const hasStaleNode = run.nodeRuns.some((candidate) => candidate.status === "stale"
      || candidate.inputState?.stale === true
      || candidate.outputState?.stale === true);
    if (hasStaleNode) {
      run.status = "stale";
      delete run.finishedAt;
    } else {
      run.status = "succeeded";
      run.finishedAt = this.clock();
    }
    return run;
  }

  applyNodeInputOverride<TInitialInput, TInput = unknown>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    override: NodeInputOverrideDraft<TInput>,
  ): WorkflowRun<TInitialInput> {
    validateWorkflowDefinition(definition);
    if (previousRun.workflowId !== definition.id || previousRun.workflowVersion !== definition.version) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    if (!override.actor.trim()) {
      throw new Error("Node input override actor is required.");
    }
    if (
      (previousRun.status === "succeeded" || previousRun.status === "failed" || previousRun.status === "rejected")
      && override.allowTerminalEdit !== true
    ) {
      throw new Error(`Terminal run '${previousRun.id}' requires explicit confirmation before a node input override.`);
    }

    const node = definition.nodes.find((candidate) => candidate.id === override.nodeId);
    const previousNodeRun = previousRun.nodeRuns.find((candidate) => candidate.nodeId === override.nodeId);
    if (!node || !previousNodeRun) {
      throw new Error(`Unknown started node '${override.nodeId}'.`);
    }
    if (previousNodeRun.status === "running") {
      throw new Error(`Node '${override.nodeId}' input cannot be overridden while it is running.`);
    }
    const descendants = descendantNodeIds(definition.nodes, override.nodeId);
    assertNoUncertainPaidOutcomeInvalidated(previousRun, new Set([override.nodeId, ...descendants]));

    const run = cloneWorkflowRun(previousRun);
    const nodeRun = run.nodeRuns.find((candidate) => candidate.nodeId === override.nodeId)!;
    const outputs = new Map<string, unknown>();
    for (const completed of run.nodeRuns) {
      if (completed.output !== undefined) outputs.set(completed.nodeId, completed.output);
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
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    const previousInputState = nodeRun.inputState;
    if (!previousInputState) throw new Error(`Node '${node.id}' has no editable input version.`);
    if (override.expectedVersionId && override.expectedVersionId !== previousInputState.effectiveVersionId) {
      throw new NodeVersionConflictError(node.id, override.expectedVersionId, previousInputState.effectiveVersionId);
    }
    assertManualVersionSize(override.input, `${node.id} input`);
    const validatedInput = node.validateInputOverride
      ? node.validateInputOverride(override.input, context.publicContext())
      : override.input;
    assertManualVersionSize(validatedInput, `${node.id} input`);
    const previousInput = previousInputState.versions.find(
      (candidate) => candidate.id === previousInputState.effectiveVersionId,
    )?.value;
    assertFileReferenceChangesAuthorized(previousInput, validatedInput, []);
    const upstreamVersionIds = inputVersionIdsForNode(node, run.nodeRuns);
    const parentVersionId = previousInputState?.effectiveVersionId;
    const versionId = context.nextId("input-version");
    const version = {
      id: versionId,
      nodeId: node.id,
      source: "human" as const,
      value: validatedInput,
      upstreamVersionIds,
      ...(parentVersionId ? { parentVersionId } : {}),
      createdAt: context.now(),
      createdBy: override.actor,
      schemaVersion:
        override.schemaVersion
        ?? previousInputState?.versions.find((candidate) => candidate.id === parentVersionId)?.schemaVersion
        ?? "1",
    };
    nodeRun.inputState = {
      nodeId: node.id,
      effectiveVersionId: versionId,
      stale: false,
      versions: [...(previousInputState?.versions ?? []), version],
    };
    nodeRun.status = "stale";
    delete nodeRun.intervention;
    delete nodeRun.spendPlan;
    delete nodeRun.spendAuthorizationId;
    delete nodeRun.operationRequestId;
    delete nodeRun.interrupted;
    if (nodeRun.outputState) nodeRun.outputState.stale = true;

    for (const descendant of run.nodeRuns) {
      if (!descendants.has(descendant.nodeId)) continue;
      descendant.status = "stale";
      delete descendant.intervention;
      delete descendant.spendPlan;
      delete descendant.spendAuthorizationId;
      delete descendant.operationRequestId;
      delete descendant.interrupted;
      if (descendant.outputState) descendant.outputState.stale = true;
      if (descendant.inputState) descendant.inputState.stale = true;
    }

    const invalidatedNodeIds = new Set([node.id, ...descendants]);
    run.interventions = run.interventions.filter((intervention) => !invalidatedNodeIds.has(intervention.nodeId));
    run.spendAuthorizations = (run.spendAuthorizations ?? [])
      .filter((authorization) => !invalidatedNodeIds.has(authorization.nodeId));
    run.revision += 1;
    run.status = "stale";
    delete run.finishedAt;
    return run;
  }

  applyNodeRevision<TInitialInput, TOutput = unknown>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    revision: NodeRevisionDraft<TOutput>,
  ): WorkflowRun<TInitialInput> {
    validateResumeRequest(definition, previousRun, revision.decision);
    if (revision.decision.action !== "request_changes") {
      throw new Error("Node revision must use a request_changes decision.");
    }
    if (!revision.expectedVersionId?.trim()) {
      throw new Error("Node revision must include the expected current output version.");
    }
    if (revision.decision.actor !== revision.actor) {
      throw new Error("Node revision actor must match the human decision actor.");
    }
    const descendants = descendantNodeIds(definition.nodes, revision.nodeId);
    const invalidatedNodeIds = new Set(revision.invalidateDescendantNodeIds);
    for (const nodeId of invalidatedNodeIds) {
      if (!descendants.has(nodeId)) {
        throw new Error(`Node revision can only invalidate descendants of '${revision.nodeId}'.`);
      }
      for (const descendantId of descendantNodeIds(definition.nodes, nodeId)) {
        if (!invalidatedNodeIds.has(descendantId)) {
          throw new Error(`Node revision invalidation must include descendant '${descendantId}'.`);
        }
      }
    }
    const waitingNode = previousRun.nodeRuns.find(
      (nodeRun) => nodeRun.intervention?.id === revision.decision.interventionId,
    );
    if (!waitingNode || !invalidatedNodeIds.has(waitingNode.nodeId)) {
      throw new Error("Node revision must invalidate the node with the active intervention.");
    }
    const revisedNode = previousRun.nodeRuns.find((nodeRun) => nodeRun.nodeId === revision.nodeId);
    const currentVersion = revisedNode?.outputState?.versions.find(
      (version) => version.id === revisedNode.outputState?.effectiveVersionId,
    );
    if (!currentVersion) {
      throw new Error(`Node revision '${revision.nodeId}' has no current output version.`);
    }
    for (const artifactId of revision.retainedArtifactIds) {
      if (!currentVersion.artifactIds.includes(artifactId)) {
        throw new Error(`Node revision cannot retain non-current artifact '${artifactId}'.`);
      }
    }

    const run = this.applyNodeOverride(definition, previousRun, revision);
    const previousArtifactIds = new Set(previousRun.artifacts.map((artifact) => artifact.id));
    const newArtifactIds = run.artifacts
      .filter((artifact) => !previousArtifactIds.has(artifact.id))
      .map((artifact) => artifact.id);
    const revisedNodeRun = run.nodeRuns.find((nodeRun) => nodeRun.nodeId === revision.nodeId)!;
    const revisedVersion = revisedNodeRun.outputState?.versions.find(
      (version) => version.id === revisedNodeRun.outputState?.effectiveVersionId,
    );
    if (!revisedVersion) {
      throw new Error(`Node revision '${revision.nodeId}' did not create an output version.`);
    }
    const exactArtifactIds = [...new Set([...revision.retainedArtifactIds, ...newArtifactIds])];
    revisedVersion.artifactIds = exactArtifactIds;
    revisedNodeRun.artifactIds = exactArtifactIds;

    // 返修可保留不受内容影响的昂贵产物；只有调用方明确列出的后代才会重新执行。
    const preservedNodeIds = new Set([...descendants].filter((nodeId) => !invalidatedNodeIds.has(nodeId)));
    const previousClone = cloneWorkflowRun(previousRun);
    run.nodeRuns = run.nodeRuns.map((nodeRun) => {
      if (!preservedNodeIds.has(nodeRun.nodeId)) return nodeRun;
      return previousClone.nodeRuns.find((candidate) => candidate.nodeId === nodeRun.nodeId)!;
    });
    run.interventions.push(
      ...previousClone.interventions.filter((intervention) => preservedNodeIds.has(intervention.nodeId)),
    );
    run.spendAuthorizations = [
      ...(run.spendAuthorizations ?? []),
      ...(previousClone.spendAuthorizations ?? []).filter(
        (authorization) => preservedNodeIds.has(authorization.nodeId),
      ),
    ];
    run.decisions.push({
      ...revision.decision,
      id: this.idFactory("decision"),
      createdAt: this.clock(),
    });
    return run;
  }

  applyExecutionConfigurationOverride<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    override: ExecutionConfigurationOverrideDraft<TInitialInput>,
  ): WorkflowRun<TInitialInput> {
    validateWorkflowDefinition(definition);
    if (previousRun.workflowId !== definition.id || previousRun.workflowVersion !== definition.version) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    if (!override.actor.trim()) throw new Error("Execution configuration override actor is required.");
    if (previousRun.status === "running") {
      throw new Error(`Run '${previousRun.id}' must be paused before changing execution configuration.`);
    }
    const node = definition.nodes.find((candidate) => candidate.id === override.nodeId);
    if (!node) throw new Error(`Unknown workflow node '${override.nodeId}'.`);
    const previousNodeRun = previousRun.nodeRuns.find((candidate) => candidate.nodeId === override.nodeId);
    if (previousNodeRun?.status === "running") {
      throw new Error(`Node '${override.nodeId}' execution configuration cannot change while it is running.`);
    }
    if (previousNodeRun?.outcomeUncertain) {
      throw new Error(`Node '${override.nodeId}' has an uncertain paid-provider outcome and cannot be reconfigured.`);
    }
    const descendants = descendantNodeIds(definition.nodes, override.nodeId);
    assertNoUncertainPaidOutcomeInvalidated(previousRun, new Set([override.nodeId, ...descendants]));

    const run = cloneWorkflowRun(previousRun);
    run.initialInput = structuredClone(override.initialInput);
    const target = run.nodeRuns.find((candidate) => candidate.nodeId === override.nodeId);
    const invalidatedNodeIds = new Set([override.nodeId, ...descendants]);

    if (target) markNodeExecutionStale(target, false);
    for (const candidate of run.nodeRuns) {
      if (descendants.has(candidate.nodeId)) markNodeExecutionStale(candidate, true);
    }
    run.interventions = run.interventions.filter((intervention) => !invalidatedNodeIds.has(intervention.nodeId));
    run.spendAuthorizations = (run.spendAuthorizations ?? [])
      .filter((authorization) => !invalidatedNodeIds.has(authorization.nodeId));

    const outputs = new Map<string, unknown>();
    for (const candidate of run.nodeRuns) {
      if (candidate.status === "succeeded" && candidate.output !== undefined) outputs.set(candidate.nodeId, candidate.output);
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
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    run.executionPlan = refreshMutableExecutionPlan(definition, run, context as InMemoryWorkflowContext<unknown>);
    run.revision += 1;
    if (target) {
      run.status = "stale";
      delete run.finishedAt;
    }
    return run;
  }

  async authorizeSpend<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    draft: SpendAuthorizationDraft,
  ): Promise<WorkflowRun<TInitialInput>> {
    validateWorkflowDefinition(definition);
    if (previousRun.workflowId !== definition.id || previousRun.workflowVersion !== definition.version) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    if (
      previousRun.status !== "awaiting_spend_approval"
      && previousRun.status !== "approval_invalidated"
    ) {
      throw new Error(`Run '${previousRun.id}' is not waiting for spend approval.`);
    }
    validateSpendAuthorizationDraft(draft);
    if (!draft.approvedBy.trim()) {
      throw new Error("Spend authorization approver is required.");
    }

    const run = cloneWorkflowRun(previousRun);
    const waitingNode = run.nodeRuns.find((nodeRun) => nodeRun.nodeId === draft.nodeId);
    const node = definition.nodes.find((candidate) => candidate.id === draft.nodeId);
    if (
      !waitingNode?.spendPlan
      || !node
      || !["awaiting_spend_approval", "approval_invalidated"].includes(waitingNode.status)
    ) {
      throw new Error(`Node '${draft.nodeId}' is not awaiting spend approval.`);
    }

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
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    const provider = resolveNodeProvider(node, context);
    const upstreamVersionIds = inputVersionIdsForNode(node, run.nodeRuns);
    const publicContext = context.publicContext();
    const derivedInput = node.getInput ? node.getInput(publicContext) : (run.initialInput as unknown);
    const input = resolveEffectiveNodeInput(node, waitingNode, derivedInput, upstreamVersionIds, publicContext);
    const inputVersionIds = executionInputVersionIdsFromUpstream(waitingNode, upstreamVersionIds);
    if (!provider || provider.billing !== "metered") {
      throw new Error(`Node '${draft.nodeId}' no longer resolves to a metered provider.`);
    }
    if (approvalPolicyFor(provider) !== "manual") {
      throw new Error(`Node '${draft.nodeId}' no longer requires manual spend approval.`);
    }
    validateMeteredProvider(provider);
    const quote = await resolveSpendQuote(provider, input, publicContext);
    if (!spendPlanMatchesExecution(waitingNode.spendPlan, node, provider, quote, inputVersionIds)) {
      waitingNode.spendPlan = createSpendPlan(node, provider, quote, inputVersionIds, publicContext);
      waitingNode.status = "approval_invalidated";
      delete waitingNode.spendAuthorizationId;
      run.revision += 1;
      run.status = "approval_invalidated";
      delete run.finishedAt;
      return run;
    }
    if (!authorizationMatchesPlan(draft, waitingNode.spendPlan)) {
      throw new Error(`Spend authorization does not match the active plan for node '${draft.nodeId}'.`);
    }

    const authorization: SpendAuthorization = {
      ...draft,
      inputVersionIds: [...draft.inputVersionIds],
      id: this.idFactory("spend-authorization"),
      approvedAt: this.clock(),
    };
    (run.spendAuthorizations ??= []).push(authorization);
    waitingNode.spendAuthorizationId = authorization.id;
    waitingNode.status = "pending";
    delete waitingNode.finishedAt;
    run.revision += 1;
    run.status = "running";
    delete run.finishedAt;
    await this.checkpoint?.(run);
    return this.continueRun(definition, run, context);
  }

  async resumeStale<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
  ): Promise<WorkflowRun<TInitialInput>> {
    validateWorkflowDefinition(definition);
    if (previousRun.workflowId !== definition.id || previousRun.workflowVersion !== definition.version) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    if (previousRun.status !== "stale") {
      throw new Error(`Run '${previousRun.id}' has no stale nodes to regenerate.`);
    }
    const uncertainNode = previousRun.nodeRuns.find((nodeRun) => nodeRun.status === "stale" && nodeRun.outcomeUncertain);
    if (uncertainNode) {
      throw new Error(`Node '${uncertainNode.nodeId}' has an uncertain paid-provider outcome and cannot be regenerated before reconciliation.`);
    }
    const run = cloneWorkflowRun(previousRun);
    for (const nodeRun of run.nodeRuns) {
      if (nodeRun.status === "stale" && nodeRun.outputState?.stale) {
        const effectiveOutput = nodeRun.outputState.versions.find(
          (version) => version.id === nodeRun.outputState?.effectiveVersionId,
        );
        if (effectiveOutput?.source === "human") {
          throw new Error(
            `Node '${nodeRun.nodeId}' has a stale human output that must be reviewed and saved again or explicitly discarded before regeneration.`,
          );
        }
      }
      if (nodeRun.status !== "stale" || !nodeRun.inputState?.stale) continue;
      const effectiveInput = nodeRun.inputState.versions.find(
        (version) => version.id === nodeRun.inputState?.effectiveVersionId,
      );
      if (effectiveInput?.source === "human") {
        throw new Error(
          `Node '${nodeRun.nodeId}' has a stale human input that must be reviewed and saved again before regeneration.`,
        );
      }
    }
    const outputs = new Map<string, unknown>();
    for (const nodeRun of run.nodeRuns) {
      if (nodeRun.status === "stale") {
        nodeRun.status = "pending";
        nodeRun.artifactIds = [];
        nodeRun.qualityGateResults = [];
        delete nodeRun.output;
        delete nodeRun.finishedAt;
        delete nodeRun.error;
        delete nodeRun.intervention;
        delete nodeRun.executionReceipt;
        delete nodeRun.spendPlan;
        delete nodeRun.spendAuthorizationId;
        delete nodeRun.operationRequestId;
        delete nodeRun.interrupted;
      } else if (nodeRun.status === "succeeded" && nodeRun.output !== undefined) {
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
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    run.revision += 1;
    run.status = "running";
    delete run.finishedAt;
    await this.checkpoint?.(run);
    return this.continueRun(definition, run, context);
  }

  async resumePaused<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
  ): Promise<WorkflowRun<TInitialInput>> {
    validateWorkflowDefinition(definition);
    if (previousRun.workflowId !== definition.id || previousRun.workflowVersion !== definition.version) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    if (previousRun.status !== "paused") {
      throw new Error(`Run '${previousRun.id}' is not paused.`);
    }
    const run = cloneWorkflowRun(previousRun);
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
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    run.revision += 1;
    run.status = "running";
    delete run.finishedAt;
    await this.checkpoint?.(run);
    return this.continueRun(definition, run, context);
  }

  async retryFailedNode<TInitialInput>(
    definition: WorkflowDefinition,
    previousRun: WorkflowRun<TInitialInput>,
    nodeId: string,
    options: { resumeUncertainOperation?: boolean } = {},
  ): Promise<WorkflowRun<TInitialInput>> {
    validateWorkflowDefinition(definition);
    if (previousRun.workflowId !== definition.id || previousRun.workflowVersion !== definition.version) {
      throw new Error("Workflow definition does not match the persisted run.");
    }
    if (previousRun.status !== "failed") {
      throw new Error(`Run '${previousRun.id}' is not failed.`);
    }
    const failedNode = previousRun.nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId);
    if (!failedNode || failedNode.status !== "failed" || !definition.nodes.some((node) => node.id === nodeId)) {
      throw new Error(`Node '${nodeId}' is not the failed node.`);
    }
    if (options.resumeUncertainOperation && !(
      failedNode.outcomeUncertain
      && failedNode.interrupted
      && failedNode.operationRequestId
    )) {
      throw new Error(`Node '${nodeId}' is not an interrupted uncertain operation that can be resumed.`);
    }
    if (failedNode.outcomeUncertain && !options.resumeUncertainOperation) {
      throw new Error(`Node '${nodeId}' has an uncertain paid-provider outcome and cannot be retried before reconciliation.`);
    }

    const run = cloneWorkflowRun(previousRun);
    const retryNode = run.nodeRuns.find((nodeRun) => nodeRun.nodeId === nodeId)!;
    retryNode.status = "pending";
    const preserveInterruptedOperation = retryNode.interrupted === true;
    retryNode.artifactIds = [];
    retryNode.qualityGateResults = [];
    delete retryNode.output;
    delete retryNode.finishedAt;
    delete retryNode.error;
    delete retryNode.intervention;
    delete retryNode.executionReceipt;
    delete retryNode.spendPlan;
    if (retryNode.spendAuthorizationId) {
      const consumed = (run.consumedSpendAuthorizationIds ??= []);
      if (!consumed.includes(retryNode.spendAuthorizationId)) consumed.push(retryNode.spendAuthorizationId);
    }
    delete retryNode.spendAuthorizationId;
    if (!preserveInterruptedOperation) delete retryNode.interrupted;
    if (!preserveInterruptedOperation) delete retryNode.operationRequestId;
    if (retryNode.outputState) retryNode.outputState.stale = true;

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
    normalizeLegacyVersionStates(definition, run, context.publicContext());
    run.revision += 1;
    run.status = "running";
    delete run.finishedAt;
    await this.checkpoint?.(run);
    return this.continueRun(definition, run, context);
  }

  private async continueRun<TInitialInput>(
    definition: WorkflowDefinition,
    run: WorkflowRun<TInitialInput>,
    context: InMemoryWorkflowContext<TInitialInput>,
  ): Promise<WorkflowRun<TInitialInput>> {
    if (run.nodeRuns.length > 0) {
      run.executionPlan = refreshMutableExecutionPlan(
        definition,
        run,
        context as InMemoryWorkflowContext<unknown>,
      );
    }
    for (const node of orderNodes(definition.nodes)) {
      const existingNodeRun = run.nodeRuns.find((nodeRun) => nodeRun.nodeId === node.id);
      if (existingNodeRun && existingNodeRun.status !== "pending") {
        continue;
      }

      const nodeRun = await this.runNode(
        node,
        context as InMemoryWorkflowContext<unknown>,
        inputVersionIdsForNode(node, run.nodeRuns),
        run.spendAuthorizations ?? [],
        new Set([
          ...(run.consumedSpendAuthorizationIds ?? []),
          ...(run.executionReceipts ?? []).flatMap((receipt) => receipt.spendAuthorizationId ? [receipt.spendAuthorizationId] : []),
        ]),
        existingNodeRun,
        async (runningNode) => {
          if (!existingNodeRun && !run.nodeRuns.some((candidate) => candidate.nodeId === runningNode.nodeId)) {
            run.nodeRuns.push(runningNode);
          }
          if (runningNode.outcomeUncertain && runningNode.spendAuthorizationId) {
            const consumed = (run.consumedSpendAuthorizationIds ??= []);
            if (!consumed.includes(runningNode.spendAuthorizationId)) consumed.push(runningNode.spendAuthorizationId);
          }
          await this.checkpoint?.(run);
        },
      );

      if (nodeRun.output !== undefined) {
        context.outputs.set(node.id, nodeRun.output);
      }
      if (nodeRun.executionReceipt) {
        const receipts = (run.executionReceipts ??= []);
        const existingReceiptIndex = nodeRun.executionReceipt.requestId
          ? receipts.findIndex((candidate) => (
              candidate.nodeId === nodeRun.nodeId
              && candidate.requestId === nodeRun.executionReceipt?.requestId
            ))
          : -1;
        if (existingReceiptIndex >= 0) {
          receipts[existingReceiptIndex] = mergeExecutionReceiptForSameRequest(
            receipts[existingReceiptIndex]!,
            nodeRun.executionReceipt,
          );
        } else {
          receipts.push(cloneExecutionReceipt(nodeRun.executionReceipt));
        }
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
      if (await this.shouldPause?.(run)) {
        run.status = "paused";
        delete run.finishedAt;
        await this.checkpoint?.(run);
        return run;
      }
    }

    run.status = "succeeded";
    run.finishedAt = this.clock();
    await this.checkpoint?.(run);
    return run;
  }

  private async runNode<TInput, TOutput>(
    node: NodeDefinition<TInput, TOutput>,
    context: InMemoryWorkflowContext<unknown>,
    upstreamVersionIds: string[],
    spendAuthorizations: readonly SpendAuthorization[],
    consumedSpendAuthorizationIds: ReadonlySet<string>,
    existingNodeRun: NodeRun<TOutput> | undefined,
    onStarted: (nodeRun: NodeRun<TOutput>) => Promise<void> | void,
  ): Promise<NodeRun<TOutput>> {
    const nodeRun: NodeRun<TOutput> = existingNodeRun ?? {
      nodeId: node.id,
      ...(node.role ? { role: node.role } : {}),
      status: "pending",
      startedAt: context.now(),
      artifactIds: [],
      qualityGateResults: [],
    };
    nodeRun.status = "running";
    nodeRun.startedAt = context.now();
    nodeRun.operationRequestId ??= context.nextId(`${context.runId}-${node.id}-operation`);
    const resumingInterruptedOperation = nodeRun.interrupted === true;
    delete nodeRun.interrupted;

    await onStarted(nodeRun);

    let receiptDraft = inlineReceiptDraft(node);
    let authorization: SpendAuthorization | undefined;
    let meteredAttemptCount = 0;
    let spendAuthorizationExemptProviderId: string | undefined;
    let automaticMeteredProvider: Pick<Provider, "id" | "modelId"> | undefined;
    let resumingInterruptedMeteredOperation = false;
    try {
      const publicContext = context.publicContext();
      const derivedInput = node.getInput ? node.getInput(publicContext) : (context.initialInput as TInput);
      const input = resolveEffectiveNodeInput(node, nodeRun, derivedInput, upstreamVersionIds, publicContext);
      const inputVersionIds = executionInputVersionIdsFromUpstream(nodeRun, upstreamVersionIds);
      const provider = resolveNodeProvider(node, context);
      if (provider) {
        receiptDraft = providerReceiptDraft(provider);
      }
      resumingInterruptedMeteredOperation = resumingInterruptedOperation && provider?.billing === "metered";
      if (provider?.billing === "metered") {
        validateMeteredProvider(provider);
        const approvalPolicy = approvalPolicyFor(provider);
        if (approvalPolicy === "automatic") {
          delete nodeRun.spendPlan;
          delete nodeRun.spendAuthorizationId;
          automaticMeteredProvider = provider;
        } else {
          const quote = await resolveSpendQuote(provider, input, publicContext);
          if (quote.requiresAuthorization === false) {
            delete nodeRun.spendPlan;
            delete nodeRun.spendAuthorizationId;
            spendAuthorizationExemptProviderId = provider.id;
          } else {
            const spendPlan = nodeRun.spendPlan ?? createSpendPlan(node, provider, quote, inputVersionIds, publicContext);
            nodeRun.spendPlan = spendPlan;
            if (!spendPlanMatchesExecution(spendPlan, node, provider, quote, inputVersionIds)) {
              throw new Error(`Spend plan for node '${node.id}' no longer matches its metered provider.`);
            }
            authorization = spendAuthorizations.find((candidate) =>
              !consumedSpendAuthorizationIds.has(candidate.id) && authorizationMatchesPlan(candidate, spendPlan));
            if (!authorization) {
              nodeRun.status = "awaiting_spend_approval";
              return nodeRun;
            }
            nodeRun.spendAuthorizationId = authorization.id;
          }
        }
      }

      const execution = await context.withSpendAuthorization(
        authorization,
        nodeRun.operationRequestId,
        () => executeNode(node, input, context, provider),
        async (attemptCount) => {
          meteredAttemptCount = attemptCount;
          nodeRun.outcomeUncertain = true;
          await onStarted(nodeRun);
        },
        spendAuthorizationExemptProviderId,
        automaticMeteredProvider?.id,
      );
      const result = execution.result;
      const executionFinishedAt = context.now();

      const status = result.status ?? "succeeded";
      validateNodeResultStatus(node.id, status, result);
      receiptDraft = execution.receipt;
      if (spendAuthorizationExemptProviderId) {
        receiptDraft = normalizeNoSpendReceipt(receiptDraft, spendAuthorizationExemptProviderId);
      }
      if (automaticMeteredProvider && receiptDraft.billing === "metered") {
        receiptDraft = {
          ...receiptDraft,
          meteredAttemptCount: receiptDraft.meteredAttemptCount ?? meteredAttemptCount,
        };
      }
      validateReceiptCosts(receiptDraft, authorization, automaticMeteredProvider);
      if (status !== "failed"
        || result.providerOutcomeKnown === true
        || (isDefinitiveZeroAttemptFailure(receiptDraft) && !resumingInterruptedMeteredOperation)) {
        delete nodeRun.outcomeUncertain;
      } else if (resumingInterruptedMeteredOperation) {
        nodeRun.outcomeUncertain = true;
      }

      for (const draft of result.artifacts ?? []) {
        const artifact = context.addArtifact(draft);
        nodeRun.artifactIds.push(artifact.id);
      }

      if (result.output !== undefined) {
        nodeRun.output = result.output;
      }

      nodeRun.executionReceipt = createExecutionReceipt(
        node,
        receiptDraft,
        nodeRun.startedAt,
        executionFinishedAt,
        status,
        authorization,
      );
      const previousVersions = nodeRun.outputState?.versions ?? [];
      nodeRun.outputState = createGeneratedOutputState(
        node,
        nodeRun,
        inputVersionIds,
        nodeRun.executionReceipt.providerId,
        context,
      );
      if (previousVersions.length) {
        nodeRun.outputState.versions = [...previousVersions, ...nodeRun.outputState.versions];
      }

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

      const gateResult = await evaluateQualityGates(node, publicContext, result.output as TOutput);
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
      if (resumingInterruptedMeteredOperation
        || (authorization || automaticMeteredProvider) && meteredAttemptCount > 0) {
        nodeRun.outcomeUncertain = true;
      }
      if (!nodeRun.executionReceipt) {
        if (automaticMeteredProvider && receiptDraft.billing === "metered") {
          receiptDraft = {
            ...receiptDraft,
            meteredAttemptCount: receiptDraft.meteredAttemptCount ?? meteredAttemptCount,
          };
        }
        nodeRun.executionReceipt = createExecutionReceipt(
          node,
          sanitizeFailureReceiptDraft(receiptDraft),
          nodeRun.startedAt,
          nodeRun.finishedAt,
          "failed",
          authorization,
        );
      }
      return nodeRun;
    }
  }
}

function isDefinitiveZeroAttemptFailure(receipt: NodeExecutionReceiptDraft): boolean {
  return receipt.billing === "metered"
    && receipt.meteredAttemptCount === 0
    && (receipt.meteredFailedAttemptCount ?? 0) === 0
    && (receipt.actualCostCny ?? 0) === 0;
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
      if (nodeRun.executionReceipt) {
        clone.executionReceipt = cloneExecutionReceipt(nodeRun.executionReceipt);
      }
      if (nodeRun.spendPlan) {
        clone.spendPlan = {
          ...nodeRun.spendPlan,
          inputVersionIds: [...nodeRun.spendPlan.inputVersionIds],
          ...(nodeRun.spendPlan.items ? { items: nodeRun.spendPlan.items.map((item) => ({ ...item })) } : {}),
        };
      }
      if (nodeRun.outputState) {
        clone.outputState = {
          ...nodeRun.outputState,
          versions: nodeRun.outputState.versions.map((version) => ({
            ...version,
            artifactIds: [...version.artifactIds],
            inputVersionIds: [...version.inputVersionIds],
          })),
        };
      }
      if (nodeRun.inputState) {
        clone.inputState = {
          ...nodeRun.inputState,
          versions: nodeRun.inputState.versions.map((version) => ({
            ...version,
            upstreamVersionIds: [...version.upstreamVersionIds],
          })),
        };
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
    ...(run.executionReceipts ? { executionReceipts: run.executionReceipts.map(cloneExecutionReceipt) } : {}),
    ...(run.consumedSpendAuthorizationIds
      ? { consumedSpendAuthorizationIds: [...run.consumedSpendAuthorizationIds] }
      : {}),
    ...(run.executionPlan ? { executionPlan: run.executionPlan.map((plan) => ({
      ...plan,
      ...(plan.parameters ? { parameters: cloneExecutionParameters(plan.parameters) } : {}),
    })) } : {}),
    ...(run.spendAuthorizations
      ? {
          spendAuthorizations: run.spendAuthorizations.map((authorization) => ({
            ...authorization,
            inputVersionIds: [...authorization.inputVersionIds],
          })),
        }
      : {}),
  };
}

function createIncrementingIdFactory(): (prefix: string) => string {
  let next = 1;
  return (prefix: string) => `${prefix}-${next++}`;
}

async function executeNode<TInput, TOutput>(
  node: NodeDefinition<TInput, TOutput>,
  input: TInput,
  context: InMemoryWorkflowContext<unknown>,
  resolvedProvider?: Provider<TInput, TOutput>,
): Promise<{ result: NodeExecutionResult<TOutput>; receipt: NodeExecutionReceiptDraft }> {
  const publicContext = context.publicContext();
  if (node.execute) {
    const result = await node.execute(input, publicContext);
    return {
      result,
      receipt: result.receipt
        ?? (resolvedProvider
          ? providerReceiptDraft(resolvedProvider)
          : inlineReceiptDraft(node)),
    };
  }

  const providerSnapshot = resolvedProvider ?? resolveNodeProvider(node, context);
  if (!providerSnapshot) {
    throw new Error(`Node '${node.id}' has no provider.`);
  }
  const provider = context.resolveProvider<TInput, TOutput>({
    capability: node.capability,
    providerId: providerSnapshot.id,
  });
  const output = await provider.run(input, publicContext);
  return {
    result: { status: "succeeded", output },
    receipt: providerReceiptDraft(provider),
  };
}

function providerReceiptDraft(
  provider: Pick<Provider, "id" | "label" | "modelId" | "transport" | "billing" | "configurationSource" | "parameters" | "estimatedCostCny">,
): NodeExecutionReceiptDraft {
  return {
    providerId: provider.id,
    providerLabel: provider.label ?? provider.id,
    modelId: provider.modelId ?? "unspecified",
    transport: provider.transport ?? "local_process",
    billing: provider.billing ?? "local_compute",
    ...(provider.configurationSource ? { configurationSource: provider.configurationSource } : {}),
    ...(provider.parameters ? { parameters: cloneExecutionParameters(provider.parameters) } : {}),
    ...(provider.estimatedCostCny !== undefined ? { estimatedCostCny: provider.estimatedCostCny } : {}),
  };
}

function createExecutionPlan(
  definition: WorkflowDefinition,
  context: InMemoryWorkflowContext<unknown>,
  snapshotSource: NodeExecutionPlan["snapshotSource"],
): NodeExecutionPlan[] {
  return definition.nodes.map((node) => {
    const provider = resolveNodeProvider(node, context);
    const draft = provider
      ? providerReceiptDraft(provider)
      : node.plannedExecution ?? inlineReceiptDraft(node);
    return {
      nodeId: node.id,
      snapshotSource,
      ...(node.role ? { role: node.role } : {}),
      capability: node.capability,
      providerId: draft.providerId,
      providerLabel: draft.providerLabel,
      modelId: draft.modelId,
      transport: draft.transport,
      billing: draft.billing,
      ...(draft.configurationSource ? { configurationSource: draft.configurationSource } : {}),
      ...(draft.parameters ? { parameters: cloneExecutionParameters(draft.parameters) } : {}),
      ...(draft.estimatedCostCny !== undefined ? { estimatedCostCny: draft.estimatedCostCny } : {}),
    };
  });
}

function refreshMutableExecutionPlan(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  context: InMemoryWorkflowContext<unknown>,
): NodeExecutionPlan[] {
  const previousPlans = new Map((run.executionPlan ?? []).map((plan) => [plan.nodeId, plan]));
  const immutableNodeIds = new Set(
    run.nodeRuns
      .filter((nodeRun) => nodeRun.executionReceipt !== undefined
        || ["succeeded", "rejected", "needs_human", "running"].includes(nodeRun.status))
      .map((nodeRun) => nodeRun.nodeId),
  );

  return createExecutionPlan(definition, context, "reconstructed").map((currentPlan) => {
    const previousPlan = previousPlans.get(currentPlan.nodeId);
    return previousPlan && immutableNodeIds.has(currentPlan.nodeId)
      ? previousPlan
      : currentPlan;
  });
}

function resolveNodeProvider<TInput, TOutput>(
  node: NodeDefinition<TInput, TOutput>,
  context: WorkflowContext,
): Provider<TInput, TOutput> | undefined {
  if (node.execute && !node.providerId) {
    return undefined;
  }
  const selector = node.providerId
    ? { capability: node.capability, providerId: node.providerId }
    : { capability: node.capability };
  try {
    return context instanceof InMemoryWorkflowContext
      ? context.resolveProviderForNode<TInput, TOutput>(selector)
      : context.resolveProvider<TInput, TOutput>(selector);
  } catch (error) {
    if (node.execute) {
      return undefined;
    }
    throw error;
  }
}

function createSpendPlan(
  node: { id: string },
  provider: Pick<Provider, "id"> & { modelId: string; maxAttempts: number },
  quote: SpendQuote,
  inputVersionIds: string[],
  context: WorkflowContext,
): SpendPlan {
  return {
    id: context.nextId("spend-plan"),
    nodeId: node.id,
    inputVersionIds: [...inputVersionIds],
    providerId: provider.id,
    modelId: provider.modelId,
    estimatedCostCny: quote.estimatedCostCny,
    maxCostCny: quote.maxCostCny,
    maxAttempts: provider.maxAttempts,
    ...(quote.items ? { items: quote.items.map((item) => ({ ...item })) } : {}),
    createdAt: context.now(),
  };
}

async function resolveSpendQuote<TInput>(
  provider: Provider<TInput, unknown>,
  input: TInput,
  context: WorkflowContext,
): Promise<SpendQuote> {
  validateMeteredProvider(provider);
  const quote = provider.quoteSpend
    ? await provider.quoteSpend(input, context)
    : { estimatedCostCny: provider.estimatedCostCny, maxCostCny: provider.maxCostCny };
  validateSpendQuote(quote);
  return {
    estimatedCostCny: roundSpendMoney(quote.estimatedCostCny),
    maxCostCny: roundSpendMoney(quote.maxCostCny),
    ...(quote.items ? { items: quote.items.map((item) => ({ ...item, estimatedCostCny: roundSpendMoney(item.estimatedCostCny) })) } : {}),
    ...(quote.requiresAuthorization === false ? { requiresAuthorization: false } : {}),
  };
}

function roundSpendMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function approvalPolicyFor(
  provider: Pick<Provider, "billing" | "approvalPolicy">,
): ApprovalPolicy {
  if (provider.billing === "metered") {
    return provider.approvalPolicy === "automatic" ? "automatic" : "manual";
  }
  return provider.approvalPolicy ?? "none";
}

function authorizationMatchesPlan(
  authorization: SpendAuthorizationDraft,
  plan: SpendPlan,
): boolean {
  return isValidSpendAuthorizationScope(authorization)
    && authorization.spendPlanId === plan.id
    && authorization.nodeId === plan.nodeId
    && authorization.providerId === plan.providerId
    && authorization.modelId === plan.modelId
    && authorization.maxCostCny === plan.maxCostCny
    && authorization.maxAttempts === plan.maxAttempts
    && authorization.inputVersionIds.length === plan.inputVersionIds.length
    && authorization.inputVersionIds.every((versionId, index) => versionId === plan.inputVersionIds[index]);
}

function spendPlanMatchesExecution(
  plan: SpendPlan,
  node: { id: string },
  provider: Pick<Provider, "id" | "modelId" | "maxAttempts">,
  quote: SpendQuote,
  inputVersionIds: string[],
): boolean {
  return plan.nodeId === node.id
    && plan.providerId === provider.id
    && plan.modelId === provider.modelId
    && plan.estimatedCostCny === quote.estimatedCostCny
    && plan.maxCostCny === quote.maxCostCny
    && plan.maxAttempts === provider.maxAttempts
    && spendQuoteItemsMatch(plan.items, quote.items)
    && plan.inputVersionIds.length === inputVersionIds.length
    && plan.inputVersionIds.every((versionId, index) => versionId === inputVersionIds[index]);
}

function spendQuoteItemsMatch(left: SpendQuote["items"], right: SpendQuote["items"]): boolean {
  if (!left && !right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((item, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && item.id === candidate.id
      && item.label === candidate.label
      && item.providerId === candidate.providerId
      && item.modelId === candidate.modelId
      && item.estimatedCostCny === candidate.estimatedCostCny;
  });
}

function createExecutionReceipt(
  node: Pick<NodeDefinition, "id" | "role" | "capability">,
  draft: NodeExecutionReceiptDraft,
  startedAt: string,
  finishedAt: string,
  status: NodeExecutionReceiptStatus,
  authorization?: SpendAuthorization,
): NodeExecutionReceipt {
  return {
    ...draft,
    ...(draft.parameters ? { parameters: cloneExecutionParameters(draft.parameters) } : {}),
    ...(draft.actualModelIds ? { actualModelIds: [...draft.actualModelIds] } : {}),
    nodeId: node.id,
    ...(node.role ? { role: node.role } : {}),
    capability: node.capability,
    status,
    ...(authorization
      ? {
          spendAuthorizationId: authorization.id,
          authorizedCostCny: authorization.maxCostCny,
        }
      : {}),
    startedAt,
    finishedAt,
  };
}

function inlineReceiptDraft(node: Pick<NodeDefinition, "id" | "label" | "providerId" | "mode">): NodeExecutionReceiptDraft {
  return {
    providerId: node.providerId ?? `inline:${node.id}`,
    providerLabel: node.label,
    modelId: "inline",
    transport: node.mode === "manual" ? "human" : "local_process",
    billing: node.mode === "manual" ? "human" : "local_compute",
    configurationSource: "system_default",
  };
}

function cloneExecutionParameters(
  parameters: NonNullable<Provider["parameters"]>,
): NonNullable<NodeExecutionReceiptDraft["parameters"]> {
  const entries = Object.entries(parameters);
  if (entries.length > 32) throw new Error("Provider execution parameters exceed the receipt boundary.");
  return Object.fromEntries(entries.map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key)) throw new Error(`Provider execution parameter '${key}' is invalid.`);
    if (Array.isArray(value)) {
      if (value.length > 32 || value.some((item) => typeof item !== "string" || item.length > 256)) {
        throw new Error(`Provider execution parameter '${key}' exceeds the receipt boundary.`);
      }
      return [key, [...value]];
    }
    if (typeof value === "string" && value.length <= 512) return [key, value];
    if (typeof value === "number" && Number.isFinite(value)) return [key, value];
    if (typeof value === "boolean") return [key, value];
    throw new Error(`Provider execution parameter '${key}' is invalid.`);
  }));
}

function validateMeteredProvider(
  provider: Pick<Provider, "id" | "modelId" | "estimatedCostCny" | "maxCostCny" | "maxAttempts">,
): asserts provider is Pick<Provider, "id"> & {
  modelId: string;
  estimatedCostCny: number;
  maxCostCny: number;
  maxAttempts: number;
} {
  if (
    typeof provider.modelId !== "string"
    || !provider.modelId.trim()
    || !isFiniteNonNegative(provider.estimatedCostCny)
    || !isFinitePositive(provider.maxCostCny)
    || !Number.isInteger(provider.maxAttempts)
    || Number(provider.maxAttempts) < 1
  ) {
    throw new Error(`Metered provider '${provider.id}' is missing a bounded spend plan.`);
  }
  if (Number(provider.estimatedCostCny) > Number(provider.maxCostCny)) {
    throw new Error(`Metered provider '${provider.id}' estimated cost exceeds its maximum cost.`);
  }
}

function validateSpendQuote(quote: SpendQuote): void {
  if (quote.requiresAuthorization !== undefined && typeof quote.requiresAuthorization !== "boolean") {
    throw new Error("Spend quote requiresAuthorization must be a boolean when provided.");
  }
  if (quote.requiresAuthorization === false) {
    if (quote.estimatedCostCny !== 0 || quote.maxCostCny !== 0 || quote.items !== undefined) {
      throw new Error("A no-spend quote must contain exactly zero cost and no charge items.");
    }
    return;
  }
  if (!isFiniteNonNegative(quote.estimatedCostCny) || !isFinitePositive(quote.maxCostCny)) {
    throw new Error("Spend quote must contain finite estimated and maximum costs.");
  }
  if (quote.estimatedCostCny > quote.maxCostCny) {
    throw new Error("Spend quote estimated cost exceeds its maximum cost.");
  }
  if (!quote.items) return;
  if (quote.items.length === 0 || quote.items.length > 100) {
    throw new Error("Spend quote items must contain between 1 and 100 entries.");
  }
  if (new Set(quote.items.map((item) => item.id)).size !== quote.items.length) {
    throw new Error("Spend quote items must have unique item ids.");
  }
  for (const item of quote.items) {
    if (!item.id.trim() || !item.label.trim() || !item.providerId.trim() || !item.modelId.trim() || !isFinitePositive(item.estimatedCostCny)) {
      throw new Error("Spend quote item is incomplete or has an invalid estimated cost.");
    }
  }
  const itemTotal = quote.items.reduce((sum, item) => sum + item.estimatedCostCny, 0);
  if (Math.round(itemTotal * 100) !== Math.round(quote.estimatedCostCny * 100)) {
    throw new Error("Spend quote item total does not match the estimated cost.");
  }
}

function normalizeNoSpendReceipt(
  receipt: NodeExecutionReceiptDraft,
  providerId: string,
): NodeExecutionReceiptDraft {
  if (receipt.providerId !== providerId) {
    throw new Error(`No-spend execution resolved an unexpected provider '${receipt.providerId}'.`);
  }
  if ((receipt.actualCostCny ?? 0) !== 0 || (receipt.meteredAttemptCount ?? 0) !== 0 || (receipt.meteredFailedAttemptCount ?? 0) !== 0) {
    throw new Error(`No-spend execution for provider '${providerId}' reported a metered charge or attempt.`);
  }
  return {
    ...receipt,
    billing: "free",
    estimatedCostCny: 0,
  };
}

function authorizationMatchesProvider(
  authorization: SpendAuthorizationDraft,
  provider: Pick<Provider, "id" | "modelId" | "maxAttempts">,
): boolean {
  return isValidSpendAuthorizationScope(authorization)
    && authorization.providerId === provider.id
    && authorization.modelId === provider.modelId
    && authorization.maxAttempts === provider.maxAttempts;
}

function validateSpendAuthorizationDraft(draft: SpendAuthorizationDraft): void {
  if (!isValidSpendAuthorizationScope(draft)) {
    throw new Error("Spend authorization must contain finite positive limits and a complete execution scope.");
  }
  if (typeof draft.approvedBy !== "string") {
    throw new Error("Spend authorization approver is required.");
  }
}

function isValidSpendAuthorizationScope(draft: SpendAuthorizationDraft): boolean {
  return typeof draft.spendPlanId === "string"
    && Boolean(draft.spendPlanId)
    && typeof draft.nodeId === "string"
    && Boolean(draft.nodeId)
    && Array.isArray(draft.inputVersionIds)
    && draft.inputVersionIds.every((id) => typeof id === "string" && Boolean(id))
    && typeof draft.providerId === "string"
    && Boolean(draft.providerId)
    && typeof draft.modelId === "string"
    && Boolean(draft.modelId)
    && isFinitePositive(draft.maxCostCny)
    && Number.isInteger(draft.maxAttempts)
    && draft.maxAttempts > 0;
}

function validateReceiptCosts(
  receipt: NodeExecutionReceiptDraft,
  authorization: SpendAuthorization | undefined,
  automaticMeteredProvider?: Pick<Provider, "id" | "modelId">,
): void {
  if (receipt.actualModelIds !== undefined && (
    !Array.isArray(receipt.actualModelIds)
    || receipt.actualModelIds.length === 0
    || receipt.actualModelIds.length > 20
    || receipt.actualModelIds.some((modelId) => typeof modelId !== "string" || !modelId.trim() || modelId.length > 160)
  )) {
    throw new Error("Execution receipt actualModelIds must contain 1 to 20 valid model identifiers.");
  }
  if (receipt.billing === "metered" && !authorization) {
    if (
      !automaticMeteredProvider
      || receipt.providerId !== automaticMeteredProvider.id
      || receipt.modelId !== automaticMeteredProvider.modelId
    ) {
      throw new Error(`Metered receipt for provider '${receipt.providerId}' has no active spend authorization.`);
    }
  }
  if (authorization && (
    receipt.billing !== "metered"
    || receipt.providerId !== authorization.providerId
    || receipt.modelId !== authorization.modelId
  )) {
    throw new Error(`Execution receipt does not match the active authorization for provider '${authorization.providerId}'.`);
  }
  if (receipt.estimatedCostCny !== undefined && !isFiniteNonNegative(receipt.estimatedCostCny)) {
    throw new Error("Execution receipt estimatedCostCny must be a finite non-negative number.");
  }
  if (receipt.actualCostCny !== undefined && !isFiniteNonNegative(receipt.actualCostCny)) {
    throw new Error("Execution receipt actualCostCny must be a finite non-negative number.");
  }
  if (receipt.actualCostSource !== undefined && receipt.actualCostSource !== "provider_reported" && receipt.actualCostSource !== "configured_rate") {
    throw new Error("Execution receipt actualCostSource must identify provider-reported or configured-rate accounting.");
  }
  if (receipt.actualCostSource !== undefined && receipt.actualCostCny === undefined) {
    throw new Error("Execution receipt actualCostSource requires actualCostCny.");
  }
  if (receipt.meteredAttemptCount !== undefined && !isNonNegativeInteger(receipt.meteredAttemptCount)) {
    throw new Error("Execution receipt meteredAttemptCount must be a non-negative integer.");
  }
  if (receipt.meteredFailedAttemptCount !== undefined && !isNonNegativeInteger(receipt.meteredFailedAttemptCount)) {
    throw new Error("Execution receipt meteredFailedAttemptCount must be a non-negative integer.");
  }
  if ((receipt.meteredFailedAttemptCount ?? 0) > (receipt.meteredAttemptCount ?? 0)) {
    throw new Error("Execution receipt failed metered attempts cannot exceed total metered attempts.");
  }
  if (authorization && receipt.actualCostCny !== undefined && receipt.actualCostCny > authorization.maxCostCny) {
    throw new Error(`Execution cost exceeded the authorized maximum for provider '${authorization.providerId}'.`);
  }
}

function assertManualVersionSize(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > MAX_MANUAL_VERSION_BYTES) {
    throw new Error(`${label} exceeds the 1 MB manual version limit.`);
  }
}

function assertFileReferenceChangesAuthorized(
  previous: unknown,
  next: unknown,
  artifacts: ArtifactDraft[],
): void {
  const previousReferences = collectFileReferences(previous);
  const nextReferences = collectFileReferences(next);
  const authorizedUris = new Set(
    artifacts.map((artifact) => artifact.uri).filter((uri): uri is string => typeof uri === "string" && Boolean(uri)),
  );
  for (const [field, nextValue] of nextReferences) {
    const previousValue = previousReferences.get(field);
    if (previousValue !== undefined && previousValue !== nextValue && !authorizedUris.has(nextValue)) {
      throw new Error(`${field} cannot be changed without a matching override artifact.`);
    }
    if (previousValue === undefined && !authorizedUris.has(nextValue)) {
      throw new Error(`${field} cannot introduce a new file reference without a matching override artifact.`);
    }
  }
  for (const field of previousReferences.keys()) {
    if (!nextReferences.has(field)) throw new Error(`${field} cannot remove an existing file reference.`);
  }
}

function collectFileReferences(value: unknown, field = "output", result = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFileReferences(item, `${field}[${index}]`, result));
    return result;
  }
  if (typeof value !== "object" || value === null) return result;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childField = `${field}.${key}`;
    if (isFileReferenceKey(key) && typeof child === "string" && child) result.set(childField, child);
    else collectFileReferences(child, childField, result);
  }
  return result;
}

function isFileReferenceKey(key: string): boolean {
  return key === "uri"
    || key.endsWith("Path")
    || key.endsWith("Root")
    || key.endsWith("_path")
    || key.endsWith("_root")
    || key.endsWith("_file");
}

function sanitizeFailureReceiptDraft(receipt: NodeExecutionReceiptDraft): NodeExecutionReceiptDraft {
  const sanitized = { ...receipt };
  if (sanitized.parameters) {
    try {
      sanitized.parameters = cloneExecutionParameters(sanitized.parameters);
    } catch {
      delete sanitized.parameters;
    }
  }
  if (sanitized.actualModelIds !== undefined) {
    if (
      !Array.isArray(sanitized.actualModelIds)
      || sanitized.actualModelIds.length === 0
      || sanitized.actualModelIds.length > 20
      || sanitized.actualModelIds.some((modelId) => typeof modelId !== "string" || !modelId.trim() || modelId.length > 160)
    ) {
      delete sanitized.actualModelIds;
    } else {
      sanitized.actualModelIds = [...sanitized.actualModelIds];
    }
  }
  if (sanitized.estimatedCostCny !== undefined && !isFiniteNonNegative(sanitized.estimatedCostCny)) {
    delete sanitized.estimatedCostCny;
  }
  if (sanitized.actualCostCny !== undefined && !isFiniteNonNegative(sanitized.actualCostCny)) {
    delete sanitized.actualCostCny;
    delete sanitized.actualCostSource;
  }
  if (sanitized.actualCostSource !== undefined && sanitized.actualCostSource !== "provider_reported" && sanitized.actualCostSource !== "configured_rate") {
    delete sanitized.actualCostSource;
  }
  if (sanitized.actualCostCny === undefined) delete sanitized.actualCostSource;
  if (sanitized.meteredAttemptCount !== undefined && !isNonNegativeInteger(sanitized.meteredAttemptCount)) {
    delete sanitized.meteredAttemptCount;
    delete sanitized.meteredFailedAttemptCount;
  }
  if (sanitized.meteredFailedAttemptCount !== undefined && (
    !isNonNegativeInteger(sanitized.meteredFailedAttemptCount)
    || sanitized.meteredFailedAttemptCount > (sanitized.meteredAttemptCount ?? 0)
  )) {
    delete sanitized.meteredFailedAttemptCount;
  }
  return sanitized;
}

function cloneExecutionReceipt(receipt: NodeExecutionReceipt): NodeExecutionReceipt {
  return {
    ...receipt,
    ...(receipt.parameters ? { parameters: cloneExecutionParameters(receipt.parameters) } : {}),
    ...(receipt.actualModelIds ? { actualModelIds: [...receipt.actualModelIds] } : {}),
  };
}

function mergeExecutionReceiptForSameRequest(
  previous: NodeExecutionReceipt,
  current: NodeExecutionReceipt,
): NodeExecutionReceipt {
  if (previous.billing === "metered" && current.billing === "free") {
    return {
      ...cloneExecutionReceipt(previous),
      status: current.status,
      finishedAt: current.finishedAt,
    };
  }
  const merged = cloneExecutionReceipt(current);
  if (merged.actualCostCny === undefined && previous.actualCostCny !== undefined) {
    merged.actualCostCny = previous.actualCostCny;
    if (previous.actualCostSource) merged.actualCostSource = previous.actualCostSource;
  }
  if (merged.meteredAttemptCount === undefined && previous.meteredAttemptCount !== undefined) {
    merged.meteredAttemptCount = previous.meteredAttemptCount;
  }
  if (merged.meteredFailedAttemptCount === undefined && previous.meteredFailedAttemptCount !== undefined) {
    merged.meteredFailedAttemptCount = previous.meteredFailedAttemptCount;
  }
  return merged;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function createGeneratedOutputState<TOutput>(
  node: { id: string },
  nodeRun: NodeRun<TOutput>,
  inputVersionIds: string[],
  createdBy: string,
  context: WorkflowContext,
): NonNullable<NodeRun<TOutput>["outputState"]> {
  const versionId = context.nextId("version");
  const version = {
    id: versionId,
    nodeId: node.id,
    source: "generated" as const,
    artifactIds: [...nodeRun.artifactIds],
    inputVersionIds: [...inputVersionIds],
    createdAt: context.now(),
    createdBy,
    schemaVersion: "1",
    ...(nodeRun.output !== undefined ? { output: nodeRun.output } : {}),
  };
  return {
    nodeId: node.id,
    generatedVersionId: versionId,
    effectiveVersionId: versionId,
    stale: false,
    versions: [version],
  };
}

function inputVersionIdsForNode(node: { dependsOn?: string[] }, nodeRuns: NodeRun[]): string[] {
  return (node.dependsOn ?? []).flatMap((dependencyId) => {
    const versionId = nodeRuns.find((nodeRun) => nodeRun.nodeId === dependencyId)?.outputState?.effectiveVersionId;
    return versionId ? [versionId] : [];
  });
}

function executionInputVersionIds(
  node: { dependsOn?: string[] },
  nodeRun: NodeRun,
  nodeRuns: NodeRun[],
): string[] {
  return executionInputVersionIdsFromUpstream(nodeRun, inputVersionIdsForNode(node, nodeRuns));
}

function executionInputVersionIdsFromUpstream(nodeRun: NodeRun, upstreamVersionIds: string[]): string[] {
  const inputVersionId = nodeRun.inputState?.effectiveVersionId;
  return [...(inputVersionId ? [inputVersionId] : []), ...upstreamVersionIds];
}

function resolveEffectiveNodeInput<TInput>(
  node: Pick<NodeDefinition<TInput, never>, "id" | "validateInputOverride">,
  nodeRun: NodeRun,
  derivedInput: TInput,
  upstreamVersionIds: string[],
  context: WorkflowContext,
): TInput {
  const state = nodeRun.inputState;
  if (state && !state.stale) {
    const effective = state.versions.find((version) => version.id === state.effectiveVersionId);
    if (!effective) throw new Error(`Node '${node.id}' effective input version is missing.`);
    return effective.value as TInput;
  }
  if (state?.stale) {
    const effective = state.versions.find((version) => version.id === state.effectiveVersionId);
    if (effective?.source === "human") {
      throw new Error(`Node '${node.id}' has a stale human input that must be reviewed before execution.`);
    }
  }

  const versionId = context.nextId("input-version");
  const version = {
    id: versionId,
    nodeId: node.id,
    source: "derived" as const,
    value: derivedInput,
    upstreamVersionIds: [...upstreamVersionIds],
    ...(state?.effectiveVersionId ? { parentVersionId: state.effectiveVersionId } : {}),
    createdAt: context.now(),
    createdBy: `workflow:${node.id}`,
    schemaVersion: "1",
  };
  nodeRun.inputState = {
    nodeId: node.id,
    effectiveVersionId: versionId,
    stale: false,
    versions: [...(state?.versions ?? []), version],
  };
  return derivedInput;
}

function normalizeLegacyVersionStates<TInitialInput>(
  definition: WorkflowDefinition,
  run: WorkflowRun<TInitialInput>,
  context: WorkflowContext,
): void {
  const orderedNodes = orderNodes(definition.nodes);
  for (const node of orderedNodes) {
    const nodeRun = run.nodeRuns.find((candidate) => candidate.nodeId === node.id);
    if (!nodeRun || nodeRun.outputState || (nodeRun.output === undefined && nodeRun.artifactIds.length === 0)) {
      continue;
    }
    nodeRun.outputState = createLegacyOutputState(node, nodeRun, run.nodeRuns);
  }
  for (const node of orderedNodes) {
    const nodeRun = run.nodeRuns.find((candidate) => candidate.nodeId === node.id);
    if (!nodeRun || nodeRun.inputState || nodeRun.status === "pending") continue;
    let value: unknown;
    try {
      value = node.getInput ? node.getInput(context) : context.initialInput;
    } catch {
      continue;
    }
    if (value === undefined) continue;
    const versionId = legacyVersionId("input", node.id, nodeRun.startedAt);
    nodeRun.inputState = {
      nodeId: node.id,
      effectiveVersionId: versionId,
      stale: nodeRun.status === "stale",
      versions: [{
        id: versionId,
        nodeId: node.id,
        source: "reconstructed",
        value,
        upstreamVersionIds: inputVersionIdsForNode(node, run.nodeRuns),
        createdAt: nodeRun.startedAt,
        createdBy: `legacy-reconstruction:${node.id}`,
        schemaVersion: "1",
      }],
    };
  }
}

function createLegacyOutputState(
  node: NodeDefinition,
  nodeRun: NodeRun,
  nodeRuns: NodeRun[],
): NonNullable<NodeRun["outputState"]> {
  const versionId = legacyVersionId("output", node.id, nodeRun.startedAt);
  return {
    nodeId: node.id,
    generatedVersionId: versionId,
    effectiveVersionId: versionId,
    stale: nodeRun.status === "stale",
    versions: [
      {
        id: versionId,
        nodeId: node.id,
        source: "generated",
        artifactIds: [...nodeRun.artifactIds],
        inputVersionIds: executionInputVersionIds(node, nodeRun, nodeRuns),
        createdAt: nodeRun.finishedAt ?? nodeRun.startedAt,
        createdBy: nodeRun.executionReceipt?.providerId ?? "legacy",
        schemaVersion: "1",
        ...(nodeRun.output !== undefined ? { output: nodeRun.output } : {}),
      },
    ],
  };
}

function legacyVersionId(kind: "input" | "output", nodeId: string, startedAt: string): string {
  return `legacy-${kind}:${nodeId}:${startedAt}`;
}

function descendantNodeIds(nodes: NodeDefinition[], rootNodeId: string): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      const current = dependents.get(dependency) ?? [];
      current.push(node.id);
      dependents.set(dependency, current);
    }
  }

  const descendants = new Set<string>();
  const pending = [...(dependents.get(rootNodeId) ?? [])];
  while (pending.length > 0) {
    const nodeId = pending.shift()!;
    if (descendants.has(nodeId)) {
      continue;
    }
    descendants.add(nodeId);
    pending.push(...(dependents.get(nodeId) ?? []));
  }
  return descendants;
}

function assertNoUncertainPaidOutcomeInvalidated(
  run: WorkflowRun,
  invalidatedNodeIds: ReadonlySet<string>,
): void {
  const uncertainNode = run.nodeRuns.find((nodeRun) => (
    invalidatedNodeIds.has(nodeRun.nodeId) && nodeRun.outcomeUncertain
  ));
  if (uncertainNode) {
    throw new Error(
      `Node '${uncertainNode.nodeId}' has an uncertain paid-provider outcome and must be reconciled before changing its inputs or dependencies.`,
    );
  }
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
  if (status === "awaiting_spend_approval") {
    return "awaiting_spend_approval";
  }
  if (status === "approval_invalidated") {
    return "approval_invalidated";
  }
  return undefined;
}

function markNodeExecutionStale(node: NodeRun, inputIsStale: boolean): void {
  node.status = "stale";
  delete node.intervention;
  delete node.spendPlan;
  delete node.spendAuthorizationId;
  delete node.operationRequestId;
  delete node.interrupted;
  delete node.executionReceipt;
  if (node.outputState) node.outputState.stale = true;
  if (inputIsStale && node.inputState) node.inputState.stale = true;
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
