import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerAgentsView } from "./src/agents-view";
import { registerAutoMode } from "./src/auto-mode";
import { inspectBash } from "./src/guard";
import { registerInputRouter } from "./src/input-router";
import { registerPolicy } from "./src/policy";
import { registerRedaction } from "./src/redact";
import { registerThinking } from "./src/thinking";
import { bashCommand } from "./src/tool-input";
import { registerRewind } from "./src/rewind/rewind";

/**
 * Session workbench for omp, as one package:
 *
 *   agents view  ← / Alt+A on an empty composer, or /sessions-view
 *   auto mode    Shift+Tab cycles Yolo → Auto → Plan, also mid-run; /auto-mode [on|off|plan|readonly|reset]
 *   rewind       Esc Esc on an empty idle composer, or /checkpoint
 *   thinking     Shift+↑/↓ steps the level; replies are drawn with a ↳ thinking line
 *   safety       hard blocks, protected credential writes, command-output redaction; /policy
 *
 * Every model tool call crosses one gate, deterministic layers first:
 * destructive command (guard.ts) → protected path (policy.ts) → read-only or
 * pending-plan lock, intent veto, classifier (auto-mode.ts). Every layer reads
 * bash through the same parser (shell.ts). The order is fixed here instead of
 * depending on how separate extensions happen to load.
 */
export default function workbench(pi: ExtensionAPI): void {
	pi.setLabel("Workbench");
	const policy = registerPolicy(pi);
	const autoMode = registerAutoMode(pi);

	pi.on("tool_call", async (event, ctx) => {
		const command = bashCommand(event);
		const refusal = (command === undefined ? undefined : inspectBash(command)) ?? policy.refuseWrite(event, ctx);
		if (refusal) return { block: true, reason: refusal };
		const blocked = await autoMode.gate(event, ctx);
		if (blocked) return blocked;
		policy.noteBash(event, ctx);
	});

	registerRedaction(pi);
	registerRewind(pi);
	registerAgentsView(pi);
	registerThinking(pi);
	registerInputRouter(pi, autoMode.cycle);
}
