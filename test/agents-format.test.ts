import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanSummary, formatAge, sessionName, STATUS_STYLE, statusKind } from "../src/agents-format.ts";

describe("cleanSummary", () => {
	it("strips fenced code blocks, inline backticks, and emphasis markers", () => {
		const raw = "Fixed `render()` bug\n```ts\nconst x = 1;\n```\nwith **bold**, _italic_, ~~old~~, # h1, > quote";
		assert.equal(cleanSummary(raw), "Fixed render() bug with bold, italic, old, h1, quote");
	});

	it("unwraps markdown links and line-leading list markers", () => {
		const raw = "Summary:\n- Check [API docs](https://example.com/a) first\n* Verify cache\n1. Ship fix";
		assert.equal(cleanSummary(raw), "Summary: Check API docs first Verify cache Ship fix");
	});

	it("cleans markdown table separator rows and pipe delimiters", () => {
		const inlineTable = "清理完成。 | | 清理前 hqg /tmp | 清理后 | 系统盘可用 | ||---|---|---|---| 409G";
		assert.equal(cleanSummary(inlineTable), "清理完成。 · 清理前 hqg /tmp · 清理后 · 系统盘可用 · 409G");

		const alignedTable = "| Col A | Col B |\n| :--- | ---: |\n| 1 | 2 |";
		assert.equal(cleanSummary(alignedTable), "Col A · Col B · 1 · 2");
	});

	it("strips emoji variation selectors and zero-width joiners", () => {
		assert.equal(cleanSummary("✅\uFE0F Done\uFE0E test\u200Dline"), "✅ Done testline");
	});
});

describe("sessionName", () => {
	it("uses the first line of title when present", () => {
		assert.equal(sessionName("  # Fix build\nsecond line", "ignored", "1234567890"), "Fix build");
	});

	it("falls back to truncated firstMessage when title is missing", () => {
		const msg = "123456789012345678901234567890123456789012EXTRA";
		assert.equal(sessionName("   ", msg, "abcdef123456"), "123456789012345678901234567890123456789012");
	});

	it("falls back to Untitled with short id when both clean to empty", () => {
		assert.equal(sessionName("  ", "### ", "abcdef123456"), "Untitled · abcdef12");
		assert.equal(sessionName(undefined, "", "9988776655"), "Untitled · 99887766");
	});
});

describe("statusKind and STATUS_STYLE", () => {
	it("maps omp session statuses to display kinds", () => {
		assert.equal(statusKind("pending"), "working");
		assert.equal(statusKind("complete"), "done");
		assert.equal(statusKind("error"), "failed");
		assert.equal(statusKind("interrupted"), "stopped");
		assert.equal(statusKind("aborted"), "stopped");
		assert.equal(statusKind(undefined), "idle");
		assert.equal(statusKind("unknown"), "idle");
	});

	it("provides glyph, label, and color for each status kind", () => {
		for (const kind of ["working", "done", "failed", "stopped", "idle"] as const) {
			const style = STATUS_STYLE[kind];
			assert.ok(style.glyph.length > 0);
			assert.ok(style.label.length > 0);
			assert.ok(style.color.length > 0);
		}
	});
});

describe("formatAge", () => {
	const now = 1_700_000_000_000;

	it("formats seconds, minutes, hours, and days", () => {
		assert.equal(formatAge(new Date(now + 5_000), now), "0s");
		assert.equal(formatAge(new Date(now - 45_000), now), "45s");
		assert.equal(formatAge(new Date(now - 12 * 60_000), now), "12m");
		assert.equal(formatAge(new Date(now - 5 * 3_600_000), now), "5h");
		assert.equal(formatAge(new Date(now - 3 * 86_400_000), now), "3d");
	});
});
