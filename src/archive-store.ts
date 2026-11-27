import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ArchivedSessionMeta {
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly title: string | undefined;
	readonly firstMessage: string;
	readonly status: string | undefined;
	readonly modifiedMs: number;
	readonly archivedAt: number;
}

export const MAX_ARCHIVE_HISTORY = 20;
export const ARCHIVE_HISTORY_FILE = "history.json";

function isArchivedSessionMeta(value: unknown): value is ArchivedSessionMeta {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		typeof item.path === "string" &&
		typeof item.cwd === "string" &&
		(item.title === undefined || typeof item.title === "string") &&
		typeof item.firstMessage === "string" &&
		(item.status === undefined || typeof item.status === "string") &&
		typeof item.modifiedMs === "number" &&
		typeof item.archivedAt === "number"
	);
}

async function exists(target: string): Promise<boolean> {
	return stat(target).then(
		() => true,
		() => false,
	);
}

export async function loadArchiveHistory(archivedDir: string): Promise<ArchivedSessionMeta[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(join(archivedDir, ARCHIVE_HISTORY_FILE), "utf8"));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const candidates = parsed.filter(isArchivedSessionMeta);
	const checks = await Promise.all(candidates.map(entry => exists(join(archivedDir, `${entry.id}.jsonl`))));
	return candidates.filter((_, index) => checks[index]);
}

export async function saveArchiveHistory(archivedDir: string, stack: readonly ArchivedSessionMeta[]): Promise<void> {
	await mkdir(archivedDir, { recursive: true });
	const trimmed = stack.slice(-MAX_ARCHIVE_HISTORY);
	await writeFile(join(archivedDir, ARCHIVE_HISTORY_FILE), `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
}

export async function backupSessionToArchive(archivedDir: string, meta: ArchivedSessionMeta): Promise<void> {
	await mkdir(archivedDir, { recursive: true });
	await copyFile(meta.path, join(archivedDir, `${meta.id}.jsonl`));
	if (meta.path.endsWith(".jsonl")) {
		await cp(meta.path.slice(0, -".jsonl".length), join(archivedDir, meta.id), {
			recursive: true,
		}).catch(() => undefined);
	}
	const history = await loadArchiveHistory(archivedDir);
	const next = history.filter(entry => entry.id !== meta.id && entry.path !== meta.path);
	next.push(meta);
	await saveArchiveHistory(archivedDir, next);
}

export async function restoreSessionFromArchive(
	archivedDir: string,
	meta: ArchivedSessionMeta,
): Promise<{ ok: boolean; error?: string }> {
	const backupJsonl = join(archivedDir, `${meta.id}.jsonl`);
	if (!(await exists(backupJsonl))) {
		const history = await loadArchiveHistory(archivedDir);
		await saveArchiveHistory(
			archivedDir,
			history.filter(entry => entry.id !== meta.id),
		);
		return { ok: false, error: "Archived backup file is gone" };
	}
	await mkdir(dirname(meta.path), { recursive: true });
	await copyFile(backupJsonl, meta.path);
	const backupSidecar = join(archivedDir, meta.id);
	const hasSidecar = await stat(backupSidecar).then(
		info => info.isDirectory(),
		() => false,
	);
	if (hasSidecar && meta.path.endsWith(".jsonl")) {
		await cp(backupSidecar, meta.path.slice(0, -".jsonl".length), {
			recursive: true,
		}).catch(() => undefined);
	}
	await rm(backupJsonl, { force: true });
	await rm(backupSidecar, { recursive: true, force: true });
	const history = await loadArchiveHistory(archivedDir);
	await saveArchiveHistory(
		archivedDir,
		history.filter(entry => entry.id !== meta.id),
	);
	return { ok: true };
}
