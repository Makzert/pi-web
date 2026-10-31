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
  return message.role === "user" || (message.role === "custom" && (
    message.customType === "compaction"
    || message.customType === "node-bg-result"
    || message.customType === "node-worker-result"
    || message.customType === "node-worker-input-required"
  ));
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

export interface MessageDisplayPart {
  messageIndex: number;
  blocks?: AssistantContentBlock[];
  isLastPart?: boolean;
}

export interface MessageDisplayGroup {
  kind: "message" | "process" | "answer" | "preview";
  anchorIndex: number;
  parts: MessageDisplayPart[];
  isLive: boolean;
}

// Build one presentation plan for phased and legacy messages. A phase boundary
// protects answers, but must not strand subsequent unclassified tool/thinking
// messages outside process details. Receipt boundaries protect old answers too;
// unlike users and compactions, the receipt itself belongs inside the new group.
export function getMessageDisplayGroups(
  messages: AgentMessage[],
  options: { isRunning?: boolean } = {},
): MessageDisplayGroup[] {
  const groups: MessageDisplayGroup[] = [];
  let anchorIndex = -1;
  const append = (kind: MessageDisplayGroup["kind"], part: MessageDisplayPart) => {
    const previous = groups.at(-1);
    if (kind === "process" && previous?.kind === kind && previous.anchorIndex === anchorIndex) {
      previous.parts.push(part);
    } else {
      groups.push({ kind, anchorIndex, parts: [part], isLive: false });
    }
  };
  const appendAssistant = (
    messageIndex: number,
    parts: { kind: "process" | "answer" | "preview"; blocks: AssistantContentBlock[] }[],
  ) => parts.forEach((part, index) => append(part.kind, {
    messageIndex, blocks: part.blocks, isLastPart: index === parts.length - 1,
  }));

  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (isGroupAnchor(message)) anchorIndex = index;
    if (message.role === "user" || (message.role === "custom" && message.customType === "compaction")) {
      append("message", { messageIndex: index++ });
      continue;
    }
    if (hasAssistantPhase(message)) {
      appendAssistant(index++, getPhasedAssistantParts(message));
      continue;
    }

    // Keep the legacy trailing-answer heuristic local to an unclassified run;
    // it cannot consume a native answer or cross a user/receipt boundary.
    const end = findLegacyGroupEnd(messages, index);
    let finalIndex = -1;
    for (let candidate = end - 1; candidate >= index; candidate--) {
      const entry = messages[candidate];
      if (entry.role !== "assistant") continue;
      if (finalIndex === -1) finalIndex = candidate;
      if (splitFinalAssistantBlocks(entry).answerBlocks.some((block) => (
        isVisualToolCallBlock(block) || block.type === "image"
        || (block.type === "text" && block.text.trim().length > 0)
      ))) {
        finalIndex = candidate;
        break;
      }
    }
    for (; index < end; index++) {
      const entry = messages[index];
      if (entry.role === "assistant") {
        const parts: { kind: "process" | "answer" | "preview"; blocks: AssistantContentBlock[] }[] = [];
        const split = index === finalIndex ? splitFinalAssistantBlocks(entry) : {
          processBlocks: getDisplayableAssistantBlocks(entry), answerBlocks: [],
        };
        for (const block of split.processBlocks) {
          const kind = isVisualToolCallBlock(block) ? "preview" : "process";
          const previous = parts.at(-1);
          if (previous?.kind === kind) previous.blocks.push(block);
          else parts.push({ kind, blocks: [block] });
        }
        if (split.answerBlocks.length > 0 || (index >= finalIndex && getAssistantErrorMessage(entry))) {
          parts.push({ kind: "answer", blocks: split.answerBlocks });
        }
        appendAssistant(index, parts);
      } else if (entry.role === "custom") {
        // Node receipts are process data even when display=true. Other visible
        // extension messages (notably /direct replies) are the actual output.
        const isProcess = isGroupAnchor(entry) || entry.display === false;
        append(isProcess ? "process" : "message", { messageIndex: index });
      } else if (entry.role !== "toolResult") {
        // Shell executions are independent user-visible actions. Tool results
        // remain attached to their calls through MessageView's result map.
        append("message", { messageIndex: index });
      }
    }
  }

  if (options.isRunning) {
    // An opaque/legacy text message is not proof that a running turn finished.
    // Only a native final answer can close current work before agent settlement.
    const lastAnswer = groups.findLastIndex((group) => group.kind === "answer" && group.parts.some((part) => (
      part.blocks?.some((block) => getTextPhase(block) === "final_answer")
    )));
    groups.forEach((group, index) => {
      group.isLive = group.kind === "process" && group.anchorIndex === anchorIndex && index > lastAnswer;
    });
  }
  return groups;
}
