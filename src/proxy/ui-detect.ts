import type { DownstreamTool, DownstreamResource } from "../connection/types.js";

/**
 * Authoritative UI-capability detection from a LIVE connection.
 *
 * Unlike the registry's heuristic ("UI-capable (detected)" from package deps /
 * keywords), this inspects the actual data the server returned after
 * connecting — so it's ground truth:
 *
 *   - Any tool carrying `_meta.ui.resourceUri` (MCP Apps marker), or
 *   - Any resource whose URI uses the `ui://` scheme (MCP-UI / MCP Apps).
 *
 * Returns which tools/resources triggered it so the gateway can show the user
 * exactly what's UI-capable.
 */
export interface LiveUiResult {
  supportsUi: boolean;
  /** Tool names that declare a UI resource via _meta.ui.resourceUri. */
  uiTools: string[];
  /** Resource URIs using the ui:// scheme. */
  uiResources: string[];
}

export function detectLiveUi(
  tools: Iterable<DownstreamTool>,
  resources: Iterable<DownstreamResource>,
): LiveUiResult {
  const uiTools: string[] = [];
  const uiResources: string[] = [];

  for (const tool of tools) {
    const meta = (tool as { _meta?: unknown })._meta;
    if (hasUiResourceUri(meta)) uiTools.push(tool.name);
  }

  for (const res of resources) {
    if (typeof res.uri === "string" && res.uri.startsWith("ui://")) {
      uiResources.push(res.uri);
    }
  }

  return {
    supportsUi: uiTools.length > 0 || uiResources.length > 0,
    uiTools,
    uiResources,
  };
}

/** True if a tool's _meta carries a `ui.resourceUri` (MCP Apps). */
function hasUiResourceUri(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  const ui = (meta as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") return false;
  const uri = (ui as { resourceUri?: unknown }).resourceUri;
  return typeof uri === "string" && uri.length > 0;
}
