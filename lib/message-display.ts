import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

// Pi preserves Responses message phases inside each text block's signature.
// Other providers use opaque signatures; never infer a phase from text content.
export function getTextPhase(block: AssistantContentBlock): "commentary" | "final_answer" | undefined {
  if (block.type !== "text" || typeof block.textSignature !== "string") return undefined;
  try {
    const signature = JSON.parse(block.textSignature);
    if (signature?.v === 1 && typeof signature.id === "string"
      && (signature.phase === "commentary" || signature.phase === "final_answer")) {
      return signature.phase;
    }
  } catch { /* Opaque or incomplete provider signature. */ }
  return undefined;
}

export function hasAssistantPhase(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && message.content.some((block) => getTextPhase(block) !== undefined);
}

export function isGroupAnchor(message: AgentMessage): boolean {
  return message.role === "user" || (message.role === "custom" && message.customType === "compaction");
}

// Explicit phases own their presentation; the legacy last-answer heuristic
// must never consume them, including when a later background reply arrives.
export function findLegacyGroupEnd(messages: AgentMessage[], start: number): number {
  let end = start + 1;
  while (end < messages.length && !isGroupAnchor(messages[end]) && !hasAssistantPhase(messages[end])) end++;
  return end;
}

export function getPhasedAssistantParts(message: AssistantMessage): {
  kind: "process" | "answer";
  blocks: AssistantContentBlock[];
}[] {
  const parts: { kind: "process" | "answer"; blocks: AssistantContentBlock[] }[] = [];
  for (const block of getDisplayableAssistantBlocks(message)) {
    const kind = getTextPhase(block) === "commentary" || !isFinalAnswerBlock(block) ? "process" : "answer";
    const previous = parts.at(-1);
    if (previous?.kind === kind) previous.blocks.push(block);
    else parts.push({ kind, blocks: [block] });
  }
  // An error must remain visible even if all emitted text was commentary.
  if (getAssistantErrorMessage(message) && parts.at(-1)?.kind !== "answer") {
    parts.push({ kind: "answer", blocks: [] });
  }
  return parts;
}

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

export function isVisualToolCallBlock(block: AssistantContentBlock): boolean {
  if (block.type !== "toolCall") return false;
  const legacy = block as ToolCallContent & { name?: unknown };
  return block.toolName === "node_video"
    || block.toolName === "node_video_model"
    || block.toolName === "node_image"
    || block.toolName === "node_image_model"
    || block.toolName === "node_image_user"
    || legacy.name === "node_video"
    || legacy.name === "node_video_model"
    || legacy.name === "node_image"
    || legacy.name === "node_image_model"
    || legacy.name === "node_image_user";
}

export function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image" || isVisualToolCallBlock(block);
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}
