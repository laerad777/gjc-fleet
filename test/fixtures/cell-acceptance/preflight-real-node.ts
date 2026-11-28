// Reads a local evidence file. Does not connect to a host or open a database.
export type HostRole = "a" | "b";

export type FileIdentity = { device: string; inode: string };

export type HostEvidence = {
	role: HostRole;
	machineId: string;
	canonicalPath: string;
	identity: FileIdentity;
};

export type ProductionDb = {
	machineId: string;
	canonicalPath: string;
	identity: FileIdentity;
};

export type PeerOpenEvidence = {
	from: HostRole;
	target: HostRole;
	canonicalPath: string;
	identity: FileIdentity;
	opened: boolean;
};

export type RestartEvidence = {
	role: "a";
	machineId: string;
	canonicalPath: string;
	identity: FileIdentity;
	runId: string;
	exited: boolean;
	restartedAfterExit: boolean;
};

export type PreflightEvidence = {
	runId: string;
	hosts: HostEvidence[];
	productionDbs: ProductionDb[];
	peerOpen: PeerOpenEvidence[];
	restart: RestartEvidence | null;
};

const fail = (reason: string) => reason;

function isRole(value: unknown): value is HostRole {
	return value === "a" || value === "b";
}

function normalizePath(path: string): string {
	let slash = path.replaceAll("\\", "/");
	while (slash.length > 1 && slash.endsWith("/")) slash = slash.slice(0, -1);
	return slash;
}

function isIdentity(value: unknown): value is FileIdentity {
	if (!value || typeof value !== "object") return false;
	const item = value as FileIdentity;
	return typeof item.device === "string" && item.device.trim() !== ""
		&& typeof item.inode === "string" && item.inode.trim() !== "";
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
	return left.device === right.device && left.inode === right.inode;
}

function isHost(value: unknown): value is HostEvidence {
	if (!value || typeof value !== "object") return false;
	const item = value as HostEvidence;
	return isRole(item.role) && typeof item.machineId === "string"
		&& typeof item.canonicalPath === "string" && isIdentity(item.identity);
}

function isProduction(value: unknown): value is ProductionDb {
	if (!value || typeof value !== "object") return false;
	const item = value as ProductionDb;
	return typeof item.machineId === "string" && typeof item.canonicalPath === "string" && isIdentity(item.identity);
}

function isPeer(value: unknown): value is PeerOpenEvidence {
	if (!value || typeof value !== "object") return false;
	const item = value as PeerOpenEvidence;
	return isRole(item.from) && isRole(item.target) && typeof item.canonicalPath === "string"
		&& typeof item.opened === "boolean" && isIdentity(item.identity);
}

function host(evidence: PreflightEvidence, role: HostRole): HostEvidence | undefined {
	return evidence.hosts.find((item) => item.role === role);
}

export function checkPreflight(input: unknown): string | null {
	if (!input || typeof input !== "object") return fail("evidence is not an object");
	const evidence = input as PreflightEvidence;
	if (typeof evidence.runId !== "string" || evidence.runId.trim() === "") return fail("run id is empty");
	if (!Array.isArray(evidence.hosts) || evidence.hosts.length !== 2 || !evidence.hosts.every(isHost)) {
		return fail("hosts must be exactly A and B");
	}
	const a = host(evidence, "a");
	const b = host(evidence, "b");
	if (!a || !b) return fail("hosts must be exactly A and B");
	if (a.machineId.trim() === "" || b.machineId.trim() === "") return fail("machine id is empty");
	if (a.machineId === b.machineId) return fail("machine ids are the same");
	if (!Array.isArray(evidence.productionDbs) || evidence.productionDbs.length === 0
		|| !evidence.productionDbs.every(isProduction)) {
		return fail("production DB list is empty");
	}
	for (const cell of [a, b]) {
		if (cell.canonicalPath.trim() === "") return fail("test DB path is empty");
		const path = normalizePath(cell.canonicalPath);
		const live = evidence.productionDbs.some((item) => item.machineId === cell.machineId
			&& (normalizePath(item.canonicalPath) === path || sameFile(item.identity, cell.identity)));
		if (live) return fail("test DB is a production DB");
	}
	if (a.machineId === b.machineId && (normalizePath(a.canonicalPath) === normalizePath(b.canonicalPath)
		|| sameFile(a.identity, b.identity))) {
		return fail("A and B share a test DB");
	}
	if (!Array.isArray(evidence.peerOpen) || !evidence.peerOpen.every(isPeer)) {
		return fail("peer open evidence is missing");
	}
	for (const [from, targetRole] of [["b", "a"], ["a", "b"]] as const) {
		const records = evidence.peerOpen.filter((item) => item.from === from && item.target === targetRole);
		if (records.length === 0) return fail("peer open evidence is missing");
		if (records.length !== 1) return fail("peer observations contradict");
		const record = records[0]!;
		const target = targetRole === "a" ? a : b;
		const sameTarget = normalizePath(record.canonicalPath) === normalizePath(target.canonicalPath)
			&& sameFile(record.identity, target.identity);
		if (!sameTarget) return fail("peer observation is not the target DB");
		if (record.opened) return fail("peer opened the other host DB");
	}
	const restart = evidence.restart;
	if (!restart || typeof restart !== "object") return fail("A restart record is missing");
	if (restart.role !== "a" || typeof restart.machineId !== "string" || typeof restart.canonicalPath !== "string"
		|| typeof restart.runId !== "string" || typeof restart.exited !== "boolean"
		|| typeof restart.restartedAfterExit !== "boolean" || !isIdentity(restart.identity)) {
		return fail("restart record is not for A");
	}
	if (restart.machineId !== a.machineId) return fail("A restart host is not the original host");
	if (normalizePath(restart.canonicalPath) !== normalizePath(a.canonicalPath) || !sameFile(restart.identity, a.identity)) {
		return fail("A restart file is not the original DB");
	}
	if (restart.runId !== evidence.runId) return fail("A restart is not the same run");
	if (!restart.exited || !restart.restartedAfterExit) return fail("A restart did not follow an exit");
	return null;
}

async function readEvidence(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch {
		throw new Error("evidence file is unreadable");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("evidence file is not JSON");
	}
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path) {
		console.error("Fleet real-node preflight FAILED: evidence file is required");
		process.exit(1);
	}
	try {
		const reason = checkPreflight(await readEvidence(path));
		if (reason) {
			console.error("Fleet real-node preflight FAILED: " + reason);
			process.exit(1);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "evidence file is unreadable";
		console.error("Fleet real-node preflight FAILED: " + message);
		process.exit(1);
	}
	console.log("Fleet real-node preflight PASS");
}
