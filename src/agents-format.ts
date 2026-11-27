/**
 * Pure formatting and status-style helpers for the agents view.
 */

export type StatusKind = "working" | "done" | "failed" | "stopped" | "idle";

export interface StatusStyle {
	readonly glyph: string;
	readonly label: string;
	readonly color: string;
}

export const STATUS_STYLE: Record<StatusKind, StatusStyle> = {
	working: { glyph: "●", label: "Working", color: "warning" },
	done: { glyph: "✓", label: "Done", color: "success" },
	failed: { glyph: "✗", label: "Failed", color: "error" },
	stopped: { glyph: "■", label: "Stopped", color: "warning" },
	idle: { glyph: "○", label: "Idle", color: "dim" },
};

export function statusKind(status: string | undefined): StatusKind {
	switch (status) {
		case "pending":
			return "working";
		case "complete":
			return "done";
		case "error":
			return "failed";
		case "interrupted":
		case "aborted":
			return "stopped";
		default:
			return "idle";
	}
}

export function formatAge(date: Date, now = Date.now()): string {
	const ms = Math.max(0, now - date.getTime());
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
	return `${Math.floor(ms / 86_400_000)}d`;
}

export function cleanSummary(text: string): string {
	return text
		.replace(/[\uFE0E\uFE0F\u200D]/g, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/~~/g, "")
		.replace(/^[ \t]*(?:[-*+]|\d+\.)\s+/gm, "")
		.replace(/\|+(?:\s*:?-{2,}:?\s*\|+)+\s*(?::?-{2,}:?\s*\|*)?|\|?\s*(?::?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?/g, " ")
		.replace(/\|/g, " · ")
		.replace(/[*_#>]+/g, "")
		.replace(/\s+/g, " ")
		.replace(/(?:\s*·\s*){2,}/g, " · ")
		.replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, "")
		.trim();
}

export function sessionName(title: string | undefined, firstMessage: string, id: string): string {
	const trimmedTitle = title?.trim();
	const raw = trimmedTitle
		? (trimmedTitle.split("\n")[0] ?? trimmedTitle)
		: (firstMessage.trim().split("\n")[0] ?? "").slice(0, 42);
	const cleaned = cleanSummary(raw);
	return cleaned || `Untitled · ${id.slice(0, 8)}`;
}
