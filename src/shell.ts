/**
 * Minimal POSIX-shell reading shared by every gate layer. It is not a shell:
 * it only splits a command line into simple commands and output-redirection
 * targets. Anything it cannot reason about (command or process substitution,
 * subshells, brace groups, here-docs, unterminated quotes) sets `complex`, and
 * callers treat `complex` as "not provably harmless".
 */

export interface ParsedShell {
	/** Words of each simple command, quotes removed. `$(…)`, `(…)` and backtick bodies are commands of their own. */
	segments: string[][];
	/** Targets of `>`, `>>`, `&>`, `>|` and `>&file`. */
	writes: string[];
	complex: boolean;
}

export function parseShell(command: string): ParsedShell {
	const segments: string[][] = [];
	const writes: string[] = [];
	let complex = false;
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let redirect: "write" | "read" | "dup" | undefined;

	const endWord = (): void => {
		if (!inWord) return;
		if (redirect === "write" || (redirect === "dup" && !/^(?:\d+|-)$/.test(word))) writes.push(word);
		else if (redirect === undefined) words.push(word);
		redirect = undefined;
		word = "";
		inWord = false;
	};
	const endSegment = (): void => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			inWord = true;
			if (end < 0) {
				complex = true;
				word += command.slice(i + 1);
				break;
			}
			word += command.slice(i + 1, end);
			i = end;
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			for (; j < command.length && command[j] !== '"'; j++) {
				const c = command[j];
				if (c === "\\" && j + 1 < command.length) {
					word += command[++j];
					continue;
				}
				if (c === "`" || (c === "$" && command[j + 1] === "(")) complex = true;
				word += c;
			}
			if (j >= command.length) complex = true;
			inWord = true;
			i = j;
			continue;
		}
		if (ch === "\\") {
			if (next !== undefined) {
				i++;
				if (next !== "\n") {
					word += next;
					inWord = true;
				}
			}
			continue;
		}
		if (ch === "$" && next === "(") {
			complex = true;
			endSegment();
			i++;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "(" || ch === ")" || ch === "`") {
			if (ch === "(" || ch === ")" || ch === "`") complex = true;
			endSegment();
			continue;
		}
		if (ch === "&") {
			if (next === ">") {
				endWord();
				i++;
				if (command[i + 1] === ">") i++;
				redirect = "write";
				continue;
			}
			endSegment();
			if (next === "&") i++;
			continue;
		}
		if (ch === "|") {
			endSegment();
			if (next === "|" || next === "&") i++;
			continue;
		}
		if (ch === ">" || ch === "<") {
			// `2>`: the fd number belongs to the redirection, not to the command.
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			} else {
				endWord();
			}
			if (next === "(") {
				complex = true;
				endSegment();
				i++;
				continue;
			}
			if (ch === "<") {
				if (next === "<") {
					complex = true;
					i++;
					if (command[i + 1] === "<") i++;
				} else if (next === "&") {
					i++;
				}
				redirect = "read";
				continue;
			}
			if (next === ">" || next === "|") i++;
			if (command[i + 1] === "&") {
				i++;
				redirect = "dup";
				continue;
			}
			redirect = "write";
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
			continue;
		}
		if ((ch === "{" || ch === "}") && !inWord && (next === undefined || /\s|;/.test(next))) {
			complex = true;
			endSegment();
			continue;
		}
		word += ch;
		inWord = true;
	}
	endSegment();
	if (redirect !== undefined) complex = true;
	return { segments, writes, complex };
}

const WRAPPERS: Record<string, true> = {
	sudo: true,
	doas: true,
	env: true,
	command: true,
	builtin: true,
	nohup: true,
	time: true,
	exec: true,
	xargs: true,
	nice: true,
	timeout: true,
};

/** A simple command without leading `VAR=value`, `sudo`/`env`/`nohup`-style wrappers, `nice -n N` or `timeout N`. */
export function stripWrappers(words: readonly string[]): string[] {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			i++;
			continue;
		}
		if (Object.hasOwn(WRAPPERS, word)) {
			i++;
			while (i < words.length && words[i].startsWith("-")) i += words[i] === "-n" ? 2 : 1;
			if (word === "timeout" && i < words.length) i++;
			continue;
		}
		break;
	}
	return words.slice(i);
}

/** `/bin/rm` → `rm`. */
export function commandName(words: readonly string[]): string {
	const name = stripWrappers(words)[0] ?? "";
	return name.slice(name.lastIndexOf("/") + 1);
}

const SINKS: Record<string, true> = { "/dev/null": true, "/dev/stdout": true, "/dev/stderr": true };

export function realWrites(parsed: ParsedShell): string[] {
	return parsed.writes.filter(target => !Object.hasOwn(SINKS, target));
}

/**
 * Simple commands that never need a model call: read-only inspection and the
 * repository's own build/test entry points. Matched against one simple command
 * with its words joined by single spaces.
 */
const TRIVIAL: RegExp[] = [
	/^(?:ls|pwd|whoami|date|uname|sw_vers|which|echo|printf|cd|true|false)(?: |$)/,
	/^command -v /,
	/^git (?:status|diff|log|show|blame|rev-parse|describe|ls-files|shortlog|show-ref)(?: |$)(?![\s\S]*--output)/,
	/^git remote(?: -v| show(?: \S+)?| get-url \S+)?$/,
	/^git branch(?: (?:-a|--all|-v|-vv|--verbose|-l|--list|--show-current|-r|--remotes))*$/,
	/^(?:rg|grep|ag|ack) (?!(?:[\s\S]* )?--pre(?:[ =]|$))/,
	/^fd(?: |$)(?!(?:[\s\S]* )?(?:-x|-X|--exec|--exec-batch)(?:[ =]|$))/,
	/^(?:cat|bat|head|tail|wc|nl|less|more)(?: |$)/,
	/^find (?!(?:[\s\S]* )?-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(?: |$))/,
	/^sed -n (?!(?:[\s\S]* )?(?:-[A-Za-z]*i|--in-place))(?!(?:[\s\S]*[ ;/])?[wW] )/,
	/^(?:tsc|vitest|jest|pytest)(?: |$)/,
	/^bun (?:test|run (?:test|lint|typecheck|build|fmt|check))(?: |$)/,
	/^(?:npm|pnpm|yarn) (?:test|run (?:test|lint|typecheck|build|fmt|check))(?: |$)/,
	/^cargo (?:check|test|build|clippy|fmt)(?: |$)/,
	/^go (?:test|build|vet)(?: |$)/,
	/^make(?: |$)(?![\s\S]*\b(?:install|uninstall|deploy|publish|release|push|upload|distclean)\b)/,
	/^cmake(?: |$)/,
];

/**
 * True only when every simple command in the line is trivial and nothing is
 * redirected into a file: `ls; rm -rf src` and `echo x > ~/.zshrc` are not.
 */
export function isTrivialCommand(command: string): boolean {
	const parsed = parseShell(command);
	if (parsed.complex || parsed.segments.length === 0 || realWrites(parsed).length > 0) return false;
	return parsed.segments.every(words => {
		const line = words.join(" ");
		return TRIVIAL.some(pattern => pattern.test(line));
	});
}

const MUTATORS: Record<string, true> = {
	rm: true,
	rmdir: true,
	mv: true,
	cp: true,
	tee: true,
	truncate: true,
	touch: true,
	mkdir: true,
	ln: true,
	chmod: true,
	chown: true,
	dd: true,
	install: true,
	patch: true,
	rsync: true,
	unlink: true,
	shred: true,
};
const INTERPRETER = /^(?:python[\d.]*|node|bun|deno|ruby|php|perl|osascript|sh|bash|zsh|fish)$/;
const MUTATING_PATTERNS: RegExp[] = [
	/\bsed (?:-[a-zA-Z]*i|--in-place)\b/,
	/\bperl\b[^\n]* -i\b/,
	/\bgit (?:apply|am|add|commit|checkout|cherry-pick|clean|merge|mv|rebase|reset|restore|rm|stash|switch|push|pull|tag)\b/,
	/\b(?:npm|pnpm|yarn|bun) (?:install|i|add|remove|uninstall|ci|link)\b/,
	/\b(?:pip|pip3|uv|brew|cargo) (?:install|uninstall|add|remove)\b/,
	/\bdd\b[^\n]*\bof=/,
	/\bfind\b[^\n]* -(?:delete|exec|execdir|fprint|fprintf|fls)\b/,
	/\bawk\b[^\n]*-i ?inplace/,
];

/**
 * Deliberately broad: drives the read-only lock and the "user forbade
 * changes" veto, so an unusual mutation shape counts as mutating.
 */
export function isMutatingCommand(command: string): boolean {
	const parsed = parseShell(command);
	if (realWrites(parsed).length > 0) return true;
	for (const words of parsed.segments) {
		const name = commandName(words);
		if (Object.hasOwn(MUTATORS, name) || INTERPRETER.test(name)) return true;
	}
	const flat = command.replace(/\s+/g, " ");
	return MUTATING_PATTERNS.some(pattern => pattern.test(flat));
}
