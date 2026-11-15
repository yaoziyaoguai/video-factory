import type { AgentDatabase } from "./db.js";
import { getArtifactRow, getRevisionRow, type ArtifactRevisionRow } from "./artifact-store.js";
import { blobSources } from "./material-store.js";
import { operationOutputRevision } from "./production-store.js";
import type {
  ArtifactRevision, CreationBinding, CreativeProjectContent, LibraryVideo, LocalCreationSpec,
  OperationSpec, ProductionSpec, LegacyProductionSpec, RevisionRef,
} from "../../shared/agent/generated/contracts.js";

type FrozenSpec = ProductionSpec | LocalCreationSpec | LegacyProductionSpec;
type Material = LibraryVideo["materials"][number];
interface Producer {
  runId: string;
  runOrder: number;
  operationId: string;
  outputSlot: string;
  spec: FrozenSpec;
}

// 库展示与发送时的成员校验共用准确输出的冻结输入集合；不扫描整个run的候选。
// 工程输入仅表示“提供给工程”，不推断任意程序的像素级采用情况。
export function retainedVideoMaterials(db: AgentDatabase, ownerId: string, video: RevisionRef): {
  materials: Material[]; projects: RevisionRef[]; producer: Producer | null;
} {
  const materials: Material[] = [];
  const projects: RevisionRef[] = [];
  const seenMaterials = new Set<string>();
  const seenProjects = new Set<string>();
  const seenRevisions = new Set<string>();
  const seenOperations = new Set<string>();
  const bindingOf = (revision: ArtifactRevisionRow): CreationBinding | null => {
    const binding = revision.creation_binding_json ? JSON.parse(revision.creation_binding_json) as CreationBinding : null;
    return binding && Array.isArray(binding.inputSources) ? binding : null;
  };
  const producerOf = (ref: RevisionRef): Producer | null => {
    const artifact = getArtifactRow(db, ownerId, ref.artifactId);
    const revision = artifact ? getRevisionRow(db, ref.artifactId, ref.revisionId) : undefined;
    if (!revision) return null;
    const binding = bindingOf(revision);
    if (binding?.adoptedFrom) return producerOf(binding.adoptedFrom);
    const runId = revision.run_id ?? binding?.runId;
    const content = JSON.parse(revision.content_json) as ArtifactRevision["content"];
    if (!runId || content.format !== "media") return null;
    const output = db.prepare(`SELECT r.id AS run_id,r.rowid AS run_order,s.spec_json,o.id AS operation_id,o.spec_json AS operation_json
      FROM production_runs r JOIN production_snapshots s ON s.id=r.snapshot_id
      JOIN production_operations o ON o.run_id=r.id AND o.output_revision_id=?
      WHERE r.id=? AND r.owner_id=? AND r.conversation_id=?`)
      .get(revision.id, runId, ownerId, artifact!.conversation_id) as {
        run_id: string; run_order: number; spec_json: string; operation_id: string; operation_json: string;
      } | undefined;
    if (!output) return null;
    const operation = JSON.parse(output.operation_json) as OperationSpec;
    return { runId: output.run_id, runOrder: output.run_order, operationId: output.operation_id,
      outputSlot: operation.outputSlot, spec: JSON.parse(output.spec_json) as FrozenSpec };
  };
  const addRevision = (ref: RevisionRef, providedToProject = false): void => {
    const key = `revision:${ref.artifactId}:${ref.revisionId}`;
    if (seenMaterials.has(key)) return;
    const artifact = getArtifactRow(db, ownerId, ref.artifactId);
    const revision = artifact ? getRevisionRow(db, ref.artifactId, ref.revisionId) : undefined;
    if (!artifact || !revision || artifact.kind === "project" || artifact.kind === "file") return;
    seenMaterials.add(key);
    const content = JSON.parse(revision.content_json) as ArtifactRevision["content"];
    materials.push({ source: { artifactId: ref.artifactId, revisionId: ref.revisionId },
      label: providedToProject ? `${artifact.title}（提供给工程）` : artifact.title,
      kind: artifact.kind, provenance: content.format === "media" ? content.sources ?? blobSources(db, content.blobId) : [] });
  };
  const addProject = (ref: RevisionRef): void => {
    if (seenProjects.has(ref.revisionId)) return;
    const artifact = getArtifactRow(db, ownerId, ref.artifactId);
    const revision = artifact ? getRevisionRow(db, ref.artifactId, ref.revisionId) : undefined;
    if (!artifact || artifact.kind !== "project" || !revision) return;
    seenProjects.add(ref.revisionId);
    projects.push({ artifactId: ref.artifactId, revisionId: ref.revisionId });
    const project = JSON.parse(revision.content_json) as CreativeProjectContent;
    for (const source of project.sourceRevisions) addRevision(source, true);
  };
  const walkOperation = (runId: string, operationId: string): void => {
    const key = `${runId}:${operationId}`;
    if (seenOperations.has(key)) return;
    seenOperations.add(key);
    const run = db.prepare("SELECT conversation_id FROM production_runs WHERE id=? AND owner_id=?").get(runId, ownerId) as { conversation_id: string } | undefined;
    const row = run ? db.prepare("SELECT spec_json FROM production_operations WHERE run_id=? AND id=?").get(runId, operationId) as { spec_json: string } | undefined : undefined;
    if (!row) return;
    const op = JSON.parse(row.spec_json) as OperationSpec;
    let slots = op.inputs.map((_, index) => index);
    if (op.kind === "render") {
      const parameters = op.parameters;
      if (parameters.assembly === "code_project") addProject(parameters.projectRevision);
      else if (parameters.assembly === "narrated_concat") slots = [...parameters.videoInputSlots, parameters.narrationInputSlot];
      else if (parameters.assembly === "timed_narrated_concat") slots = [...parameters.segments.map(segment => segment.inputSlot), parameters.narrationInputSlot];
      else if (parameters.assembly === "mixed_concat") slots = [
        ...parameters.segments.map(segment => segment.inputSlot),
        ...(parameters.music && parameters.music.gain > 0 ? [parameters.music.inputSlot] : []),
        ...(parameters.narration && parameters.narration.gain > 0 ? [parameters.narration.inputSlot] : []),
      ];
    }
    for (const slot of new Set(slots)) {
      const input = op.inputs[slot]!;
      if (input.kind === "artifact_revision") {
        addRevision(input, op.kind === "render" && op.parameters.assembly === "code_project"); walkRevision(input);
      }
      else if (input.kind === "project_revision") addProject(input.projectRevision);
      else if (input.kind === "operation_output") {
        const producer = db.prepare("SELECT spec_json FROM production_operations WHERE run_id=? AND id=?").get(runId, input.producerOperationId) as { spec_json: string } | undefined;
        if (producer && (JSON.parse(producer.spec_json) as OperationSpec).outputSlot === input.outputSlot) {
          const output = operationOutputRevision(db, runId, input.producerOperationId);
          if (output) addRevision({ artifactId: output.artifact_id, revisionId: output.id });
          walkOperation(runId, input.producerOperationId);
        }
      } else if (input.kind === "blob") {
        const blob = db.prepare("SELECT mime_type FROM production_blobs WHERE id=? AND digest=? AND owner_id=? AND conversation_id=?")
          .get(input.blobId, input.digest, ownerId, run!.conversation_id) as { mime_type: string } | undefined;
        if (!blob || !/^(video|image|audio)\//.test(blob.mime_type)) continue;
        const source = { kind: "run_input" as const, runId, operationId, inputIndex: slot, blobId: input.blobId };
        const materialKey = `input:${runId}:${operationId}:${slot}:${input.blobId}`;
        if (seenMaterials.has(materialKey)) continue;
        seenMaterials.add(materialKey);
        const candidate = db.prepare("SELECT metadata_json FROM material_candidates WHERE owner_id=? AND imported_blob_id=? ORDER BY rowid LIMIT 1")
          .get(ownerId, input.blobId) as { metadata_json: string } | undefined;
        const title = candidate ? (JSON.parse(candidate.metadata_json) as { title?: string }).title : undefined;
        const kind = blob.mime_type.startsWith("video/") ? "video" : blob.mime_type.startsWith("image/") ? "image" : "audio";
        const musicSource = op.kind === "render" && op.parameters.assembly === "mixed_concat" && op.parameters.music?.inputSlot === slot ? op.musicSource : undefined;
        materials.push({ source, label: title ?? `${op.kind === "render" && op.parameters.assembly === "code_project" ? "工程输入" : "原始素材"} ${slot + 1}`,
          kind, provenance: musicSource ? [musicSource] : blobSources(db, input.blobId) });
      }
    }
  };
  const walkRevision = (ref: RevisionRef): void => {
    const key = `${ref.artifactId}:${ref.revisionId}`;
    if (seenRevisions.has(key)) return;
    seenRevisions.add(key);
    const revision = getRevisionRow(db, ref.artifactId, ref.revisionId);
    if (!revision || !getArtifactRow(db, ownerId, ref.artifactId)) return;
    const producer = producerOf(ref);
    if (producer) walkOperation(producer.runId, producer.operationId);
    else {
      // 只有缺少准确产出关系的旧记录回退到既有绑定；新数据沿冻结操作的消费路径留存。
      const binding = bindingOf(revision);
      for (const project of [binding?.projectRevision, ...(binding?.projectRevisions ?? [])]) if (project) addProject(project);
      if (binding) for (const source of binding.inputSources) if (source.kind === "artifact_revision") addRevision(source);
    }
  };
  walkRevision(video);
  return { materials, projects, producer: producerOf(video) };
}
