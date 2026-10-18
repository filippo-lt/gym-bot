/** Best-effort fallback send after the main answer went out: a failure here must not fail the update (inbox retry). */
export async function trySendFallback(send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error("chart: fallback send failed", error instanceof Error ? error.name : "");
  }
}
