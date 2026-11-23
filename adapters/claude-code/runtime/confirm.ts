/**
 * Claude Code native confirmation channel declaration (closure design §5.1,
 * appendix K.2).
 *
 * 2.1.326 renders an MCP server's `elicitation/create` form in its own TUI,
 * both during a tool call and at idle, and returns the user's click to the
 * server that asked. The plugin-level module-hook API (`$.ui.ask`) is gated
 * behind feature flags in this version and is not used.
 *
 * The range is the adapter's verified compatibility interval (appendix A.1);
 * outside it the channel stays silent and `human_interaction_attested` stays
 * unknown rather than being guessed.
 */

import type { McpConfirmHostSpec } from "@evoplug/host-runtime";

export const CLAUDE_MCP_CONFIRM_FLAG = "--mcp-confirm";

export const CLAUDE_CONFIRM_SPEC: McpConfirmHostSpec = Object.freeze({
  host_id: "claude-code",
  server_name: "evoplug_confirm",
  mechanism: "mcp_elicitation",
  supported_range: ">=2.1.304 <2.2.0",
  carrier_event: "UserPromptSubmit"
});
