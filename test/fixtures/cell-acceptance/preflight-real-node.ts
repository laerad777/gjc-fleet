// Reads a local evidence file. Does not connect to a host or open a database.
export type HostRole = "a" | "b";

export type HostEvidence = {
	role: HostRole;
	machineId: string;
	dbPath: string;
};

export type PeerOpenEvidence = {
	from: HostRole;
	target: HostRole;
	opened: boolean;
};

export type RestartEvidence = {
	role: "a";
	machineId: string;
	dbPath: string;
};

export type PreflightEvidence = {
	hosts: HostEvidence[];
	productionDbPaths: string[];
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

function isHost(value: unknown): value is HostEvidence {
	if (!value || typeof value !== "object") return false;
	const item = value as HostEvidence;
	return isRole(item.role) && typeof item.machineId === "string" && typeof item.dbPath === "string";
}

function isPeer(value: unknown): value is PeerOpenEvidence {
	if (!value || typeof value !== "object") return false;
	const item = value as PeerOpenEvidence;
	return isRole(item.from) && isRole(item.target) && typeof item.opened === "boolean";
}

function host(evidence: PreflightEvidence, role: HostRole): HostEvidence | undefined {
	return evidence.hosts.find((item) => item.role === role);
}

function peerRecord(evidence: PreflightEvidence, from: HostRole, target: HostRole): PeerOpenEvidence | undefined {
	return evidence.peerOpen.find((item) => item.from === from && item.target === target);
}

export function checkPreflight(input: unknown): string | null {
	if (!input || typeof input !== "object") return fail("evidence is not an object");
	const evidence = input as PreflightEvidence;
	if (!Array.isArray(evidence.hosts) || evidence.hosts.length !== 2 || !evidence.hosts.every(isHost)) {
		return fail("hosts must be exactly A and B");
	}
	const a = host(evidence, "a");
	const b = host(evidence, "b");
	if (!a || !b) return fail("hosts must be exactly A and B");
	if (a.machineId.trim() === "" || b.machineId.trim() === "") return fail("machine id is empty");
	if (a.machineId === b.machineId) return fail("machine ids are the same");
	if (!Array.isArray(evidence.productionDbPaths) || evidence.productionDbPaths.length === 0
		|| evidence.productionDbPaths.some((path) => typeof path !== "string")) {
		return fail("production DB list is empty");
	}
	const production = new Set(evidence.productionDbPaths.map(normalizePath));
	for (const cell of [a, b]) {
		if (cell.dbPath.trim() === "") return fail("test DB path is empty");
		if (production.has(normalizePath(cell.dbPath))) return fail("test DB path is a production DB");
	}
	if (normalizePath(a.dbPath) === normalizePath(b.dbPath)) return fail("A and B share a test DB path");
	if (!Array.isArray(evidence.peerOpen) || !evidence.peerOpen.every(isPeer)) {
		return fail("peer open evidence is missing");
	}
	for (const [from, target] of [["b", "a"], ["a", "b"]] as const) {
		const record = peerRecord(evidence, from, target);
		if (!record) return fail("peer open evidence is missing");
		if (record.opened) return fail("peer opened the other host DB");
	}
	const restart = evidence.restart;
	if (!restart || typeof restart !== "object") return fail("A restart record is missing");
	if (restart.role !== "a" || typeof restart.machineId !== "string" || typeof restart.dbPath !== "string") {
		return fail("restart record is not for A");
	}
	if (restart.machineId !== a.machineId) return fail("A restart host is not the original host");
	if (normalizePath(restart.dbPath) !== normalizePath(a.dbPath)) {
		return fail("A restart DB is not the original DB");
	}
	return null;
}

async function readEvidence(path: string): Promise<PreflightEvidence> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch {
		throw new Error("evidence file is unreadable");
	}
	try {
		return JSON.parse(text) as PreflightEvidence;
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
