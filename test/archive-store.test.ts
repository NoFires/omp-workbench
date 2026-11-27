import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARCHIVE_HISTORY_FILE,
	type ArchivedSessionMeta,
	backupSessionToArchive,
	loadArchiveHistory,
	MAX_ARCHIVE_HISTORY,
	restoreSessionFromArchive,
	saveArchiveHistory,
} from "../src/archive-store.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "omp-archive-test-"));
	tempDirs.push(dir);
	return dir;
}

function makeMeta(sessionsDir: string, id: string, archivedAt: number): ArchivedSessionMeta {
	return {
		id,
		path: join(sessionsDir, `${id}.jsonl`),
		cwd: "/tmp/project",
		title: `Session ${id}`,
		firstMessage: `Hello from ${id}`,
		status: "complete",
		modifiedMs: archivedAt - 10_000,
		archivedAt,
	};
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("archive-store", () => {
	it("backs up session jsonl and sidecar directory and records history", async () => {
		const root = await makeTempDir();
		const sessionsDir = join(root, "sessions");
		const archivedDir = join(root, "archived");
		await mkdir(join(sessionsDir, "s1"), { recursive: true });
		await writeFile(join(sessionsDir, "s1.jsonl"), '{"type":"session"}\n', "utf8");
		await writeFile(join(sessionsDir, "s1", "artifact.txt"), "data", "utf8");

		const meta = makeMeta(sessionsDir, "s1", 1000);
		await backupSessionToArchive(archivedDir, meta);

		assert.equal(await readFile(join(archivedDir, "s1.jsonl"), "utf8"), '{"type":"session"}\n');
		assert.equal(await readFile(join(archivedDir, "s1", "artifact.txt"), "utf8"), "data");
		const history = await loadArchiveHistory(archivedDir);
		assert.deepEqual(history, [meta]);
	});

	it("filters out entries whose backup files are missing and preserves LIFO stack order", async () => {
		const root = await makeTempDir();
		const sessionsDir = join(root, "sessions");
		const archivedDir = join(root, "archived");
		await mkdir(archivedDir, { recursive: true });

		const m1 = makeMeta(sessionsDir, "s1", 100);
		const m2 = makeMeta(sessionsDir, "s2", 200);
		const m3 = makeMeta(sessionsDir, "s3", 300);
		await writeFile(join(archivedDir, "s1.jsonl"), "1", "utf8");
		await writeFile(join(archivedDir, "s3.jsonl"), "3", "utf8");
		await saveArchiveHistory(archivedDir, [m1, m2, m3]);

		const history = await loadArchiveHistory(archivedDir);
		assert.deepEqual(
			history.map(item => item.id),
			["s1", "s3"],
		);
	});

	it("restores jsonl and sidecar directory, cleans backups, and updates history", async () => {
		const root = await makeTempDir();
		const sessionsDir = join(root, "sessions");
		const archivedDir = join(root, "archived");
		await mkdir(join(sessionsDir, "s1"), { recursive: true });
		const meta = makeMeta(sessionsDir, "s1", 500);
		await writeFile(meta.path, '{"restored":true}\n', "utf8");
		await writeFile(join(sessionsDir, "s1", "note.md"), "hello", "utf8");

		await backupSessionToArchive(archivedDir, meta);
		await rm(meta.path, { force: true });
		await rm(join(sessionsDir, "s1"), { recursive: true, force: true });

		const result = await restoreSessionFromArchive(archivedDir, meta);
		assert.deepEqual(result, { ok: true });
		assert.equal(await readFile(meta.path, "utf8"), '{"restored":true}\n');
		assert.equal(await readFile(join(sessionsDir, "s1", "note.md"), "utf8"), "hello");
		await assert.rejects(stat(join(archivedDir, "s1.jsonl")));
		await assert.rejects(stat(join(archivedDir, "s1")));
		assert.deepEqual(await loadArchiveHistory(archivedDir), []);
	});

	it("returns error and cleans history when backup file is gone during restore", async () => {
		const root = await makeTempDir();
		const sessionsDir = join(root, "sessions");
		const archivedDir = join(root, "archived");
		const meta = makeMeta(sessionsDir, "missing", 500);
		await saveArchiveHistory(archivedDir, [meta]);

		const result = await restoreSessionFromArchive(archivedDir, meta);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /gone/);
		const raw = JSON.parse(await readFile(join(archivedDir, ARCHIVE_HISTORY_FILE), "utf8"));
		assert.deepEqual(raw, []);
	});

	it("deduplicates repeated archives and enforces MAX_ARCHIVE_HISTORY", async () => {
		const root = await makeTempDir();
		const sessionsDir = join(root, "sessions");
		const archivedDir = join(root, "archived");
		await mkdir(sessionsDir, { recursive: true });

		for (let i = 0; i < MAX_ARCHIVE_HISTORY + 5; i++) {
			const id = `s-${i}`;
			const meta = makeMeta(sessionsDir, id, i + 1);
			await writeFile(meta.path, `${i}`, "utf8");
			await backupSessionToArchive(archivedDir, meta);
		}

		// Re-archive an existing one: moves to top without creating duplicate
		const re = makeMeta(sessionsDir, `s-${MAX_ARCHIVE_HISTORY}`, 9999);
		await backupSessionToArchive(archivedDir, re);

		const history = await loadArchiveHistory(archivedDir);
		assert.equal(history.length, MAX_ARCHIVE_HISTORY);
		assert.equal(history.at(-1)?.id, `s-${MAX_ARCHIVE_HISTORY}`);
		assert.equal(history.filter(item => item.id === `s-${MAX_ARCHIVE_HISTORY}`).length, 1);
	});
});
