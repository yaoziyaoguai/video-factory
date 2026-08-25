import type { Capability, Provider, ProviderSelector } from "./types.js";

export class ProviderRegistry {
  private readonly providersById = new Map<string, Provider<any, any>>();
  private readonly providerIdsByCapability = new Map<Capability, string[]>();

  register<TInput, TOutput>(provider: Provider<TInput, TOutput>): void {
    if (this.providersById.has(provider.id)) {
      throw new Error(`Provider '${provider.id}' is already registered.`);
    }

    this.providersById.set(provider.id, provider);
    const ids = this.providerIdsByCapability.get(provider.capability) ?? [];
    ids.push(provider.id);
    this.providerIdsByCapability.set(provider.capability, ids);
  }

  replace<TInput, TOutput>(provider: Provider<TInput, TOutput>): void {
    const existing = this.providersById.get(provider.id);
    if (existing) {
      this.providersById.set(provider.id, provider);
      if (existing.capability !== provider.capability) {
        this.removeCapabilityIndex(existing.capability, provider.id);
        const ids = this.providerIdsByCapability.get(provider.capability) ?? [];
        if (!ids.includes(provider.id)) {
          ids.push(provider.id);
        }
        this.providerIdsByCapability.set(provider.capability, ids);
      }
      return;
    }

    this.register(provider);
  }

  resolve<TInput = unknown, TOutput = unknown>(selector: ProviderSelector): Provider<TInput, TOutput> {
    if (selector.providerId) {
      const provider = this.providersById.get(selector.providerId);
      if (!provider) {
        throw new Error(`Provider '${selector.providerId}' is not registered.`);
      }
      if (provider.capability !== selector.capability) {
        throw new Error(
          `Provider '${selector.providerId}' cannot serve '${selector.capability}'. It serves '${provider.capability}'.`,
        );
      }
      return provider as Provider<TInput, TOutput>;
    }

    const ids = this.providerIdsByCapability.get(selector.capability) ?? [];
    const providerId = ids[0];
    if (!providerId) {
      throw new Error(`No provider registered for capability '${selector.capability}'.`);
    }

    return this.providersById.get(providerId) as Provider<TInput, TOutput>;
  }

  list(capability?: Capability): Provider<any, any>[] {
    if (!capability) {
      return Array.from(this.providersById.values());
    }

    return (this.providerIdsByCapability.get(capability) ?? []).map((id) => {
      const provider = this.providersById.get(id);
      if (!provider) {
        throw new Error(`Provider registry is inconsistent for '${id}'.`);
      }
      return provider;
    });
  }

  private removeCapabilityIndex(capability: Capability, providerId: string): void {
    const ids = this.providerIdsByCapability.get(capability) ?? [];
    const updated = ids.filter((id) => id !== providerId);
    if (updated.length) {
      this.providerIdsByCapability.set(capability, updated);
    } else {
      this.providerIdsByCapability.delete(capability);
    }
  }
}
