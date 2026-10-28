import type { InteractiveProviderAdapter } from "./interactive-provider-adapter";
import { createClaudeAcpAdapter, createCodexAcpAdapter, createGenericAcpAdapter, createOpenCodeAcpAdapter } from "./acp-stdio-adapter";
import { createCodexAppServerAdapter } from "./codex-app-server-adapter";
import type { ProviderAdapterConfig } from "@/lib/provider-adapter-config";

export class AcpProviderRegistry {
  private readonly adapters = new Map<string, InteractiveProviderAdapter>();

  register(adapter: InteractiveProviderAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`ACP adapter '${adapter.id}' is already registered.`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): InteractiveProviderAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

/**
 * The production Bridge registry. First-party adapters remain explicit, while
 * an operator-supplied generic ACP config can add any other provider without
 * changing this registry or shipping another OathLock release.
 */
export function createDefaultAcpProviderRegistry(genericProvider?: ProviderAdapterConfig): AcpProviderRegistry {
  const registry = new AcpProviderRegistry();
  registry.register(createClaudeAcpAdapter());
  // The persistent app-server is the managed Codex path. Keep the old ACP
  // wrapper available only as an explicit compatibility escape hatch; it is
  // never selected implicitly by a provider session or a broker restart.
  registry.register(process.env.M9R_CODEX_LEGACY_ACP === "1" ? createCodexAcpAdapter() : createCodexAppServerAdapter({ id: "codex-acp" }));
  registry.register(createOpenCodeAcpAdapter());
  if (genericProvider?.protocol === "acp-stdio" && !["codex", "claude-code", "opencode"].includes(genericProvider.provider)) {
    registry.register(createGenericAcpAdapter(genericProvider));
  }
  return registry;
}
