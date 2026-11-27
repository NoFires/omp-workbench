import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { agentsViewEnter } from "./agents-view";
import { DEFAULT_REWIND_CONFIG, loadRewindConfig } from "./rewind/config";

/**
 * Composer shortcuts:
 *
 *   Shift+Tab      cycle Yolo → Auto → Plan, also while the agent runs
 *   ← or Alt+A     agents view, on an empty composer
 *   Esc Esc        rewind (`/checkpoint`), on an empty composer while idle
 *
 * In omp 19.2+, InteractiveMode registers its own composer key handler BEFORE
 * extensions run `session_start`, and that built-in handler unconditionally
 * consumes `left` (empty composer double-tap Agent Hub), `alt+a`
 * (`app.agents.hub`), and `escape` (`app.interrupt`).
 *
 * To preempt those three keys ONLY when the composer actually holds focus
 * (never breaking pickers, overlays, or dialogs), an outer `onTerminalInput`
 * listener prepends an unused probe key (`f20`, `\x1b[34~`) before the
 * original key. omp dispatches the two events synchronously in order:
 *   1. If the composer has focus, our `composer.addKeyHandler` receives `f20`
 *      and performs the action (or arms the 1st Esc), setting a flag for the
 *      inner `onTerminalInput` listener to consume the trailing original key.
 *   2. If any overlay/picker/dialog has focus, `f20` is ignored there and the
 *      inner listener lets the original key pass straight through untouched.
 */

const PROBE_KEY = "f20";
const PROBE_RAW = "\x1b[34~";

type PendingProbe =
	| { kind: "submit"; command: string }
	| { kind: "arm-escape"; at: number };

/** Latest main-session context; the handlers outlive the binding that made them. */
let live: ExtensionContext | undefined;
/** The composer lives for the whole process, so its key handler is added once. */
let keyHandlerInstalled = false;
let terminalDisposers: Array<() => void> = [];
let escapeWindowMs: number = DEFAULT_REWIND_CONFIG.escapeWindowMs;
let lastEscapeAt = 0;
let pendingProbe: PendingProbe | undefined;
let consumeNextOriginal = false;

/**
 * Run `command` in place of the key being handled. omp 19.2 gives extensions no
 * way to submit the composer, and only a submitted command runs with a command
 * context (`newSession`, `switchSession`, `navigateTree`). The draft is
 * replaced first; the composer matches its bindings on `key.id` once the
 * handlers return, so the key becomes Enter and submits it. Should omp stop
 * honouring that, the command just stays in the composer until Enter.
 */
function submitAs(key: KeyEvent, ctx: ExtensionContext, command: string): void {
	ctx.ui.setEditorText(command);
	Object.assign(key, { id: "enter", raw: "\r" });
}

function handleKey(key: KeyEvent, cycleMode: (ctx: ExtensionContext) => Promise<void>): boolean {
	const ctx = live;
	if (!ctx || key.kind === "release") return false;
	if (key.id === PROBE_KEY) {
		const probe = pendingProbe;
		pendingProbe = undefined;
		if (!probe) return true;
		if (probe.kind === "arm-escape") {
			// Composer is genuinely focused, empty, and idle on 1st Esc.
			// Leave consumeNextOriginal=false so omp's single-Esc behavior still runs.
			lastEscapeAt = probe.at;
			return true;
		}
		lastEscapeAt = 0;
		consumeNextOriginal = true;
		submitAs(key, ctx, probe.command);
		return false;
	}
	if (key.id === "shift+tab") {
		lastEscapeAt = 0;
		void cycleMode(ctx).catch(error => ctx.ui.notify(String(error), "error"));
		return true;
	}
	return false;
}

function installTerminalListeners(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI || ctx.agent.kind !== "main") return;
	live = ctx;
	pendingProbe = undefined;
	consumeNextOriginal = false;

	// omp clears all extension terminal-input listeners inside `prepareSessionSwitch()`
	// BEFORE checking whether `switchSession` / `newSession` succeeds or is cancelled.
	// Re-register cleanly (LIFO order: inner first, outer second).
	for (const dispose of terminalDisposers.splice(0)) dispose();

	// Inner listener: lets PROBE_RAW pass to dispatch, then consumes the trailing
	// original key iff the composer handler handled the probe.
	terminalDisposers.push(
		ctx.ui.onTerminalInput(data => {
			if (data === PROBE_RAW) return undefined;
			if (consumeNextOriginal) {
				consumeNextOriginal = false;
				pendingProbe = undefined;
				return { consume: true };
			}
			pendingProbe = undefined;
			return undefined;
		}),
	);

	// Outer listener: runs first on every raw input event.
	terminalDisposers.push(
		ctx.ui.onTerminalInput(data => {
			const current = live;
			if (!current) return undefined;

			// Enter or → in agents-view on a session from another directory closes
			// the view, seeds `/resume <id>`, and submits it via Enter.
			const command = agentsViewEnter(data);
			if (command !== undefined) {
				current.ui.setEditorText(command);
				return data === "\r" ? undefined : { data: "\r" };
			}

			if (!keyHandlerInstalled) return undefined;
			const events = decodeInput(data);
			if (events.length !== 1 || events[0].type !== "key") {
				lastEscapeAt = 0;
				return undefined;
			}
			const key = events[0].key;
			if (key.kind === "release") return undefined;

			const empty = current.ui.getEditorText().trim() === "";
			if ((key.id === "left" || key.id === "alt+a") && empty) {
				lastEscapeAt = 0;
				pendingProbe = { kind: "submit", command: "/sessions-view" };
				consumeNextOriginal = false;
				return { data: PROBE_RAW + data };
			}
			if (key.id === "escape") {
				if (empty && current.isIdle()) {
					const now = Date.now();
					const isDouble = now - lastEscapeAt < escapeWindowMs;
					pendingProbe = isDouble
						? { kind: "submit", command: "/checkpoint" }
						: { kind: "arm-escape", at: now };
					consumeNextOriginal = false;
					return { data: PROBE_RAW + data };
				}
				lastEscapeAt = 0;
				return undefined;
			}
			lastEscapeAt = 0;
			return undefined;
		}),
	);
}

/** Re-install terminal listeners after `ctx.switchSession` / `ctx.newSession` (including when cancelled). */
export function ensureInputRouter(ctx?: ExtensionContext): void {
	const target = ctx ?? live;
	if (target) installTerminalListeners(target);
}

export function registerInputRouter(pi: ExtensionAPI, cycleMode: (ctx: ExtensionContext) => Promise<void>): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI || ctx.agent.kind !== "main") return;
		live = ctx;
		try {
			escapeWindowMs = (
				await loadRewindConfig({
					agentDir: getAgentDir(),
					cwd: ctx.cwd,
					configDirName: CONFIG_DIR_NAME,
					projectTrusted: true,
				})
			).escapeWindowMs;
		} catch {
			escapeWindowMs = DEFAULT_REWIND_CONFIG.escapeWindowMs;
		}

		if (!keyHandlerInstalled && ctx.ui.composer) {
			ctx.ui.composer.addKeyHandler(key => handleKey(key, cycleMode));
			keyHandlerInstalled = true;
		}
		installTerminalListeners(ctx);
	});
	pi.on("session_before_switch", (_event, ctx) => {
		installTerminalListeners(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		installTerminalListeners(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (live === ctx) {
			live = undefined;
			pendingProbe = undefined;
			consumeNextOriginal = false;
		}
	});
}
