import { open } from "node:fs/promises";

/**
 * Tail reads of session JSONL files for the agents view. Lines are scanned from
 * the end and parsed only when they can hold a user/assistant message, so a
 * huge tool result costs a substring check instead of a JSON.parse.
 */

export interface PreviewLine {
	role: "user" | "assistant";
	text: string;
}

/** Text of a user/assistant message entry, ↳ thinking preview removed. */
function messageLine(line: string): PreviewLine | undefined {
	if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") return undefined;
	if (!("message" in entry) || typeof entry.message !== "object" || entry.message === null) return undefined;
	const message = entry.message;
	if (!("role" in message) || (message.role !== "user" && message.role !== "assistant")) return undefined;
	if (!("content" in message)) return undefined;
	const content = message.content;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "text") continue;
			if (!("text" in block) || typeof block.text !== "string") continue;
			text += block.text;
		}
	}
	text = text
		.replace(/^↳ [^\n]*(?:\n+|$)/, "")
		.replace(/\s+/g, " ")
		.trim();
	return text ? { role: message.role, text } : undefined;
}

/**
 * Visit message lines newest first within the last `bytes` of the file until
 * `visit` returns true.
 */
async function scanTail(path: string, bytes: number, visit: (line: PreviewLine) => boolean): Promise<void> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const lines = buffer.toString("utf8").split("\n");
		if (start > 0) lines.shift();
		for (let i = lines.length - 1; i >= 0; i--) {
			const parsed = messageLine(lines[i] ?? "");
			if (parsed && visit(parsed)) return;
		}
	} finally {
		await handle.close();
	}
}

/**
 * The last `count` messages, oldest first. Tool output dominates long
 * transcripts, so 1 MiB is read when the last 128 KiB held fewer.
 */
export async function readPreview(path: string, count = 10): Promise<PreviewLine[]> {
	let messages: PreviewLine[] = [];
	for (const bytes of [128 * 1024, 1024 * 1024]) {
		messages = [];
		await scanTail(path, bytes, line => {
			messages.unshift(line);
			return messages.length >= count;
		});
		if (messages.length >= count) break;
	}
	return messages;
}

/**
 * Latest assistant reply of at least 20 characters (else the latest of at
 * least 8). Reads 64 KiB first and 512 KiB only when that held none.
 */
export async function readLatestAssistant(path: string): Promise<string | undefined> {
	let short: string | undefined;
	for (const bytes of [64 * 1024, 512 * 1024]) {
		let found: string | undefined;
		await scanTail(path, bytes, ({ role, text }) => {
			if (role !== "assistant") return false;
			if (text.length >= 20) {
				found = text;
				return true;
			}
			short ??= text.length >= 8 ? text : undefined;
			return false;
		});
		if (found) return found;
	}
	return short;
}
