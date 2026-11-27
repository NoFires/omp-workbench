import { homedir } from "node:os";
import { commandName, parseShell, stripWrappers } from "./shell";

/**
 * First gate layer: refuse catastrophic shell commands before bash runs, in
 * every mode. Deliberately narrow: normal project commands like
 * `rm -rf node_modules` must keep working. The project `bash.patterns` layer
 * handles per-repo rules.
 */

const HOME = homedir();

const RULES: { re: RegExp; reason: string }[] = [
	{
		// dd if=/dev/zero|urandom of=/dev/...
		re: /\bdd\s+[^;\n]*\bif=\/dev\/(?:zero|urandom)\b[^;\n]*\bof=\/(?:dev|mnt|run)\b/,
		reason: "Refused: dd to a block device",
	},
	{
		re: /\bmkfs(?:\.[a-z0-9]+)?\b/i,
		reason: "Refused: mkfs",
	},
	{
		re: /\bchmod\s+-R\s+0{3,4}\s+\/(?=\s|$)/,
		reason: "Refused: chmod -R 000 /",
	},
	{
		// curl/wget ... | bash|sh|zsh
		re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/,
		reason: "Refused: pipe-from-web to shell",
	},
	{
		re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
		reason: "Refused: fork bomb",
	},
];

/** `/`, a top-level directory such as `/etc` or `/Users`, or home — with `/`, `/.` or `/*` after it. */
function isRootTarget(raw: string): boolean {
	const path = raw.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME).replace(/(?:\/\*|\/\.|\/)+$/, "");
	return path === "" || path === HOME || /^\/[^/]+$/.test(path);
}

/** Recursive `rm` of a root target, also behind sudo/env/xargs, after `--`, or inside `$(…)`. */
function rootRm(words: readonly string[]): boolean {
	if (commandName(words) !== "rm") return false;
	let recursive = false;
	let options = true;
	const targets: string[] = [];
	for (const arg of stripWrappers(words).slice(1)) {
		if (options && arg === "--") options = false;
		else if (options && arg.startsWith("--")) recursive ||= arg === "--recursive";
		else if (options && arg.startsWith("-") && arg.length > 1) recursive ||= /[rR]/.test(arg);
		else targets.push(arg);
	}
	return recursive && targets.some(isRootTarget);
}

/** Refusal reason for a catastrophic command, else undefined. */
export function inspectBash(command: string): string | undefined {
	if (parseShell(command).segments.some(rootRm)) {
		return "Refused: recursive rm of /, a top-level directory, or the home directory";
	}
	return RULES.find(({ re }) => re.test(command))?.reason;
}
