import type { ArtifactRevision } from "../../shared/agent/generated/contracts.js";

export class ConversationCache<T> extends Map<string, T> {
  active: string | null = null;

  override set(id: string, view: T): this {
    super.delete(id);
    super.set(id, view);
    if (this.size > 10) {
      for (const candidate of this.keys()) {
        if (candidate !== this.active) { this.delete(candidate); break; }
      }
    }
    return this;
  }

  activate(id: string | null) {
    this.active = id;
    if (id && this.has(id)) this.set(id, this.get(id)!);
  }
}

export class RevisionCache {
  values: Record<string, ArtifactRevision> = {};
  private readonly owners = new Map<string, string>();
  private active: string | null = null;

  activate(id: string | null) {
    this.active = id;
    return this.trim();
  }

  remember(owner: string, revisions: Record<string, ArtifactRevision>) {
    if (!Object.keys(revisions).length) return this.values;
    for (const key of Object.keys(revisions)) {
      this.owners.delete(key);
      this.owners.set(key, owner);
    }
    this.values = { ...this.values, ...revisions };
    return this.trim();
  }

  touch(key: string) {
    const owner = this.owners.get(key);
    if (owner === undefined) return;
    this.owners.delete(key);
    this.owners.set(key, owner);
  }

  invalidateMedia() {
    const retained = { ...this.values };
    for (const [key, revision] of Object.entries(retained)) {
      if (revision.content.format === "markdown") continue;
      this.owners.delete(key);
      delete retained[key];
    }
    this.values = retained;
    return retained;
  }

  private trim() {
    const inactive = [...this.owners].filter(([, owner]) => owner !== this.active);
    if (inactive.length <= 200) return this.values;
    const retained = { ...this.values };
    for (const [key] of inactive.slice(0, inactive.length - 200)) {
      this.owners.delete(key);
      delete retained[key];
    }
    this.values = retained;
    return retained;
  }
}
