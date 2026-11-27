import { copyFile, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	SessionManager,
	type SessionInfo,
} from "@oh-my-pi/pi-coding-agent";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { ensureInputRouter } from "./input-router";
import { viewKeys, type ViewKey, type ViewTheme } from "./ui";
import { cleanSummary, formatAge, sessionName, STATUS_STYLE, statusKind } from "./agents-format";
import { type PreviewLine, readLatestAssistant, readPreview } from "./session-files";

const HOME = homedir();
const PANEL_MIN_HEIGHT = 14;
/** A session untouched for this long is treated as closed, so archiving cannot race a live omp. */
const ARCHIVE_QUIET_MS = 5 * 60_000;

type Group = "Pinned" | "Working" | "Stopped" | "Completed" | "Failed" | "Idle";
type GroupMode = "directory" | "state";

const GROUP_ORDER: readonly Group[] = ["Pinned", "Working", "Stopped", "Completed", "Failed", "Idle"];

type ListRow =
	| { kind: "header"; label: string; count: number; group?: Group }
	| { kind: "session"; session: SessionInfo; pinned: boolean };

type ViewResult =
	| { kind: "attach"; path: string; id: string; submitted: boolean }
	| { kind: "new"; cwd: string | undefined }
	| { kind: "archive-current"; session: SessionInfo };

/** Side effects the view asks of the session owner while it stays open. */
interface ViewHooks {
	/** Stop the run of `path`; `ok` is false when it cannot be stopped from here. */
	stop(path: string): Promise<HookResult>;
	/** Archive `session` off the session list; `ok` is false when it was kept. */
	archive(session: SessionInfo): Promise<HookResult>;
}

/** Outcome of a Ctrl+X side effect, with the line the view echoes back. */
interface HookResult {
	readonly ok: boolean;
	readonly note: string;
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncate(text, width, "…");
}

function padTo(text: string, width: number): string {
	const w = Math.max(0, width);
	if (w === 0) return "";
	const fitted = truncate(text, w, "…");
	return fitted + " ".repeat(Math.max(0, w - visibleWidth(fitted)));
}

function rightAlign(text: string, width: number): string {
	const w = Math.max(0, width);
	if (w === 0) return "";
	const fitted = truncate(text, w, "…");
	return " ".repeat(Math.max(0, w - visibleWidth(fitted))) + fitted;
}

function shortCwd(cwd: string): string {
	if (!cwd) return "(unknown)";
	return cwd === HOME || cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd;
}

function groupOf(session: SessionInfo, pinned: Set<string>, currentPath: string | undefined, busy: boolean): Group {
	if (pinned.has(session.id)) return "Pinned";
	if (busy && session.path === currentPath) return "Working";
	switch (session.status) {
		case "pending":
			return "Working";
		case "interrupted":
		case "aborted":
			return "Stopped";
		case "complete":
			return "Completed";
		case "error":
			return "Failed";
		default:
			return "Idle";
	}
}

function groupGlyph(group: Group, theme: ViewTheme): string {
	switch (group) {
		case "Pinned":
			return theme.fg("accent", "★");
		case "Working":
			return theme.fg(STATUS_STYLE.working.color, STATUS_STYLE.working.glyph);
		case "Stopped":
			return theme.fg(STATUS_STYLE.stopped.color, STATUS_STYLE.stopped.glyph);
		case "Completed":
			return theme.fg(STATUS_STYLE.done.color, STATUS_STYLE.done.glyph);
		case "Failed":
			return theme.fg(STATUS_STYLE.failed.color, STATUS_STYLE.failed.glyph);
		case "Idle":
			return theme.fg(STATUS_STYLE.idle.color, STATUS_STYLE.idle.glyph);
	}
}

/** omp's own pin store (`/pin`, `/unpin`). */
async function loadPins(): Promise<Set<string>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(getAgentDir(), "session-pins.json"), "utf8"));
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((id): id is string => typeof id === "string"));
	} catch {
		return new Set();
	}
}

/**
 * The fullscreen session list. A rows view: omp draws `render(width)` and hands
 * every key to `handleInput` as raw bytes.
 */
export class WorkbenchAgentsView {
	readonly #sessions: SessionInfo[];
	readonly #haystacks: Map<string, string>;
	readonly #pins: Set<string>;
	readonly #currentPath: string | undefined;
	readonly #hooks: ViewHooks;
	#busy: boolean;
	readonly #here: string;
	readonly #theme: ViewTheme;
	readonly #rows: () => number;
	readonly #requestRender: () => void;
	readonly #done: (result: ViewResult | undefined) => void;

	#query = "";
	#selectedPath: string | undefined;
	#peek = false;
	#groupMode: GroupMode = "directory";
	#finished = false;
	#acting = false;
	#armedArchive: string | undefined;
	#notice: { text: string; tone: "muted" | "warning" | "error" } | undefined;
	readonly #stopped = new Set<string>();
	/** Rows for `#rowsKey`; filtering and grouping run once per query/grouping change. */
	#rowsKey: string | undefined;
	#list: ListRow[] = [];
	#order: SessionInfo[] = [];
	readonly #summaries = new Map<string, string>();
	readonly #summaryPending = new Set<string>();
	readonly #previews = new Map<string, PreviewLine[]>();
	#previewPath: string | undefined;
	#previewLines: PreviewLine[] | undefined;
	#previewError: string | undefined;
	#previewLoading = false;
	#previewToken = 0;

	constructor(
		sessions: SessionInfo[],
		pins: Set<string>,
		currentPath: string | undefined,
		here: string,
		busy: boolean,
		hooks: ViewHooks,
		theme: ViewTheme,
		rows: () => number,
		requestRender: () => void,
		done: (result: ViewResult | undefined) => void,
	) {
		this.#sessions = sessions;
		this.#haystacks = new Map(
			sessions.map(session => [
				session.path,
				[session.title ?? "", session.firstMessage, session.cwd, session.status ?? "", session.id].join(" ").toLowerCase(),
			]),
		);
		this.#pins = pins;
		this.#currentPath = currentPath;
		this.#here = here;
		this.#hooks = hooks;
		this.#busy = busy;
		this.#theme = theme;
		this.#rows = rows;
		this.#requestRender = requestRender;
		this.#done = done;
		this.#selectedPath = currentPath && sessions.some(s => s.path === currentPath) ? currentPath : sessions[0]?.path;
	}

	/** False once the view finished; its keys and the router's interceptor ignore it then. */
	get open(): boolean {
		return !this.#finished;
	}

	/** Close with `result`; later keys are ignored. */
	finish(result: ViewResult | undefined): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#done(result);
	}

	#filtered(): SessionInfo[] {
		const query = this.#query.trim().toLowerCase();
		if (!query) return this.#sessions;
		const tokens = query.split(/\s+/);
		return this.#sessions.filter(session => {
			const haystack = this.#haystacks.get(session.path) ?? "";
			return tokens.every(token => haystack.includes(token));
		});
	}

	#listRows(): ListRow[] {
		const key = `${this.#groupMode}\0${this.#query.trim().toLowerCase()}`;
		if (key === this.#rowsKey) return this.#list;
		const sessions = this.#filtered();
		const rows: ListRow[] = [];
		if (this.#groupMode === "state") {
			const byGroup = new Map<Group, SessionInfo[]>();
			for (const session of sessions) {
				const group = groupOf(session, this.#pins, this.#currentPath, this.#busy);
				const members = byGroup.get(group);
				if (members) members.push(session);
				else byGroup.set(group, [session]);
			}
			for (const group of GROUP_ORDER) {
				const members = byGroup.get(group);
				if (!members) continue;
				rows.push({ kind: "header", label: group, count: members.length, group });
				for (const session of members) rows.push({ kind: "session", session, pinned: this.#pins.has(session.id) });
			}
		} else {
			const pinned = sessions.filter(session => this.#pins.has(session.id));
			if (pinned.length > 0) {
				rows.push({ kind: "header", label: "Pinned", count: pinned.length, group: "Pinned" });
				for (const session of pinned) rows.push({ kind: "session", session, pinned: true });
			}
			const groups = new Map<string, SessionInfo[]>();
			for (const session of sessions) {
				if (this.#pins.has(session.id)) continue;
				const cwd = session.cwd || "(unknown)";
				const members = groups.get(cwd);
				if (members) members.push(session);
				else groups.set(cwd, [session]);
			}
			const hereResolved = resolve(this.#here);
			const currentGroup: Array<[string, SessionInfo[]]> = [];
			const otherGroups: Array<[string, SessionInfo[]]> = [];
			for (const entry of groups) {
				const [cwd] = entry;
				if (cwd !== "(unknown)" && resolve(cwd) === hereResolved) currentGroup.push(entry);
				else otherGroups.push(entry);
			}
			for (const [cwd, members] of [...currentGroup, ...otherGroups]) {
				rows.push({ kind: "header", label: shortCwd(cwd), count: members.length });
				for (const session of members) rows.push({ kind: "session", session, pinned: false });
			}
		}
		this.#rowsKey = key;
		this.#list = rows;
		this.#order = rows.flatMap(row => (row.kind === "session" ? [row.session] : []));
		return rows;
	}

	#selectedSession(): SessionInfo | undefined {
		this.#listRows();
		return this.#order.find(session => session.path === this.#selectedPath) ?? this.#order[0];
	}

	#ensureSelection(): void {
		this.#listRows();
		if (!this.#order.some(session => session.path === this.#selectedPath)) this.#selectedPath = this.#order[0]?.path;
	}

	#move(delta: number): void {
		const sessions = this.#order;
		if (sessions.length === 0) return;
		const current = sessions.findIndex(session => session.path === this.#selectedPath);
		const next = Math.min(sessions.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
		this.#selectedPath = sessions[next]?.path;
		this.#loadPreviewIfOpen();
		this.#requestRender();
	}

	#loadPreviewIfOpen(): void {
		if (!this.#peek) return;
		const selected = this.#selectedSession();
		if (!selected) return;
		if (this.#previewPath === selected.path && (this.#previewLines !== undefined || this.#previewError !== undefined)) return;
		const cached = this.#previews.get(selected.path);
		if (cached) {
			this.#previewPath = selected.path;
			this.#previewLines = cached;
			this.#previewError = undefined;
			this.#previewLoading = false;
			return;
		}
		const token = ++this.#previewToken;
		this.#previewPath = selected.path;
		this.#previewLines = undefined;
		this.#previewError = undefined;
		this.#previewLoading = true;
		this.#requestRender();
		void readPreview(selected.path).then(
			lines => {
				this.#previews.set(selected.path, lines);
				if (token !== this.#previewToken) return;
				this.#previewLines = lines;
				this.#previewError = undefined;
				this.#previewLoading = false;
				this.#requestRender();
			},
			() => {
				if (token !== this.#previewToken) return;
				this.#previewLines = undefined;
				this.#previewError = "(could not read session file)";
				this.#previewLoading = false;
				this.#requestRender();
			},
		);
	}

	/** Ctrl+X: stop the live open session, or arm/archive any session on a second press. */
	async #stopOrArchive(): Promise<void> {
		if (this.#acting) return;
		const selected = this.#selectedSession();
		if (!selected) return;
		this.#acting = true;
		try {
			const isOpen = selected.path === this.#currentPath;
			const alreadyStopped = this.#stopped.has(selected.path);
			if (isOpen && !alreadyStopped) {
				const result = await this.#hooks.stop(selected.path);
				if (result.ok) {
					this.#busy = false;
					selected.status = "interrupted";
					this.#stopped.add(selected.path);
					this.#rowsKey = undefined;
				}
				this.#notice = { text: result.note, tone: result.ok ? "muted" : "warning" };
				if (result.ok || !result.note.startsWith("Session is idle")) {
					this.#requestRender();
					return;
				}
			}
			if (this.#armedArchive !== selected.path) {
				const label = sessionName(selected.title, selected.firstMessage, selected.id);
				this.#armedArchive = selected.path;
				this.#notice = {
					text: isOpen
						? `Ctrl+X again to archive current session "${label}" (starts a new session)`
						: `Ctrl+X again to archive "${label}"`,
					tone: "warning",
				};
				this.#requestRender();
				return;
			}
			this.#armedArchive = undefined;
			if (isOpen) {
				this.finish({ kind: "archive-current", session: selected });
				return;
			}
			const result = await this.#hooks.archive(selected);
			this.#notice = { text: result.note, tone: result.ok ? "muted" : "warning" };
			if (result.ok) this.#forget(selected);
			else this.#requestRender();
		} finally {
			this.#acting = false;
		}
	}

	/** Drop an archived session from the list without closing the view. */
	#forget(session: SessionInfo): void {
		const index = this.#sessions.indexOf(session);
		if (index >= 0) this.#sessions.splice(index, 1);
		this.#haystacks.delete(session.path);
		this.#summaries.delete(session.path);
		this.#summaryPending.delete(session.path);
		this.#previews.delete(session.path);
		this.#stopped.delete(session.path);
		if (this.#armedArchive === session.path) this.#armedArchive = undefined;
		if (this.#previewPath === session.path) {
			this.#previewPath = undefined;
			this.#previewLines = undefined;
			this.#previewError = undefined;
		}
		if (this.#selectedPath === session.path) this.#selectedPath = undefined;
		this.#rowsKey = undefined;
		this.#ensureSelection();
		this.#loadPreviewIfOpen();
		this.#requestRender();
	}

	#togglePeek(): void {
		this.#peek = !this.#peek;
		if (this.#peek) this.#loadPreviewIfOpen();
		this.#requestRender();
	}

	/** Cached summary; the first request for a session starts its tail read. */
	#summaryFor(session: SessionInfo): string {
		const cached = this.#summaries.get(session.path);
		if (cached !== undefined) return cached;
		const fallback = cleanSummary(session.firstMessage) || session.firstMessage;
		if (!this.#summaryPending.has(session.path)) {
			this.#summaryPending.add(session.path);
			const settle = (summary: string): void => {
				this.#summaries.set(session.path, summary);
				this.#summaryPending.delete(session.path);
				this.#requestRender();
			};
			void readLatestAssistant(session.path).then(
				text => settle((text && cleanSummary(text)) || fallback),
				() => settle(fallback),
			);
		}
		return fallback;
	}

	#renderHeader(width: number): string[] {
		const theme = this.#theme;
		const total = this.#sessions.length;
		const projects = new Set(this.#sessions.map(session => session.cwd || "(unknown)")).size;
		const sessionWord = total === 1 ? "session" : "sessions";
		const projectWord = projects === 1 ? "project" : "projects";
		const left =
			theme.bold(theme.fg("accent", " Sessions")) +
			theme.fg("dim", ` · ${total} ${sessionWord} · ${projects} ${projectWord} · by ${this.#groupMode}`);
		const selectedIndex = this.#order.findIndex(session => session.path === this.#selectedPath);
		const pos = this.#order.length > 0 ? `${Math.max(0, selectedIndex) + 1}/${this.#order.length}` : "0/0";
		const right = theme.fg("dim", `${pos} `);
		const rightW = visibleWidth(right);
		const leftFit = fit(left, Math.max(0, width - rightW - 1));
		const gap = Math.max(1, width - visibleWidth(leftFit) - rightW);
		const bar = fit(`${leftFit}${" ".repeat(gap)}${right}`, width);
		const sep = theme.fg("borderMuted", "─".repeat(width));
		return [bar, sep];
	}

	#renderGroupHeader(row: Extract<ListRow, { kind: "header" }>, width: number): string {
		const theme = this.#theme;
		const prefix = row.group ? `${groupGlyph(row.group, theme)} ` : "";
		const countTag = theme.fg("dim", ` ${row.count} `);
		const labelBudget = Math.max(4, width - visibleWidth(prefix) - visibleWidth(countTag) - 2);
		const labelText = fit(row.label, labelBudget);
		const head = `${prefix}${theme.bold(theme.fg("accent", labelText))}${countTag}`;
		const ruleLen = Math.max(0, width - visibleWidth(head));
		return fit(`${head}${theme.fg("borderMuted", "─".repeat(ruleLen))}`, width);
	}

	#renderSessionLine(row: Extract<ListRow, { kind: "session" }>, width: number): string {
		const theme = this.#theme;
		const { session, pinned } = row;
		const selected = session.path === this.#selectedPath;
		const current = session.path === this.#currentPath;
		const style = STATUS_STYLE[statusKind(session.status)];

		const cursor = selected ? theme.fg("accent", "❯ ") : "  ";
		const glyph = `${theme.fg(style.color, style.glyph)} `;
		const glyphW = visibleWidth(style.glyph) + 1;

		const nameW = Math.min(44, Math.max(16, Math.floor(width * 0.3)));
		const statusW = 7;
		const ageW = 4;

		const rawName = sessionName(session.title, session.firstMessage, session.id);
		const pinPrefix = pinned ? theme.fg("accent", "★ ") : "";
		const pinW = pinned ? visibleWidth("★ ") : 0;
		const nameText = fit(rawName, Math.max(0, nameW - pinW));
		const namePad = " ".repeat(Math.max(0, nameW - pinW - visibleWidth(nameText)));
		const styledName = selected ? theme.bold(theme.fg("accent", nameText)) : theme.bold(theme.fg("text", nameText));
		const nameCol = `${pinPrefix}${styledName}${namePad}`;

		const statusCol = current
			? theme.bold(theme.fg("success", padTo("Current", statusW)))
			: theme.fg(style.color, padTo(style.label, statusW));

		const ageCol = theme.fg("dim", rightAlign(formatAge(session.modified), ageW));
		const summaryW = width - 2 - glyphW - nameW - 2 - statusW - 2 - 1 - ageW;

		let line: string;
		if (summaryW >= 8) {
			const summaryText = fit(this.#summaryFor(session), summaryW);
			const summaryPad = " ".repeat(Math.max(0, summaryW - visibleWidth(summaryText)));
			const summaryCol = `${theme.fg("muted", summaryText)}${summaryPad}`;
			line = `${cursor}${glyph}${nameCol}  ${statusCol}  ${summaryCol} ${ageCol}`;
		} else {
			const left = `${cursor}${glyph}${nameCol}  ${statusCol}`;
			const gap = Math.max(1, width - visibleWidth(left) - ageW);
			line = fit(`${left}${" ".repeat(gap)}${ageCol}`, width);
		}

		if (selected) {
			const fitted = fit(line, width);
			return theme.bg("selectedBg", `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`);
		}
		return fit(line, width);
	}

	#renderPeek(width: number, height: number): string[] {
		const theme = this.#theme;
		const selected = this.#selectedSession();
		const name = selected ? sessionName(selected.title, selected.firstMessage, selected.id) : "";
		const maxNameW = Math.max(8, width - 18);
		const lead = selected
			? `${theme.fg("borderAccent", "── ")}${theme.bold("Peek")}${theme.fg("dim", " · ")}${theme.bold(fit(name, maxNameW))} `
			: `${theme.fg("borderAccent", "── ")}${theme.bold("Peek")} `;
		const fillLen = Math.max(0, width - visibleWidth(lead));
		const borderLine = fit(`${lead}${theme.fg("borderAccent", "─".repeat(fillLen))}`, width);
		const meta = selected
			? (() => {
					const style = STATUS_STYLE[statusKind(selected.status)];
					return theme.fg("dim", `${style.glyph} ${style.label} · ${shortCwd(selected.cwd)} · ${formatAge(selected.modified)}`);
				})()
			: "";
		const lines: string[] = [borderLine, fit(meta, width), ""];
		const body: string[] = [];
		if (this.#previewLoading) {
			body.push(theme.fg("dim", "  Loading…"));
		} else if (this.#previewError) {
			body.push(theme.fg("dim", `  ${this.#previewError}`));
		} else if (this.#previewLines?.length) {
			const textBudget = Math.max(0, width - 4);
			for (const item of this.#previewLines) {
				const prefix = item.role === "user" ? theme.fg("accent", "❯") : theme.fg("muted", "●");
				const content = fit(item.text, textBudget);
				const styled = item.role === "user" ? theme.fg("text", content) : theme.fg("muted", content);
				body.push(fit(`  ${prefix} ${styled}`, width));
			}
		} else {
			body.push(theme.fg("dim", "  No messages yet."));
		}
		const budget = Math.max(1, height - lines.length - 1);
		for (const line of body.slice(-budget)) lines.push(line);
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	#renderFooter(width: number): string[] {
		const theme = this.#theme;
		const lines: string[] = [];
		if (this.#notice) {
			lines.push(fit(theme.fg(this.#notice.tone, this.#notice.text), width));
		}
		lines.push(theme.fg("borderMuted", "─".repeat(width)));

		const matchCount = this.#order.length;
		const right = this.#query
			? theme.fg("dim", `${matchCount} ${matchCount === 1 ? "match" : "matches"} `)
			: "";
		const rightW = visibleWidth(right);
		const promptPrefix = theme.fg("accent", "❯ ");
		let promptLeft: string;
		if (this.#query) {
			const cursor = theme.fg("accent", "▏");
			const queryBudget = Math.max(0, width - visibleWidth(promptPrefix) - visibleWidth(cursor) - rightW - (rightW > 0 ? 1 : 0));
			promptLeft = `${promptPrefix}${fit(this.#query, queryBudget)}${cursor}`;
		} else {
			promptLeft = fit(`${promptPrefix}${theme.fg("dim", "Type to filter…")}`, Math.max(0, width - rightW));
		}
		const promptGap = rightW > 0 ? Math.max(1, width - visibleWidth(promptLeft) - rightW) : 0;
		lines.push(rightW > 0 ? fit(`${promptLeft}${" ".repeat(promptGap)}${right}`, width) : fit(promptLeft, width));

		const hints: Array<[string, string]> = [
			["↑↓", "move"],
			["⏎", "attach"],
			["␣", this.#peek ? "close peek" : "peek"],
			["n", "new"],
			["^X", "stop/archive"],
			["t", this.#groupMode === "directory" ? "by state" : "by directory"],
			["esc", "close"],
		];
		const sep = theme.fg("dim", "  ·  ");
		const sepW = 5;
		let hintLine = "";
		let usedW = 0;
		for (const [key, desc] of hints) {
			const piece = `${theme.fg("accent", key)} ${theme.fg("dim", desc)}`;
			const pieceW = visibleWidth(piece);
			const needed = usedW === 0 ? pieceW : sepW + pieceW;
			if (usedW + needed > width) break;
			hintLine += (usedW === 0 ? "" : sep) + piece;
			usedW += needed;
		}
		lines.push(hintLine);
		return lines;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const height = Math.max(PANEL_MIN_HEIGHT, this.#rows());
		const rows = this.#listRows();
		this.#ensureSelection();
		const header = this.#renderHeader(safeWidth);
		const footer = this.#renderFooter(safeWidth);
		const peekCap = Math.max(0, height - header.length - footer.length - 3);
		const peekHeight = this.#peek ? Math.min(16, Math.max(7, Math.floor(height / 3)), peekCap) : 0;
		const listHeight = Math.max(1, height - header.length - footer.length - peekHeight);

		// Lay out first (one line per row, a blank before every header but the
		// first), then draw only the window: summaries are read for visible rows.
		const layout: (ListRow | undefined)[] = [];
		let selectedLine = -1;
		for (const row of rows) {
			if (row.kind === "header" && layout.length > 0) layout.push(undefined);
			if (row.kind === "session" && row.session.path === this.#selectedPath) selectedLine = layout.length;
			layout.push(row);
		}

		const lines: string[] = [...header];
		if (layout.length === 0) {
			if (this.#sessions.length === 0) {
				lines.push(fit(this.#theme.fg("dim", "  No sessions yet · press n to start one"), safeWidth));
			} else {
				lines.push(fit(this.#theme.fg("dim", `  No sessions match "${this.#query.trim()}"`), safeWidth));
				lines.push(fit(this.#theme.fg("dim", "  Esc clears the filter"), safeWidth));
			}
		} else {
			const maxStart = Math.max(0, layout.length - listHeight);
			const start = Math.min(maxStart, Math.max(0, (selectedLine < 0 ? 0 : selectedLine) - Math.floor(listHeight / 2)));
			for (const row of layout.slice(start, start + listHeight)) {
				if (!row) lines.push("");
				else if (row.kind === "header") lines.push(this.#renderGroupHeader(row, safeWidth));
				else lines.push(this.#renderSessionLine(row, safeWidth));
			}
		}
		while (lines.length < header.length + listHeight) lines.push(" ".repeat(safeWidth));
		if (this.#peek) lines.push(...this.#renderPeek(safeWidth, peekHeight));
		lines.push(...footer);
		while (lines.length < height) lines.push(" ".repeat(safeWidth));
		return lines.slice(0, height);
	}

	#setQuery(query: string): void {
		this.#query = query;
		this.#ensureSelection();
		this.#loadPreviewIfOpen();
		this.#requestRender();
	}

	/**
	 * `/resume <id>` when Enter would attach a session recorded in another
	 * directory, and closes the view. The extension `switchSession` passes omp no
	 * cwd-change callback, so only the built-in command can move the project
	 * there; the caller submits it with the same Enter.
	 */
	takeEnter(): string | undefined {
		const selected = this.#selectedSession();
		if (!selected?.cwd || resolve(selected.cwd) === resolve(this.#here)) return undefined;
		this.finish({ kind: "attach", path: selected.path, id: selected.id, submitted: true });
		return `/resume ${selected.id}`;
	}

	handleInput(data: string): void {
		for (const key of viewKeys(data)) {
			if (!this.open) return;
			this.#handle(key);
		}
	}

	#handle({ id, text }: ViewKey): void {
		if (id !== "ctrl+x") {
			this.#notice = undefined;
			this.#armedArchive = undefined;
		}
		const page = Math.max(2, Math.floor(this.#rows() / 5));
		switch (id) {
			case "ctrl+c":
				this.finish(undefined);
				return;
			case "ctrl+x":
				void this.#stopOrArchive();
				return;
			case "escape":
				if (this.#peek) {
					this.#peek = false;
					this.#requestRender();
				} else if (this.#query) {
					this.#setQuery("");
				} else {
					this.finish(undefined);
				}
				return;
			case "up":
				this.#move(-1);
				return;
			case "down":
				this.#move(1);
				return;
			case "pageUp":
				this.#move(-page);
				return;
			case "pageDown":
				this.#move(page);
				return;
			case "home":
				this.#move(-this.#sessions.length);
				return;
			case "end":
				this.#move(this.#sessions.length);
				return;
			case "enter":
			case "right": {
				const selected = this.#selectedSession();
				if (selected) this.finish({ kind: "attach", path: selected.path, id: selected.id, submitted: false });
				return;
			}
			case "space":
				if (this.#query) this.#setQuery(`${this.#query} `);
				else this.#togglePeek();
				return;
			case "backspace":
				if (this.#query) this.#setQuery(this.#query.slice(0, -1));
				return;
			case "left":
				if (this.#peek) {
					this.#peek = false;
					this.#requestRender();
				}
				return;
			case "paste":
				if (text.trim()) this.#setQuery(`${this.#query}${text.replace(/\s+/g, " ").trim()}`);
				return;
			default:
				// With an empty filter `n` and `t` are commands; otherwise every printable key filters.
				if (!this.#query && id === "n") {
					// New sessions start in the directory of the highlighted row.
					this.finish({ kind: "new", cwd: this.#selectedSession()?.cwd || undefined });
				} else if (!this.#query && id === "t") {
					this.#groupMode = this.#groupMode === "directory" ? "state" : "directory";
					this.#ensureSelection();
					this.#requestRender();
				} else if (text) {
					this.#setQuery(this.#query + text);
				}
		}
	}
}

/** The open view; the router's input interceptor reads it for Enter. */
let active: WorkbenchAgentsView | undefined;

/**
 * Called first for every key while the view is open. Enter or → on a session
 * from another directory closes the view and names the command to submit.
 */
export function agentsViewEnter(data: string): string | undefined {
	const view = active;
	if (!view?.open) return undefined;
	const keys = viewKeys(data);
	if (keys.length !== 1 || (keys[0].id !== "enter" && keys[0].id !== "right")) return undefined;
	return view.takeEnter();
}

/**
 * Agents view: every omp session in one fullscreen list. Opened by
 * `/sessions-view`, which the router submits on ← / Alt+A with an empty
 * composer (input-router.ts).
 *
 * Groups by directory, or by state after `t`; pins are omp's own (`/pin`).
 * Enter/→ attaches, Space peeks at the latest messages, `n` starts a new
 * session in the highlighted row's directory, Ctrl+X stops the open session's
 * live run; pressing Ctrl+X twice archives any session (archiving the open
 * session starts a new session first; other sessions changed in the last 5
 * minutes are kept), typing filters, Esc closes.
 *
 * Sessions from other directories go through the built-in `/resume` and
 * `/move`, the only commands that change the project directory. omp 19.2 lets
 * an extension set the composer text but not submit it: attach reuses the
 * Enter that picked the row, "new here" leaves `/move` in the composer.
 */
export async function showAgentsView(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("sessions-view needs the interactive TUI", "warning");
		return;
	}

	let sessions: SessionInfo[];
	let pins: Set<string>;
	try {
		const listing = await SessionManager.listAllForPicker();
		[sessions, pins] = await Promise.all([listing.complete, loadPins()]);
	} catch (error) {
		ctx.ui.notify(`Could not list sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const archivedDir = join(getAgentDir(), "archived-sessions");
	const getDropSession = (): ((file: string) => Promise<void>) | undefined => {
		// `SessionManager.dropSession` exists at runtime; extensions are handed the readonly Pick.
		const manager = ctx.sessionManager;
		const candidate = "dropSession" in manager ? manager.dropSession : undefined;
		return typeof candidate === "function" ? (candidate.bind(manager) as (file: string) => Promise<void>) : undefined;
	};
	const archiveSession = async (session: SessionInfo, options?: { skipQuietCheck?: boolean }): Promise<HookResult> => {
		if (session.path === ctx.sessionManager.getSessionFile()) {
			return { ok: false, note: "Switch to another session before archiving this one" };
		}
		const drop = getDropSession();
		if (!drop) {
			return { ok: false, note: "This omp build cannot delete sessions from an extension" };
		}
		const quiet = await stat(session.path).then(
			info => Date.now() - info.mtimeMs,
			() => undefined,
		);
		if (quiet === undefined) return { ok: false, note: "Session file is gone" };
		if (!options?.skipQuietCheck && quiet < ARCHIVE_QUIET_MS) {
			return {
				ok: false,
				note: `Changed ${formatAge(new Date(Date.now() - quiet))} ago — close its omp first, then archive`,
			};
		}
		const copy = join(archivedDir, `${session.id}.jsonl`);
		try {
			await mkdir(archivedDir, { recursive: true });
			await copyFile(session.path, copy);
			await cp(session.path.slice(0, -".jsonl".length), join(archivedDir, session.id), {
				recursive: true,
			}).catch(() => undefined);
			await drop(session.path);
			// The index backend may defer the unlink; the session is quiet, so remove it here too.
			await rm(session.path, { force: true });
			await rm(session.path.slice(0, -".jsonl".length), { recursive: true, force: true });
		} catch (error) {
			return { ok: false, note: `Archive failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		return { ok: true, note: `Archived ${sessionName(session.title, session.firstMessage, session.id)} → ${archivedDir}` };
	};
	const hooks: ViewHooks = {
		stop: async path => {
			if (path !== ctx.sessionManager.getSessionFile()) {
				return { ok: false, note: "Only the open session's run can be stopped; other sessions run in their own omp process" };
			}
			if (ctx.isIdle()) return { ok: false, note: "Session is idle — Ctrl+X archives it once it is stopped" };
			ctx.abort();
			return { ok: true, note: "Stopped · Ctrl+X twice to archive" };
		},
		archive: session => archiveSession(session),
	};

	const result = await ctx.ui.custom<ViewResult | undefined>((ui, _theme, _keybindings, done) => {
		const view = new WorkbenchAgentsView(
			sessions,
			pins,
			ctx.sessionManager.getSessionFile(),
			ctx.sessionManager.getCwd(),
			!ctx.isIdle(),
			hooks,
			ctx.ui.theme,
			() => ui.size().rows,
			() => ui.requestRender(),
			done,
		);
		active = view;
		return view;
	}, { overlay: true, fullscreen: true });
	active = undefined;

	if (!result) return;
	if (result.kind === "new") {
		const here = ctx.sessionManager.getCwd();
		let target = result.cwd && resolve(result.cwd) !== resolve(here) ? result.cwd : undefined;
		if (target && !(await stat(target).then(s => s.isDirectory(), () => false))) {
			ctx.ui.notify(`${target} no longer exists; new session starts in ${here}`, "warning");
			target = undefined;
		}
		try {
			await ctx.waitForIdle();
			const created = await ctx.newSession();
			if (created.cancelled) {
				ctx.ui.notify("New session cancelled", "warning");
				return;
			}
		} catch (error) {
			ctx.ui.notify(`Could not start a new session: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		} finally {
			ensureInputRouter(ctx);
		}
		if (target) {
			ctx.ui.setEditorText(`/move "${target}"`);
			ctx.ui.notify(`New session started in ${here} · press Enter to move it to ${target}`, "info");
		}
		return;
	}
	if (result.kind === "archive-current") {
		if (!getDropSession()) {
			ctx.ui.notify("This omp build cannot delete sessions from an extension", "warning");
			return;
		}
		const exists = await stat(result.session.path).then(
			() => true,
			() => false,
		);
		if (!exists) {
			ctx.ui.notify("Session file is gone", "warning");
			return;
		}
		try {
			await ctx.waitForIdle();
			const created = await ctx.newSession();
			if (created.cancelled) {
				ctx.ui.notify("Archive cancelled", "warning");
				return;
			}
		} catch (error) {
			ctx.ui.notify(`Could not switch session before archiving: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		} finally {
			ensureInputRouter(ctx);
		}
		const outcome = await archiveSession(result.session, { skipQuietCheck: true });
		ctx.ui.notify(outcome.ok ? `${outcome.note} · started a new session` : outcome.note, outcome.ok ? "info" : "warning");
		return;
	}
	if (result.submitted) return;
	if (result.path === ctx.sessionManager.getSessionFile()) {
		ctx.ui.notify("Already in this session", "info");
		return;
	}
	try {
		const switched = await ctx.switchSession(result.path);
		if (switched.cancelled) ctx.ui.notify("Session switch cancelled", "warning");
	} catch (error) {
		ctx.ui.notify(`Could not switch session: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ensureInputRouter(ctx);
	}
}

export function registerAgentsView(pi: ExtensionAPI): void {
	pi.registerCommand("sessions-view", {
		description: "All-project session browser with preview and attach",
		handler: async (_args, ctx) => showAgentsView(ctx),
	});
}
