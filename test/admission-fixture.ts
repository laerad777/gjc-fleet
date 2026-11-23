import { tmpdir } from "node:os";
import { parse } from "node:path";
import { DEFAULT_ADMISSION_POLICY, type ResourceSample } from "../src/admission";

/**
 * A fresh sample per node, taken 10s ago (inside the freshness window and before any reservation the
 * test just made), whose memory headroom admits exactly `tasks` tasks the sample does not contain,
 * with CPU and the root disk well clear of their limits.
 */
export function headroom(nodeIds: string[], tasks: number): { samples: Map<string, ResourceSample> } {
	const policy = DEFAULT_ADMISSION_POLICY;
	const free = policy.minFreeMemBytes + (tasks - 1) * policy.taskMemReserveBytes;
	const memTotal = 64 * 1024 ** 3;
	const disk = { path: "/", total: 1024 ** 4, used: 0 };
	// Remote POSIX fixtures use "/". On Windows, local fixture workspaces live under the cwd or temp
	// volume, which admission only matches against a drive-letter disk (as the Windows probe reports).
	const disks =
		process.platform === "win32"
			? [disk, ...[...new Set([parse(process.cwd()).root, parse(tmpdir()).root])].map((path) => ({ ...disk, path }))]
			: [disk];
	return {
		samples: new Map(
			nodeIds.map((id) => [id, { ok: true, at: Date.now() - 10_000, cpuPct: 10, memTotal, memUsed: memTotal - free, disks }]),
		),
	};
}
