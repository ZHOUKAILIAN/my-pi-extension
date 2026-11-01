export function hasCompletedToolTurn(event: { message: any; outcome: string; toolResults: any[]; messageEntryId: string; toolResultEntryIds: string[] }, branch: any[]): boolean {
  if (event.message?.role !== "assistant" || event.message.stopReason !== "toolUse" || event.outcome !== "completed"
      || !Array.isArray(event.message.content) || !Array.isArray(event.toolResults) || !Array.isArray(event.toolResultEntryIds) || !Array.isArray(branch)) return false;
  const calls = event.message.content.filter((block: any) => block?.type === "toolCall");
  if (!calls.length || calls.some((call: any) => typeof call.id !== "string" || !call.id)) return false;
  const callIds = calls.map((call: any) => call.id);
  if (new Set(callIds).size !== callIds.length || event.toolResults.length !== calls.length || event.toolResultEntryIds.length !== calls.length) return false;
  if (event.toolResults.some((result: any) => !result || typeof result.toolCallId !== "string" || typeof result.toolName !== "string" || result.isError === true)) return false;
  const results = new Map(event.toolResults.map((result: any) => [result.toolCallId, result]));
  if (results.size !== calls.length || callIds.some((id: string) => !results.has(id))) return false;
  const ids = [event.messageEntryId, ...event.toolResultEntryIds];
  if (ids.some((id: unknown) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) return false;
  const entries = new Map(branch.map((entry: any) => [entry.id, entry]));
  const assistantEntry: any = entries.get(event.messageEntryId);
  if (assistantEntry?.type !== "message" || assistantEntry.message?.role !== "assistant" || assistantEntry.message.stopReason !== "toolUse" || !Array.isArray(assistantEntry.message.content)) return false;
  const persistedCalls = assistantEntry.message.content.filter((block: any) => block?.type === "toolCall");
  if (persistedCalls.length !== calls.length || persistedCalls.some((call: any, index: number) => call.id !== calls[index].id || call.name !== calls[index].name)) return false;
  return event.toolResultEntryIds.every((id, index) => {
    const result = event.toolResults[index];
    const entry: any = entries.get(id);
    return entry?.type === "message" && entry.message?.role === "toolResult"
      && entry.message.toolCallId === calls[index].id && entry.message.toolName === calls[index].name && entry.message.isError !== true
      && result.toolCallId === calls[index].id && result.toolName === calls[index].name;
  });
}
