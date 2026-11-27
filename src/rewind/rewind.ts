// Ported from better-pi-rewind 0.4.0 (MIT, Copyright (c) 2026 Raine) for omp 19.2. Changes: the
// two selectors are rows views (see those files), the Esc-Esc shortcut moved to input-router.ts,
// and only /checkpoint is registered (/rewind is omp's built-in /branch alias).
import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import { relative, resolve } from "node:path";
import {
	CheckpointHistory,
	captureFileVersion,
	captureTrackedFiles,
	createSnapshotRecord,
	getCheckpointDiff,
	makeTrackingPath,
	recordsFromEntries,
	restoreCheckpoint,
} from "./file-history.ts";
import {
	captureGitCheckpoint,
	getGitResetPlan,
	resetGitCommits,
	type GitResetPlan,
	type GitResetTarget,
} from "./git-history.ts";
import { rewindConversation } from "./host-adapter.ts";
import { RewindSelector, type RewindSelectorItem } from "./rewind-selector.ts";
import { restoreSummary } from "./restore-summary.ts";
import { RestoreSelector } from "./restore-selector.ts";
import { buildRestoreActions, gitResetActionLabel, type RestoreAction } from "./restore-actions.ts";
import { toolInputPaths } from "./tool-input-paths.ts";
import {
	REWIND_ENTRY_TYPE,
	REWIND_ENTRY_VERSION,
	type CheckpointUpdateRecord,
	type RestoreResult,
} from "./types.ts";

let selector: ((ctx: ExtensionCommandContext) => Promise<void>) | undefined;

/** Open the rewind picker (Esc Esc in input-router.ts, or /checkpoint). */
export function openRewind(ctx: ExtensionCommandContext): Promise<void> {
	return selector?.(ctx) ?? Promise.resolve();
}

interface RuntimeState {
	history: CheckpointHistory;
	storeId: string;
	currentCheckpointId?: string;
	pendingUserMessage: boolean;
}

function userPrompt(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function latestUserEntry(entries: readonly SessionEntry[]): SessionEntry | undefined {
	return [...entries].reverse().find((entry) => userPrompt(entry) !== undefined);
}

function gitResetMessage(target: GitResetTarget): string {
	if (target.kind === "amended-commit") return "amended commit rolled back";
	const count = target.commitCount;
	return `${count} ${count === 1 ? "commit" : "commits"} reset`;
}

function notifyErrors(ctx: ExtensionContext, errors: Array<{ path: string; error: string }>, action: string): void {
	if (errors.length === 0) return;
	const first = errors[0];
	const detail = first ? `: ${first.path}: ${first.error}` : "";
	ctx.ui.notify(`${action} had ${errors.length} ${errors.length === 1 ? "error" : "errors"}${detail}`, "warning");
}

export function registerRewind(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	let state: RuntimeState | undefined;
	let suppressBranchPromptFor: string | undefined;

	function rebuildState(ctx: ExtensionContext): RuntimeState {
		const history = new CheckpointHistory(recordsFromEntries(ctx.sessionManager.getEntries()));
		const branchHistory = new CheckpointHistory(recordsFromEntries(ctx.sessionManager.getBranch()));
		state = {
			history,
			storeId: ctx.sessionManager.getSessionId(),
			currentCheckpointId: branchHistory.latest()?.userEntryId,
			pendingUserMessage: false,
		};
		return state;
	}

	function getState(ctx: ExtensionContext): RuntimeState {
		if (!state || state.storeId !== ctx.sessionManager.getSessionId()) return rebuildState(ctx);
		return state;
	}

	async function resetCheckpointGit(
		ctx: ExtensionContext,
		plan: Extract<GitResetPlan, { kind: "available" }>,
	): Promise<GitResetTarget | undefined> {
		const target = plan.target;
		const title = target.kind === "amended-commit"
			? "Roll back amended commit?"
			: `Hard-reset ${target.commitCount} ${target.commitCount === 1 ? "commit" : "commits"}?`;
		const confirmed = await ctx.ui.confirm(
			title,
			"This runs git reset --hard. Uncommitted working tree and index changes may be discarded. Checkpointed files are restored afterward.",
		);
		if (!confirmed) return undefined;
		try {
			const resetTarget = await resetGitCommits(plan, ctx.cwd);
			ctx.ui.notify(gitResetMessage(resetTarget), "info");
			return resetTarget;
		} catch (error) {
			ctx.ui.notify(`Git reset failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		rebuildState(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "user") getState(ctx).pendingUserMessage = true;
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const current = getState(ctx);
		if (!current.pendingUserMessage) return;
		current.pendingUserMessage = false;

		const entry = latestUserEntry(ctx.sessionManager.getBranch());
		const prompt = entry ? userPrompt(entry) : undefined;
		if (!entry || !prompt) return;
		if (current.history.get(entry.id)) {
			current.currentCheckpointId = entry.id;
			return;
		}

		const [captured, git] = await Promise.all([
			captureTrackedFiles(current.history.getTrackedPaths(), ctx.cwd, agentDir, current.storeId),
			captureGitCheckpoint(ctx.cwd),
		]);
		const record = createSnapshotRecord(entry.id, prompt, ctx.cwd, captured.files, git);
		pi.appendEntry(REWIND_ENTRY_TYPE, record);
		current.history.apply(record);
		current.currentCheckpointId = entry.id;
		notifyErrors(ctx, captured.errors, "Checkpoint capture");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
		const current = getState(ctx);
		const checkpoint = current.currentCheckpointId
			? current.history.get(current.currentCheckpointId)
			: current.history.latest();
		if (!checkpoint) return;

		const files: CheckpointUpdateRecord["files"] = {};
		for (const inputPath of toolInputPaths(event.toolName, event.input)) {
			const absolutePath = resolve(ctx.cwd, inputPath);
			const trackingPath = makeTrackingPath(checkpoint.cwd, absolutePath);
			if (checkpoint.files[trackingPath]) continue;

			try {
				files[trackingPath] = await captureFileVersion(absolutePath, agentDir, current.storeId);
			} catch (error) {
				ctx.ui.notify(
					`Could not checkpoint ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
		if (Object.keys(files).length === 0) return;
		const record: CheckpointUpdateRecord = {
			version: REWIND_ENTRY_VERSION,
			kind: "update",
			userEntryId: checkpoint.userEntryId,
			files,
		};
		pi.appendEntry(REWIND_ENTRY_TYPE, record);
		current.history.apply(record);
	});

	pi.on("session_before_branch", async (event, ctx) => {
		if (suppressBranchPromptFor === event.entryId) {
			suppressBranchPromptFor = undefined;
			return;
		}
		const current = getState(ctx);
		const checkpoint = current.history.get(event.entryId);
		if (!checkpoint || !ctx.hasUI) return;

		const [diff, gitPlan] = await Promise.all([
			getCheckpointDiff(current.history, checkpoint, agentDir),
			getGitResetPlan(checkpoint.git, ctx.cwd),
		]);
		notifyErrors(ctx, diff.errors, "Checkpoint comparison");
		const fileCount = diff.changedFiles.length;
		const resetTarget = gitPlan.kind === "available" ? gitPlan.target : undefined;
		if (fileCount === 0 && !resetTarget) return;

		const files = `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`;
		const reset = resetTarget ? gitResetActionLabel(resetTarget) : undefined;
		const restoreFiles = `Restore ${files}`;
		const restoreAndReset = reset ? `Restore ${files} and ${reset}` : undefined;
		const resetOnly = resetTarget ? gitResetActionLabel(resetTarget, true) : undefined;
		const choices = fileCount > 0
			? [restoreFiles, ...(restoreAndReset ? [restoreAndReset] : []), "Keep current code", "Cancel branch"]
			: [resetOnly!, "Keep current code and Git history", "Cancel branch"];
		const choice = await ctx.ui.select("Restore code with conversation?", choices);
		if (choice === "Cancel branch" || choice === undefined) return { cancel: true };
		if (choice === "Keep current code" || choice === "Keep current code and Git history") return;

		const resetGit = choice === restoreAndReset || choice === resetOnly;
		if (resetGit && gitPlan.kind === "available") {
			const completedReset = await resetCheckpointGit(ctx, gitPlan);
			if (completedReset === undefined) return { cancel: true };
		}
		const result = await restoreCheckpoint(current.history, checkpoint, agentDir);
		ctx.ui.notify(restoreSummary(result, ctx.cwd), result.errors.length === 0 ? "info" : "warning");
		notifyErrors(ctx, result.errors, "Code restore");
	});

	async function rewindCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("/checkpoint requires an interactive terminal UI", "warning");
			return;
		}
		try {
			await ctx.waitForIdle();
			const current = getState(ctx);
			const branch = ctx.sessionManager.getBranch();
			const candidates = branch.flatMap((entry) => {
				const prompt = userPrompt(entry);
				const checkpoint = current.history.get(entry.id);
				return prompt && checkpoint ? [{ entry, prompt, checkpoint }] : [];
			});
			if (candidates.length === 0) {
				ctx.ui.notify("No code checkpoints are available yet", "warning");
				return;
			}

			const visibleCandidates = candidates.slice(-100);
			const candidateItems = await Promise.all(
				visibleCandidates.map(async (candidate): Promise<RewindSelectorItem> => {
					const diff = await getCheckpointDiff(current.history, candidate.checkpoint, agentDir);
					notifyErrors(ctx, diff.errors, "Checkpoint comparison");
					return {
						id: candidate.entry.id,
						prompt: candidate.prompt,
						filesChanged: diff.changedFiles.length,
						files: diff.changedFiles.map((file) => relative(candidate.checkpoint.cwd, file) || file),
						additions: diff.additions,
						deletions: diff.deletions,
					};
				}),
			);
			const selectedItem = await ctx.ui.custom<RewindSelectorItem | undefined>((ui, theme, _keybindings, done) => {
				const picker = new RewindSelector(
					[
						...candidateItems,
						{ prompt: "(current)", filesChanged: 0, additions: 0, deletions: 0, current: true },
					],
					theme,
					done,
				);
				return {
					render: (width: number) => picker.render(width),
					handleInput: (data: string) => {
						picker.handleInput(data);
						ui.requestRender();
					},
				};
			});
			if (!selectedItem?.id || selectedItem.current) return;
			const selected = visibleCandidates.find((candidate) => candidate.entry.id === selectedItem.id);
			if (!selected) return;

			const [diff, gitPlan] = await Promise.all([
				getCheckpointDiff(current.history, selected.checkpoint, agentDir),
				getGitResetPlan(selected.checkpoint.git, ctx.cwd),
			]);
			notifyErrors(ctx, diff.errors, "Checkpoint comparison");
			const resetTarget = gitPlan.kind === "available" ? gitPlan.target : undefined;
			const actions = buildRestoreActions(diff.changedFiles.length, resetTarget);
			const action = await ctx.ui.custom<RestoreAction | undefined>((ui, theme, _keybindings, done) => {
				const menu = new RestoreSelector({
					prompt: selected.prompt,
					timestamp: selected.entry.timestamp,
					files: diff.changedFiles.map((file) => relative(selected.checkpoint.cwd, file) || file),
					additions: diff.additions,
					deletions: diff.deletions,
					comparisonErrors: diff.errors.length,
				}, actions, theme, done);
				return {
					render: (width: number) => menu.render(width),
					handleInput: (data: string) => {
						menu.handleInput(data);
						ui.requestRender();
					},
				};
			});
			if (!action || action.cancel) return;

			let completedReset: GitResetTarget | undefined;
			if (action.resetGit && gitPlan.kind === "available") {
				completedReset = await resetCheckpointGit(ctx, gitPlan);
				if (completedReset === undefined) return;
			}

			let restoreResult: RestoreResult | undefined;
			if (action.restoreCode) {
				restoreResult = await restoreCheckpoint(current.history, selected.checkpoint, agentDir);
				ctx.ui.notify(restoreSummary(restoreResult, ctx.cwd), restoreResult.errors.length === 0 ? "info" : "warning");
				notifyErrors(ctx, restoreResult.errors, "Code restore");
			}
			if (!action.restoreConversation) return;

			suppressBranchPromptFor = selected.entry.id;
			const effects = [
				...(completedReset ? [gitResetMessage(completedReset)] : []),
				...(restoreResult ? [restoreSummary(restoreResult, ctx.cwd)] : []),
			];
			const suffix = effects.length > 0 ? ` and ${effects.join(" and ")}` : "";
			const result = await rewindConversation(
				ctx,
				selected.entry.id,
				selected.prompt,
				`Conversation rewound${suffix}`,
				restoreResult?.errors.length ? "warning" : "info",
			);
			suppressBranchPromptFor = undefined;
			if (result.cancelled) ctx.ui.notify("Conversation rewind was cancelled", "warning");
		} catch (error) {
			ctx.ui.notify(`Rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	// "/rewind" is omp's built-in /branch alias, so the extension command is reachable as /checkpoint.
	pi.registerCommand("checkpoint", {
		description: "Restore code and/or conversation to an earlier user prompt",
		handler: rewindCommand,
	});
	selector = rewindCommand;
}
