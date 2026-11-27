import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

/**
 * Shift+Up / Shift+Down step the thinking level with a notification on each
 * press. omp's built-in `app.thinking.cycle` is unbound in keybindings.yml: it
 * changes the level silently and its `auto` slot cannot be selected through
 * `pi.setThinkingLevel` (verified: the call is ignored at runtime).
 *
 * Levels come from the active model: `["off", ...getSupportedEfforts(model)]`.
 * For a model supporting low/high/max that is off → low → high → max → off.
 *
 * Replies are drawn opening with `↳ <first sentence of the model's thinking>`.
 * Display only, through an assistant text renderer: the session, /export and
 * the model context keep the reply as written. (Writing the line into the reply
 * taught the model to emit `↳` lines itself.) Renderers need
 * `extensionRenderers.assistantText`; it is switched on for the process unless
 * the user configured it. `↳` lines already in history are stripped from what
 * the model sees.
 */

const ARROW_LINE = /^↳ [^\n]*(?:\n+|$)/;

function thinkingPreview(text: string): string | undefined {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length < 40) return undefined;
	const sentence = clean.match(/^.*?[。！？.!?](?:\s|$)/u)?.[0]?.trim() ?? clean;
	return sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence;
}

export function registerThinking(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		for (const chord of ["shift+up", "shift+down"]) {
			const conflict = pi.getShortcutConflict(chord);
			if (conflict) ctx.ui.notify(`thinking-keys: ${chord} is held by ${conflict.kind}`, "warning");
		}
	});

	const step = (ctx: ExtensionContext, delta: 1 | -1): void => {
		const model = ctx.models.current();
		if (!model?.reasoning) {
			ctx.ui.notify("thinking: model has no reasoning effort", "warning");
			return;
		}
		const levels: Parameters<typeof pi.setThinkingLevel>[0][] = ["off", ...getSupportedEfforts(model)];
		const current = pi.getThinkingLevel() ?? "off";
		const index = levels.indexOf(current);
		const next =
			delta > 0
				? levels[index < 0 ? 0 : (index + 1) % levels.length]
				: levels[index <= 0 ? levels.length - 1 : index - 1];
		pi.setThinkingLevel(next);
		ctx.ui.notify(`thinking: ${next}`, "info");
	};

	pi.registerShortcut("shift+up", {
		description: "Raise the thinking level",
		handler: ctx => step(ctx, 1),
	});
	pi.registerShortcut("shift+down", {
		description: "Lower the thinking level",
		handler: ctx => step(ctx, -1),
	});

	try {
		const renderers = lookup("extensionRenderers.assistantText");
		if (renderers && !renderers.isConfigured(pi.pi.settings)) renderers.override(pi.pi.settings, true);
	} catch {
		// Registry unavailable: replies draw without the preview.
	}

	pi.registerAssistantTextRenderer(({ message, contentIndex, text }) => {
		const blocks = message.content;
		// Only the reply's first text block, and only when this segment indexes the whole reply.
		if (blocks[contentIndex]?.type !== "text") return undefined;
		let thinking = "";
		for (let i = 0; i < contentIndex; i++) {
			const block = blocks[i];
			if (block.type === "text" && block.text.trim()) return undefined;
			if (block.type === "thinking") thinking += ` ${block.thinking}`;
		}
		const preview = thinkingPreview(thinking);
		return preview ? `↳ ${preview}\n\n${text}` : undefined;
	});

	pi.on("context", event => {
		let changed = false;
		const messages = event.messages.map(message => {
			if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
			const index = message.content.findIndex(block => block.type === "text" && block.text.trim() !== "");
			const block = message.content[index];
			if (block?.type !== "text" || !ARROW_LINE.test(block.text)) return message;
			const text = block.text.replace(ARROW_LINE, "");
			// Changed text must not carry the provider signature of the original.
			const { textSignature: _signature, ...rest } = block;
			const content = text
				? message.content.with(index, { ...rest, text })
				: message.content.filter((_, i) => i !== index);
			if (content.length === 0) return message;
			changed = true;
			return { ...message, content };
		});
		return changed ? { messages } : undefined;
	});
}
