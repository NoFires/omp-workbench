// Ported from better-pi-rewind 0.4.0 (MIT, Copyright (c) 2026 Raine) for omp 19.2:
// the pi-tui Component/select-list API became a plain rows view with omp key ids.
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { viewKeys, type ViewTheme } from "../ui.ts";

export interface RewindSelectorItem {
	id?: string;
	prompt: string;
	filesChanged: number;
	files?: string[];
	additions: number;
	deletions: number;
	current?: boolean;
}

/** Prompt picker of the rewind selector: ↑/↓ move, Enter picks, Esc cancels. */
export class RewindSelector {
	private selectedIndex: number;
	private readonly maxVisible = 8;
	private readonly items: RewindSelectorItem[];
	private readonly theme: ViewTheme;
	private readonly done: (item: RewindSelectorItem | undefined) => void;

	constructor(
		items: RewindSelectorItem[],
		theme: ViewTheme,
		done: (item: RewindSelectorItem | undefined) => void,
	) {
		this.items = items;
		this.theme = theme;
		this.done = done;
		this.selectedIndex = Math.max(0, items.length - 1);
	}

	render(width: number): string[] {
		const lines = [
			"",
			this.theme.bold(this.theme.fg("accent", "Rewind")),
			"",
			"Restore the code and/or conversation to the point before...",
			"",
		];
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible),
		);
		const endIndex = Math.min(this.items.length, startIndex + this.maxVisible);

		for (let index = startIndex; index < endIndex; index += 1) {
			const item = this.items[index];
			if (!item) continue;
			const selected = index === this.selectedIndex;
			const cursor = selected ? this.theme.fg("accent", "❯ ") : "  ";
			const label = item.current ? "(current)" : item.prompt.replace(/\s+/g, " ").trim();
			const text = truncate(label, Math.max(1, width - 2), "...");
			lines.push(cursor + (selected ? this.theme.bold(this.theme.fg("accent", text)) : text));

			if (!item.current) {
				const stats = item.filesChanged === 0
					? "No code changes"
					: `${item.files?.length ? item.files.slice(0, 2).join(", ") + (item.files.length > 2 ? ` and ${item.files.length - 2} more` : "") : `${item.filesChanged} ${item.filesChanged === 1 ? "file" : "files"} changed`} ${this.theme.fg("success", `+${item.additions}`)} ${this.theme.fg("error", `-${item.deletions}`)}`;
				lines.push(`  ${this.theme.fg("muted", stats)}`);
			}
			lines.push("");
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			lines.push(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.items.length})`));
		}
		return lines.map((line) => truncate(line, Math.max(0, width), ""));
	}

	handleInput(data: string): void {
		for (const { id } of viewKeys(data)) {
			if (id === "up") {
				this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
			} else if (id === "down") {
				this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
			} else if (id === "enter") {
				this.done(this.items[this.selectedIndex]);
				return;
			} else if (id === "escape" || id === "ctrl+c") {
				this.done(undefined);
				return;
			}
		}
	}
}
