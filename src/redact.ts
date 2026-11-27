import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * Redact credential-shaped strings from command output (bash, eval, MCP, web)
 * before it reaches the model or the persisted transcript. The replacement is
 * one-way, so it never touches tools whose output is file content the model
 * edits from: a `[REDACTED]` copied into an edit would be written to the file.
 * Those results are covered by omp's reversible `secrets.enabled` obfuscation
 * instead (built-in token shapes, plus the generic `key = value` pattern in
 * ~/.omp/agent/secrets.yml); its placeholders are restored before tools run.
 */

const FILE_CONTENT_TOOLS: Record<string, true> = { read: true, grep: true, ast_grep: true, edit: true, ast_edit: true };

const REDACTED = "[REDACTED]";

const PATTERNS: { re: RegExp; replacement: string }[] = [
	{ re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
	{
		re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		replacement: REDACTED,
	},
	{
		re: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{16,}["']?/gi,
		replacement: REDACTED,
	},
	{
		re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
		replacement: `Authorization: Bearer ${REDACTED}`,
	},
	{
		re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replacement: REDACTED,
	},
];

function redactSecrets(text: string): string {
	let out = text;
	for (const { re, replacement } of PATTERNS) out = out.replace(re, replacement);
	return out;
}

export function registerRedaction(pi: ExtensionAPI): void {
	pi.on("tool_result", event => {
		if (Object.hasOwn(FILE_CONTENT_TOOLS, event.toolName)) return;
		let changed = false;
		const content = event.content.map(block => {
			if (block.type !== "text") return block;
			const text = redactSecrets(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		});
		if (!changed) return;
		return { content };
	});
}
