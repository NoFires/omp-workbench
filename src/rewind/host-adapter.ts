// Ported from better-pi-rewind 0.4.0 (MIT, Copyright (c) 2026 Raine) for omp 19.2:
// `session_before_fork` is no longer an extension event, so rewind.ts hooks the branch gate itself.
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

/** Move the conversation back to `entryId`; the prompt goes back into the composer for editing. */
export async function rewindConversation(
	ctx: ExtensionCommandContext,
	entryId: string,
	prompt: string,
	notification: string,
	notificationType: "info" | "warning",
): Promise<{ cancelled: boolean }> {
	if (typeof ctx.navigateTree !== "function") return ctx.branch(entryId);
	const result = await ctx.navigateTree(entryId);
	if (!result.cancelled) {
		ctx.ui.setEditorText(prompt);
		ctx.ui.notify(notification, notificationType);
	}
	return result;
}
