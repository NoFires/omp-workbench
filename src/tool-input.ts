import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** The parts of a `tool_call` event the gates read. */
export interface ToolCall {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

function field(input: unknown, key: string): unknown {
	return typeof input === "object" && input !== null && key in input
		? (input as Record<string, unknown>)[key]
		: undefined;
}

export function stringField(input: unknown, key: string): string | undefined {
	const value = field(input, key);
	return typeof value === "string" ? value : undefined;
}

export function bashCommand(call: ToolCall): string | undefined {
	return call.toolName === "bash" ? stringField(call.input, "command") : undefined;
}

function addPath(paths: Set<string>, value: unknown): void {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return;
	paths.add(trimmed);
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"));
	return quoted ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Every file a `write`/`edit`/`ast_edit` call targets. omp's default hashline
 * `edit` has no `path` field: targets live in `[PATH#TAG]` section headers
 * inside `input`, so a `path`-only reader misses every edit. Parser follows
 * better-pi-rewind's `toolInputPaths` (MIT) so both agree on coverage.
 * `ast_edit` names files, directories or globs in `paths`.
 */
export function toolPaths(call: ToolCall): string[] {
	const paths = new Set<string>();
	if (call.toolName === "ast_edit") {
		const targets = field(call.input, "paths");
		if (Array.isArray(targets)) for (const target of targets) addPath(paths, target);
		return [...paths];
	}
	if (call.toolName !== "edit" && call.toolName !== "write") return [];
	addPath(paths, field(call.input, "path"));
	addPath(paths, field(call.input, "file_path"));
	addPath(paths, field(call.input, "filePath"));
	if (call.toolName !== "edit") return [...paths];

	const edits = field(call.input, "edits");
	if (Array.isArray(edits)) {
		for (const edit of edits) addPath(paths, field(edit, "rename"));
	}
	const patch = field(call.input, "input");
	if (typeof patch !== "string") return [...paths];
	for (const match of patch.matchAll(/^\[(.+)#[0-9a-f]{4}\]\s*$/gim)) addPath(paths, match[1]);
	for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gim)) addPath(paths, match[1]);
	for (const match of patch.matchAll(/^\*\*\* Move to:\s*(.+?)\s*$/gim)) addPath(paths, match[1]);
	for (const match of patch.matchAll(/^MV\s+(.+?)\s*$/gim)) addPath(paths, unquote(match[1] ?? ""));
	return [...paths];
}

export function absolutePath(raw: string, cwd: string): string {
	const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function insideWorkspace(abs: string, cwd: string): boolean {
	const rel = relative(cwd, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
