const UNSUPPORTED = new Set(["EPERM", "EAFNOSUPPORT", "EPROTONOSUPPORT", "EOPNOTSUPP", "ENOSYS"]);

/** Empty, false and zero mean local mode; unexpected non-empty values keep CI strict. */
export function isStrictUnixSocketCi(ci?: string, githubActions?: string): boolean {
	return [ci, githubActions].some((flag) => {
		const value = flag?.trim().toLowerCase();
		return value !== undefined && value !== "" && value !== "false" && value !== "0";
	});
}

export async function unixSocketSkipReason(
	ci: boolean, probe?: () => Promise<void>, corroborate?: () => string | undefined,
): Promise<string | undefined> {
	if (ci) return;
	if (!probe || !corroborate) throw new Error("local socket capability probes are required");
	try {
		await probe();
	} catch (error) {
		const code = corroborate();
		if (!code || !UNSUPPORTED.has(code)) throw error;
		return `candidate-package: skipping three local Unix socket cases (${code}); FIFO and symlink cases still run`;
	}
}
