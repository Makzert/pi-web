/** Wait until an in-flight prompt has either started its agent run or failed. */
export async function waitForQueuedPromptAdmission(
  promptRunning: boolean,
  isStreaming: () => boolean,
  preflight: Promise<boolean> | null,
): Promise<boolean> {
  if (promptRunning && !isStreaming()) {
    if (!preflight || !await preflight || !isStreaming()) {
      throw new Error("The previous prompt did not start an agent run; retry this queued input");
    }
  }
  return isStreaming();
}
