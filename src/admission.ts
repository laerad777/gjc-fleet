/**
 * Resource-based admission.
 *
 * Fleet has no per-node or global slot limits. A node takes a new task only while a fresh
 * measurement shows headroom; running tasks are never stopped when headroom later disappears.
 * A node without a fresh, successful measurement is excluded (fail-closed).
 */

export interface ResourceSample {
	ok: boolean;
	error?: string;
	/** Epoch ms when the hub received the sample. */
	at: number;
	cpuPct?: number;
	memTotal?: number;
	memUsed?: number;
	/** Memory a host balloon took back; only `balloonTrust` of it is counted as obtainable. */
	memReclaimed?: number;
	disks?: Array<{ path: string; total: number; used: number }>;
}

export interface AdmissionPolicy {
	/** Samples older than this are treated as missing. */
	maxSampleAgeMs: number;
	/** CPU busy percent at or above which no new task is admitted. */
	maxCpuPct: number;
	/** Available memory that must remain after charging recently admitted tasks. */
	minFreeMemBytes: number;
	/** Free space that must remain on the partition holding the node's workspace root. */
	minFreeDiskBytes: number;
	/**
	 * Memory charged per held task that the sample cannot contain yet: reserved after the sample was
	 * taken, or not started (no session) at all. Configured, not measured.
	 */
	taskMemReserveBytes: number;
	/** Share of balloon-reclaimed memory assumed to come back on demand (the host may refuse). */
	balloonTrust: number;
}

const GiB = 1024 ** 3;

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
	maxSampleAgeMs: 15_000,
	maxCpuPct: 85,
	minFreeMemBytes: 2 * GiB,
	minFreeDiskBytes: 5 * GiB,
	taskMemReserveBytes: 1 * GiB,
	balloonTrust: 0.5,
};

/** The partition whose mount path is the longest prefix of the workspace root (drive letters compare case-insensitively). */
export function workspaceDisk(
	workspaceRoot: string,
	disks: NonNullable<ResourceSample["disks"]>,
): (typeof disks)[number] | undefined {
	const windows = /^[a-zA-Z]:/.test(workspaceRoot);
	const norm = (path: string) => (windows ? path.replace(/\//g, "\\").toLowerCase() : path);
	const root = norm(workspaceRoot);
	let best: (typeof disks)[number] | undefined;
	for (const disk of disks) {
		const mount = norm(disk.path);
		const under =
			mount === "/" ||
			root === mount ||
			root.startsWith(mount.endsWith("/") || mount.endsWith("\\") ? mount : mount + (windows ? "\\" : "/")) ||
			(windows && /^[a-z]:$/.test(mount) && root.startsWith(mount));
		if (under && (!best || mount.length > norm(best.path).length)) best = disk;
	}
	return best;
}

const nonNegFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Reject policy objects whose numerics would make comparisons fail-open (NaN inequalities are never true). */
export function admissionPolicyOk(policy: AdmissionPolicy): boolean {
	return (
		nonNegFinite(policy.maxSampleAgeMs) &&
		nonNegFinite(policy.maxCpuPct) &&
		nonNegFinite(policy.minFreeMemBytes) &&
		nonNegFinite(policy.minFreeDiskBytes) &&
		nonNegFinite(policy.taskMemReserveBytes) &&
		typeof policy.balloonTrust === "number" &&
		Number.isFinite(policy.balloonTrust) &&
		policy.balloonTrust >= 0 &&
		policy.balloonTrust <= 1
	);
}

/**
 * Reasons this node cannot take a new task right now; empty means admit.
 * `warmingTasks` is the number of held tasks on the node the sample cannot reflect yet (see unmeasuredTasks).
 */
export function resourceReasons(
	workspaceRoot: string,
	sample: ResourceSample | undefined,
	warmingTasks: number,
	now: number,
	policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY,
): string[] {
	if (!sample || !sample.ok) return ["resources_unknown"];
	// now / warmingTasks / policy must be finite before age or headroom math; otherwise NaN
	// comparisons skip stale/memory gates and admit fail-open.
	if (!Number.isFinite(now) || !Number.isInteger(warmingTasks) || warmingTasks < 0 || !admissionPolicyOk(policy))
		return ["resources_unknown"];
	if (!Number.isFinite(sample.at) || sample.at > now + 1_000) return ["resources_unknown"];
	if (now - sample.at > policy.maxSampleAgeMs) return ["resources_stale"];
	const reasons: string[] = [];
	if (typeof sample.cpuPct !== "number" || !Number.isFinite(sample.cpuPct)) reasons.push("resources_unknown");
	else if (sample.cpuPct >= policy.maxCpuPct) reasons.push("cpu_busy");
	if (!nonNegFinite(sample.memTotal) || !nonNegFinite(sample.memUsed) || sample.memUsed > sample.memTotal) reasons.push("resources_unknown");
	else if (sample.memReclaimed !== undefined && !nonNegFinite(sample.memReclaimed)) reasons.push("resources_unknown");
	else {
		const freeMem =
			sample.memTotal -
			sample.memUsed -
			(sample.memReclaimed ?? 0) * (1 - policy.balloonTrust) -
			warmingTasks * policy.taskMemReserveBytes;
		if (!Number.isFinite(freeMem)) reasons.push("resources_unknown");
		else if (freeMem < policy.minFreeMemBytes) reasons.push("memory_low");
	}
	const disk = workspaceDisk(workspaceRoot, sample.disks ?? []);
	if (!disk || !nonNegFinite(disk.total) || !nonNegFinite(disk.used) || disk.used > disk.total) reasons.push("workspace_disk_unknown");
	else if (disk.total - disk.used < policy.minFreeDiskBytes) reasons.push("disk_low");
	return [...new Set(reasons)];
}

export interface AdmissionContext {
	samples: ReadonlyMap<string, ResourceSample>;
	/** Held tasks per node: reservation time (epoch ms) and whether a session exists yet. */
	held: ReadonlyMap<string, ReadonlyArray<HeldCharge>>;
	now: number;
	policy?: AdmissionPolicy;
}

export interface HeldCharge {
	reservedAt: number;
	started: boolean;
}

/**
 * Held tasks the sample cannot contain yet: never started (no session to measure) or reserved after
 * the sample was taken. Started tasks reserved before the sample are already in its numbers.
 */
export function unmeasuredTasks(held: ReadonlyArray<HeldCharge> | undefined, sampleAt: number | undefined): number {
	return (held ?? []).filter((task) => !task.started || sampleAt === undefined || task.reservedAt > sampleAt).length;
}
