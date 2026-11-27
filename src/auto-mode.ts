import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	type ClassifierModel,
	classify,
	fingerprint,
	forbidsWrites,
	mayForbidWrites,
	readIntent,
	resolveClassifierModel,
	type Verdict,
} from "./classifier";
import { isMutatingCommand, isTrivialCommand } from "./shell";
import { absolutePath, bashCommand, insideWorkspace, stringField, type ToolCall, toolPaths } from "./tool-input";

/**
 * Third gate layer: classifier-based auto approval. index.ts runs it only after
 * guard.ts and policy.ts let a call through, so a deterministic refusal never
 * costs a model call.
 *
 * Modes (Shift+Tab, any time — also while the agent runs):
 *   Yolo  nothing is classified.
 *   Auto  non-trivial bash/eval, and write/edit/ast_edit leaving the workspace,
 *         go to a small classifier model with the latest user instruction.
 *   Plan  omp's plan mode. Mode changes apply to the very next tool call;
 *         omp refuses to enter or leave plan mode mid-turn, so that part waits
 *         for the turn to end, and a pending Plan already blocks file changes.
 * `/auto-mode readonly` locks every file mutation in every mode.
 *
 * Before the first mutation under a new user instruction, the instruction is
 * checked for an explicit "don't change anything"; the model is asked only
 * when the instruction contains a prohibition word. Verdicts are cached per
 * (instruction, action), so an action refused earlier is judged again once the
 * user says to go ahead.
 *
 * Subagents running in this process follow the main session's mode live.
 *
 * Classifier model: the first of @guard, @judge, @smol, else the session model.
 * Veto and verdict share one time budget that ends before omp's tool_call
 * timeout. A failed call (no key, timeout, HTTP error, unparseable answer)
 * blocks with the reason, and for 30 s further model-needing calls fail fast.
 *
 *   OMP_AUTO_MODE_TIMEOUT_MS   cap on that budget (default: tool_call timeout − 3 s)
 *   OMP_AUTO_MODE_READONLY=1   start every session with the read-only lock on
 */

type Cycle = "yolo" | "auto" | "plan";
type Block = { block: true; reason: string };

interface SessionState {
	cycle: Cycle;
	readonly: boolean;
	/** omp refused the plan-mode transition as busy; retried when the run ends. */
	pendingPlan: "enter" | "exit" | undefined;
	/** instruction fingerprint → does it forbid file changes */
	forbids: Map<string, boolean>;
	/** instruction fingerprint + action → verdict */
	verdicts: Map<string, Verdict>;
	classified: number;
	allowed: number;
	blocked: number;
	errors: number;
	warned: boolean;
	cooldownUntil: number;
}

const NEXT: Record<Cycle, Cycle> = { yolo: "auto", auto: "plan", plan: "yolo" };
const MAX_VERDICTS = 256;
const MAX_FORBIDS = 64;
const COOLDOWN_MS = 30_000;
const PLAN_RETRIES = 20;

const sessions = new Map<string, SessionState>();
/** Shared by every in-process binding, so subagents can find the main session's mode. */
let mainSessionId: string | undefined;

function freshState(): SessionState {
	return {
		cycle: "auto",
		readonly: process.env.OMP_AUTO_MODE_READONLY === "1",
		pendingPlan: undefined,
		forbids: new Map(),
		verdicts: new Map(),
		classified: 0,
		allowed: 0,
		blocked: 0,
		errors: 0,
		warned: false,
		cooldownUntil: 0,
	};
}

function stateOf(ctx: ExtensionContext): SessionState {
	const key = ctx.sessionManager.getSessionId();
	let state = sessions.get(key);
	if (!state) {
		state = freshState();
		sessions.set(key, state);
	}
	return state;
}

/** Mode in force: a subagent follows the main session when it shares this process. */
function modeOf(ctx: ExtensionContext): SessionState {
	const own = stateOf(ctx);
	if (ctx.agent.kind !== "sub" || mainSessionId === undefined) return own;
	return sessions.get(mainSessionId) ?? own;
}

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
	if (map.size >= max) {
		const oldest = map.keys().next();
		if (!oldest.done) map.delete(oldest.value);
	}
	map.set(key, value);
}

function modeLabel(state: SessionState): string {
	if (state.readonly) return "Read-only";
	const base = state.cycle === "yolo" ? "Yolo" : state.cycle === "plan" ? "Plan" : "Auto";
	if (state.pendingPlan === "enter") return `${base} (after this turn)`;
	if (state.pendingPlan === "exit") return `${base} (plan ends after this turn)`;
	return base;
}

/** Inline status chip; an active plan is left to the built-in mode segment so it never doubles. */
function syncModeStatus(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI || ctx.agent.kind !== "main") return;
	const state = stateOf(ctx);
	const label = state.cycle === "plan" && !state.readonly && !state.pendingPlan ? undefined : modeLabel(state);
	ctx.ui.setStatus("auto-mode", label);
}

/** Make omp's plan mode match `state.cycle`; a busy refusal leaves it pending. */
async function applyPlan(ctx: ExtensionContext, state: SessionState): Promise<void> {
	const modes = ctx.sessionModes;
	const want = state.cycle === "plan";
	const plan = modes?.getState().plan;
	if (!modes || (want ? plan === "active" : plan === "inactive")) {
		state.pendingPlan = undefined;
		return;
	}
	const result = await modes.set({ mode: "plan", action: want ? "enter" : "exit" });
	if (result.ok) {
		state.pendingPlan = undefined;
		return;
	}
	if (result.code === "busy") {
		state.pendingPlan = want ? "enter" : "exit";
		return;
	}
	state.pendingPlan = undefined;
	if (want) state.cycle = "yolo";
	ctx.ui.notify(`plan mode: ${result.message}${want ? " · mode: Yolo" : ""}`, "warning");
}

async function setMode(ctx: ExtensionContext, cycle: Cycle, readonly: boolean): Promise<void> {
	const state = stateOf(ctx);
	state.cycle = cycle;
	state.readonly = readonly;
	await applyPlan(ctx, state);
	syncModeStatus(ctx);
}

async function cycleMode(ctx: ExtensionContext): Promise<void> {
	const state = stateOf(ctx);
	await setMode(ctx, state.readonly ? "yolo" : NEXT[state.cycle], false);
	ctx.ui.notify(`mode: ${modeLabel(state)}`, "info");
}

function isMutatingCall(call: ToolCall, command: string | undefined): boolean {
	if (command !== undefined) return isMutatingCommand(command);
	return call.toolName === "write" || call.toolName === "edit" || call.toolName === "ast_edit" || call.toolName === "eval";
}

/** What the classifier must judge, or undefined when the call needs no verdict. */
function describeAction(call: ToolCall, command: string | undefined, cwd: string): { key: string; text: string } | undefined {
	if (command !== undefined) {
		const flat = command.replace(/\s+/g, " ").trim();
		if (!flat || isTrivialCommand(command)) return undefined;
		return { key: `bash:${flat}`, text: `bash: ${flat.slice(0, 8000)}` };
	}
	if (call.toolName === "eval") {
		const raw = stringField(call.input, "code") ?? "";
		const language = stringField(call.input, "language") ?? "code";
		const code = (raw || JSON.stringify(call.input) || "").replace(/\s+/g, " ").trim().slice(0, 8000);
		return code ? { key: `eval:${language}:${code}`, text: `eval (${language}): ${code}` } : undefined;
	}
	const outside = toolPaths(call)
		.map(path => absolutePath(path, cwd))
		.filter(abs => !insideWorkspace(abs, cwd));
	if (outside.length === 0) return undefined;
	return { key: `${call.toolName}:${outside.join("\n")}`, text: `${call.toolName}: ${outside.join(", ")}` };
}

function lockReason(call: ToolCall, readonly: boolean): string {
	const what =
		call.toolName === "eval" ? "eval (it can write files)" : call.toolName === "bash" ? "this command (it mutates files)" : call.toolName;
	return readonly
		? `auto-mode readonly: ${what} is refused until the user runs /auto-mode readonly again. Only reads are allowed.`
		: `auto-mode: the user switched to Plan; ${what} is refused and plan mode starts when this turn ends. Describe the change instead of making it.`;
}

/** Host tool_call timeout minus a margin, capped by OMP_AUTO_MODE_TIMEOUT_MS. */
function gateBudget(pi: ExtensionAPI): number {
	let host = 30_000;
	try {
		// `pi.pi.settings` is the documented scope for registry handles.
		const value = Number(lookup("extensionHandlers.toolCallTimeoutMs")?.get(pi.pi.settings));
		if (Number.isFinite(value) && value > 0) host = value;
	} catch {
		// Registry unavailable: keep omp's default.
	}
	const cap = Number(process.env.OMP_AUTO_MODE_TIMEOUT_MS);
	return Math.max(1_000, Math.min(host - 3_000, cap > 0 ? cap : Number.POSITIVE_INFINITY));
}

export interface AutoMode {
	/** Block result for a tool call the current mode refuses, else undefined. */
	gate(call: ToolCall, ctx: ExtensionContext): Promise<Block | undefined>;
	/** Shift+Tab: Yolo → Auto → Plan → Yolo; from read-only back to Yolo. */
	cycle(ctx: ExtensionContext): Promise<void>;
}

export function registerAutoMode(pi: ExtensionAPI): AutoMode {
	const adoptMain = (ctx: ExtensionContext): void => {
		if (ctx.agent.kind === "main") mainSessionId = ctx.sessionManager.getSessionId();
	};

	pi.on("session_start", (_event, ctx) => {
		sessions.set(ctx.sessionManager.getSessionId(), freshState());
		adoptMain(ctx);
		syncModeStatus(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		adoptMain(ctx);
		syncModeStatus(ctx);
	});
	pi.on("session_clear", (_event, ctx) => {
		// The context is gone, not the user's mode choice.
		const state = stateOf(ctx);
		state.forbids.clear();
		state.verdicts.clear();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessions.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("mode_changed", (_event, ctx) => {
		const state = stateOf(ctx);
		if (state.pendingPlan === undefined) {
			const plan = ctx.sessionModes?.getState().plan;
			if (plan === "active") state.cycle = "plan";
			else if (state.cycle === "plan") state.cycle = "auto";
		}
		syncModeStatus(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		const state = stateOf(ctx);
		if (!state.pendingPlan) return;
		let attempts = 0;
		const retry = (): void => {
			void applyPlan(ctx, state).then(
				() => {
					syncModeStatus(ctx);
					if (state.pendingPlan && ++attempts < PLAN_RETRIES) ctx.setTimeout(retry, 500);
				},
				error => ctx.ui.notify(`plan mode: ${error instanceof Error ? error.message : String(error)}`, "error"),
			);
		};
		// agent_end fires before the session reports idle; give it a tick.
		ctx.setTimeout(retry, 0);
	});

	const gate: AutoMode["gate"] = async (call, ctx) => {
		const state = stateOf(ctx);
		const mode = modeOf(ctx);
		const command = bashCommand(call);
		const mutating = isMutatingCall(call, command);

		if (mutating && (mode.readonly || (mode.cycle === "plan" && mode.pendingPlan === "enter"))) {
			state.blocked++;
			return { block: true, reason: lockReason(call, mode.readonly) };
		}
		if (mode.cycle === "yolo") return undefined;

		const action = describeAction(call, command, ctx.cwd);
		if (!mutating && !action) return undefined;

		const deadline = Date.now() + gateBudget(pi);
		const intent = readIntent(ctx);
		// User-authored text only: the agent's own question wording must not trip the veto.
		const userText = intent.answerChoices
			? `${intent.instruction}\n\nLater answers from the user, newest last:\n${intent.answerChoices}`
			: intent.instruction;
		const intentKey = fingerprint(userText);

		const fail = (error: unknown, what: string): Block => {
			state.errors++;
			state.cooldownUntil = Date.now() + COOLDOWN_MS;
			const message = error instanceof Error ? error.message : String(error);
			pi.logger.warn("auto-mode classifier failed", { message, what });
			if (!state.warned && ctx.hasUI) {
				state.warned = true;
				ctx.ui.notify(`auto-mode classifier unavailable: ${message}`, "warning");
			}
			return {
				block: true,
				reason: `auto-mode: classifier unavailable (${message}); the action was not run. Ask the user and explain why you need it.`,
			};
		};
		/** Model for one more call, or the block explaining why there is none. */
		const classifierModel = (): ClassifierModel | Block => {
			if (Date.now() < state.cooldownUntil) {
				const seconds = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
				return {
					block: true,
					reason: `auto-mode: classifier failed recently (retry in ${seconds}s); the action was not run. Ask the user and explain why you need it.`,
				};
			}
			return (
				resolveClassifierModel(ctx) ?? {
					block: true,
					reason:
						"auto-mode: no classifier model resolved; the action was not run. Configure modelRoles.guard or switch to Yolo with Shift+Tab.",
				}
			);
		};

		if (mutating && userText) {
			let forbids = state.forbids.get(intentKey);
			if (forbids === undefined) {
				if (mayForbidWrites(userText)) {
					const model = classifierModel();
					if ("block" in model) return model;
					try {
						forbids = await forbidsWrites(ctx, model, userText, deadline);
					} catch (error) {
						return fail(error, "intent veto");
					}
				} else {
					forbids = false;
				}
				remember(state.forbids, intentKey, forbids, MAX_FORBIDS);
			}
			if (forbids) {
				state.blocked++;
				return {
					block: true,
					reason:
						"auto-mode: the user's instruction asks for no file modification. Explain what would change, or ask them to allow writes; do not retry with another mutating tool.",
				};
			}
		}
		if (!action) return undefined;

		const key = `${intentKey}\n${action.key}`;
		let verdict = state.verdicts.get(key);
		if (!verdict) {
			const model = classifierModel();
			if ("block" in model) return model;
			try {
				verdict = await classify(ctx, model, action.text, intent, deadline);
			} catch (error) {
				return fail(error, action.key);
			}
			remember(state.verdicts, key, verdict, MAX_VERDICTS);
			state.classified++;
		}
		if (verdict.safe) {
			state.allowed++;
			return undefined;
		}
		state.blocked++;
		return {
			block: true,
			reason: `auto-mode blocked (${verdict.category}): ${verdict.reason}. The action was not run. If you need it, ask the user directly and explain why; do not retry with another tool.`,
		};
	};

	pi.registerCommand("auto-mode", {
		description: "Show or change the mode: on|off|plan|readonly [on|off]|reset",
		handler: async (args, ctx) => {
			const state = stateOf(ctx);
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "auto") await setMode(ctx, "auto", false);
			else if (action === "off" || action === "yolo") await setMode(ctx, "yolo", false);
			else if (action === "plan") await setMode(ctx, "plan", false);
			else if (action === "readonly") state.readonly = !state.readonly;
			else if (action === "readonly on") state.readonly = true;
			else if (action === "readonly off") state.readonly = false;
			else if (action === "reset") {
				state.classified = 0;
				state.allowed = 0;
				state.blocked = 0;
				state.errors = 0;
				state.cooldownUntil = 0;
				state.forbids.clear();
				state.verdicts.clear();
			}
			syncModeStatus(ctx);
			const model = resolveClassifierModel(ctx);
			ctx.ui.notify(
				[
					`mode: ${modeLabel(state)}`,
					`cooldown: ${state.cooldownUntil > Date.now() ? "on" : "off"}`,
					`classifier: ${model ? `${model.provider}/${model.id}` : "unresolved"}`,
					`classified ${state.classified} · allowed ${state.allowed} · blocked ${state.blocked} · errors ${state.errors}`,
					`cache ${state.verdicts.size} · budget ${Math.round(gateBudget(pi) / 1000)}s`,
				].join(" · "),
				"info",
			);
		},
	});

	return { gate, cycle: cycleMode };
}
