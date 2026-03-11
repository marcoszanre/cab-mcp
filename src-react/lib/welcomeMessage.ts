/**
 * Shared default welcome message builder.
 * Used by the orchestrator at runtime and the UI for preview.
 */
export function buildDefaultWelcomeMessage(agentName?: string): string {
  const name = agentName || 'AI Agent'
  return `👋 Hi! I'm ${name} and I've joined the call. To ask me something in the chat, just @mention me using Teams' @ feature and I'll respond!`
}
