import { spyOn } from "bun:test";

/**
 * startDashboardServer probes the GJC runtime of the machine it runs on (`gjc --version`, then the
 * coordinator check and `gjc sdk session list --scope all` against the caller's agent directory).
 * A test must never reach the host's real GJC: refuse every `gjc` spawn, pass everything else through.
 * The refusal is the "not installed" outcome, the same on every host. Returns the restore function.
 */
export function refuseHostGjc(): () => void {
	const spawn = Bun.spawn.bind(Bun);
	const guard = spyOn(Bun, "spawn").mockImplementation(((cmd: any, options: any) => {
		const argv = Array.isArray(cmd) ? cmd : cmd?.cmd;
		if (Array.isArray(argv) && argv[0] === "gjc") throw new Error("test_refuses_host_gjc");
		return spawn(cmd, options);
	}) as any);
	return () => guard.mockRestore();
}
