import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { commandName, isMutatingCommand, parseShell, stripWrappers } from "./shell";
import { absolutePath, bashCommand, type ToolCall, toolPaths } from "./tool-input";

/**
 * Second gate layer plus the native-tool nag.
 *
 * Lane 1 — protected writes: `write`/`edit`/`ast_edit` against credential-
 * shaped paths (SSH keys, cloud credentials, .env files, private keys) are
 * refused in every mode, Yolo included. Every target of a multi-file hashline
 * edit is checked, and a mutating bash command is refused when any argument or
 * redirection names such a path (`echo k >> ~/.ssh/authorized_keys`).
 * Templates like `.env.example` are not secrets and stay writable.
 * `OMP_POLICY_ALLOW_SENSITIVE=1` lifts the lane for the process.
 *
 * Lane 2 — native-tool nag: when the session repeatedly uses bash for
 * listing/reading/searching, attach a non-blocking reminder to the tool
 * result. The call is never refused; `additionalContext` reaches the model
 * with the result and does not steer the running turn.
 *
 * `/policy` prints the counters; `/policy reset|on|off` changes them.
 */

const PROTECTED_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh"].map(dir => join(homedir(), dir));
const PROTECTED_FILES = [".netrc", ".npmrc", ".pypirc"].map(file => join(homedir(), file));
const AUTH_PREFIX = join(homedir(), ".omp", "agent", "auth");
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults)$/;

const THRESHOLD = 3;
const MAX_NAGS = 3;

interface SessionState {
	enabled: boolean;
	hits: number;
	nags: number;
	blockedWrites: number;
	pending: Map<string, string>;
}

const sessions = new Map<string, SessionState>();

function stateOf(ctx: ExtensionContext): SessionState {
	const key = ctx.sessionManager.getSessionId();
	let state = sessions.get(key);
	if (!state) {
		state = { enabled: true, hits: 0, nags: 0, blockedWrites: 0, pending: new Map() };
		sessions.set(key, state);
	}
	return state;
}

export function isProtectedPath(raw: string, cwd: string): boolean {
	const abs = absolutePath(raw, cwd);
	if (abs === AUTH_PREFIX || abs.startsWith(`${AUTH_PREFIX}.`)) return true;
	if (PROTECTED_FILES.includes(abs)) return true;
	if (PROTECTED_DIRS.some(dir => abs === dir || abs.startsWith(`${dir}${sep}`))) return true;

	const name = basename(abs);
	if (name === ".env" || (name.startsWith(".env.") && !ENV_TEMPLATE.test(name))) return true;
	if (name.endsWith(".pem")) return true;
	if (name.startsWith("id_rsa") || name.startsWith("id_ed25519")) return true;
	return false;
}

/** Paths a call may write: tool targets, or every word and redirection of a mutating bash command. */
function writeTargets(call: ToolCall): string[] {
	const command = bashCommand(call);
	if (command === undefined) return toolPaths(call);
	if (!isMutatingCommand(command)) return [];
	const parsed = parseShell(command);
	const words = parsed.segments.flat().flatMap(word => {
		const eq = word.indexOf("=");
		return eq > 0 ? [word, word.slice(eq + 1)] : [word];
	});
	return [...parsed.writes, ...words];
}

const LISTING: Record<string, true> = { ls: true, tree: true, fd: true };
const READING: Record<string, true> = { cat: true, bat: true, head: true, tail: true, nl: true, less: true, more: true };
const SEARCHING: Record<string, true> = { grep: true, rg: true, ag: true, ack: true };

function bashIntent(command: string): "list" | "read" | "search" | undefined {
	const first = parseShell(command).segments[0];
	if (!first) return undefined;
	const name = commandName(first);
	const args = stripWrappers(first);
	if (Object.hasOwn(LISTING, name)) return "list";
	if (Object.hasOwn(READING, name)) return "read";
	if (Object.hasOwn(SEARCHING, name)) {
		if (name === "rg" && args.includes("--files")) return "list";
		// A search reading stdin is still a search; the nudge stays advisory.
		return args.includes("-") ? undefined : "search";
	}
	if (name === "sed" && args.some(arg => arg.startsWith("-n"))) return "read";
	if (name === "find" && !args.some(arg => arg === "-delete" || arg === "-exec" || arg === "-execdir")) return "list";
	return undefined;
}

function reminder(state: SessionState): string {
	return [
		`Policy reminder: bash has handled listing/reading/searching ${state.hits} times this session.`,
		"Prefer the native `read`, `grep`, and `glob` tools: they bound output, preserve line numbers, and keep the path typed.",
		"Bash is still allowed. This is a non-blocking reminder, not a refusal.",
	].join(" ");
}

export interface Policy {
	/** Refusal reason when a call writes a protected credential path. */
	refuseWrite(call: ToolCall, ctx: ExtensionContext): string | undefined;
	/** Record a bash listing/reading/searching call that passed every gate. */
	noteBash(call: ToolCall, ctx: ExtensionContext): void;
}

export function registerPolicy(pi: ExtensionAPI): Policy {
	const reset = (ctx: ExtensionContext) => {
		sessions.set(ctx.sessionManager.getSessionId(), {
			enabled: true,
			hits: 0,
			nags: 0,
			blockedWrites: 0,
			pending: new Map(),
		});
	};

	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_clear", (_event, ctx) => reset(ctx));
	pi.on("session_compact", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		sessions.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("tool_result", (event, ctx) => {
		const state = stateOf(ctx);
		const intent = state.pending.get(event.toolCallId);
		if (!intent) return;
		state.pending.delete(event.toolCallId);
		if (!state.enabled) return;

		state.hits++;
		if (state.hits < THRESHOLD || state.nags >= MAX_NAGS) return;
		state.nags++;
		pi.logger.info("policy: native-tool reminder", { hits: state.hits, nag: state.nags, intent });
		return { additionalContext: reminder(state) };
	});

	pi.registerCommand("policy", {
		description: "Show or reset the session policy counters",
		handler: async (args, ctx) => {
			const state = stateOf(ctx);
			const action = args.trim().toLowerCase();
			if (action === "reset") {
				state.hits = 0;
				state.nags = 0;
				state.blockedWrites = 0;
				ctx.ui.notify("Policy counters reset.", "info");
				return;
			}
			if (action === "off" || action === "on") {
				state.enabled = action === "on";
				ctx.ui.notify(`Policy engine ${state.enabled ? "enabled" : "disabled"} for this session.`, "info");
				return;
			}
			ctx.ui.notify(
				`Policy: ${state.enabled ? "on" : "off"} · bash intents ${state.hits} · reminders ${state.nags}/${MAX_NAGS} · blocked writes ${state.blockedWrites}`,
				"info",
			);
		},
	});

	return {
		refuseWrite(call, ctx) {
			const state = stateOf(ctx);
			if (!state.enabled || process.env.OMP_POLICY_ALLOW_SENSITIVE === "1") return undefined;
			const raw = writeTargets(call).find(path => isProtectedPath(path, ctx.cwd));
			if (!raw) return undefined;
			state.blockedWrites++;
			pi.logger.warn("policy: blocked protected write", { path: raw, tool: call.toolName });
			return `Blocked by policy: ${raw} is a protected credential path. Set OMP_POLICY_ALLOW_SENSITIVE=1 only if this is intentional.`;
		},
		noteBash(call, ctx) {
			const state = stateOf(ctx);
			const command = bashCommand(call);
			if (!state.enabled || command === undefined) return;
			const intent = bashIntent(command);
			if (!intent) return;
			state.pending.set(call.toolCallId, intent);
			pi.logger.debug("policy: bash intent recorded", { intent, toolCallId: call.toolCallId });
		},
	};
}
