// Ported from better-pi-rewind 0.4.0 (MIT, Copyright (c) 2026 Raine) for omp 19.2:
// pi-tui's SelectList became a plain rows list with omp key ids.
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import { viewKeys, type ViewTheme } from "../ui.ts";
import type { RestoreAction } from "./restore-actions.ts";

export interface RestoreDetails {
	prompt: string;
	timestamp: string;
	files: string[];
	additions: number;
	deletions: number;
	comparisonErrors: number;
}

export function relativeAge(timestamp: string, now = Date.now()): string | undefined {
	const time = Date.parse(timestamp);
	if (!Number.isFinite(time)) return undefined;
	const seconds = Math.max(0, Math.floor((now - time) / 1000));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

/** Action menu after picking a checkpoint: ↑/↓ move, Enter picks, Esc cancels. */
export class RestoreSelector {
	private selected = 0;
	private readonly details: RestoreDetails;
	private readonly actions: RestoreAction[];
	private readonly theme: ViewTheme;
	private readonly done: (action: RestoreAction | undefined) => void;

	constructor(
		details: RestoreDetails,
		actions: RestoreAction[],
		theme: ViewTheme,
		done: (action: RestoreAction | undefined) => void,
	) {
		this.details = details;
		this.actions = actions;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		for (const { id } of viewKeys(data)) {
			if (id === "up") {
				this.selected = (this.selected + this.actions.length - 1) % this.actions.length;
			} else if (id === "down") {
				this.selected = (this.selected + 1) % this.actions.length;
			} else if (id === "enter") {
				this.done(this.actions[this.selected]);
				return;
			} else if (id === "escape" || id === "ctrl+c") {
				this.done(undefined);
				return;
			}
		}
	}

	render(width: number): string[] {
		const { details, theme } = this;
		const action = this.actions[this.selected];
		// Four call sites share the one wrap width.
		const lines = (text: string): string[] => wrap(text, Math.max(1, width));
		const prompt = wrap(details.prompt.replace(/\s+/g, " ").trim(), Math.max(1, width - 4));
		const age = relativeAge(details.timestamp);
		const out = [
			"", theme.bold(theme.fg("accent", "Rewind")), "",
			...lines("Confirm you want to restore to the point before you sent this message:"), "",
			...prompt.slice(0, 4).map((line) => `${theme.fg("muted", "│")} ${line}`),
			...(prompt.length > 4 ? [theme.fg("muted", "│ ...")] : []),
			...(age ? [theme.fg("muted", `│ (${age})`)] : []), "",
		];
		if (action?.cancel) {
			out.push(theme.fg("muted", "Nothing will be changed."));
		} else {
			out.push(...lines(theme.fg("muted", action?.restoreConversation
				? "The conversation will be rewound to this point."
				: "The conversation will be kept.")));
			if (action?.restoreCode && details.files.length > 0) {
				const stats = `${theme.fg("success", `+${details.additions}`)} ${theme.fg("error", `-${details.deletions}`)}`;
				out.push(...lines(`The code will be restored (${stats}) in:`));
				out.push(...details.files.slice(0, 5).map((file) => theme.fg("muted", `  ${file}`)));
				if (details.files.length > 5) out.push(theme.fg("muted", `  and ${details.files.length - 5} more files`));
			} else {
				out.push(theme.fg("muted", details.files.length === 0
					? "Checkpointed code already matches." : "The current code will be kept."));
			}
			out.push(...lines(theme.fg(action?.resetGit ? "warning" : "muted", action?.resetGit
				? "Git history will be reset after an additional confirmation."
				: "Git history will be kept.")));
		}
		if (details.comparisonErrors > 0) out.push(...lines(theme.fg("warning", "Some files could not be compared. Change totals may be incomplete.")));
		out.push("");
		this.actions.forEach((entry, index) => {
			const label = `${index + 1}. ${entry.label}`;
			out.push(index === this.selected ? theme.bold(theme.fg("accent", `❯ ${label}`)) : `  ${label}`);
		});
		out.push("", ...lines(theme.fg("dim", "↑↓ navigate  enter select  esc/ctrl+c cancel")));
		return out.map((line) => truncate(line, Math.max(0, width), ""));
	}
}
