/** Drive the real dashboard health callback without changing production timers or cadence.
 * The switch-on test requires both the first callback and the expected reschedule; a rename or
 * changed wiring fails the fixture, rather than silently making the switch-off checks pass.
 */
export function manualHealthTimer() {
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	const pending = new Map<ReturnType<typeof setTimeout>, { ms: number; run: () => unknown }>();
	globalThis.setTimeout = ((callback: (...args: any[]) => unknown, ms = 0, ...args: any[]) => {
		if (callback.name !== "observeHealth") return realSet(callback, ms, ...args);
		// Keep an ordinary timeout handle, but never let the captured callback execute on its own.
		const handle = realSet(() => {}, 2 ** 31 - 1);
		handle.unref();
		pending.set(handle, { ms, run: () => callback(...args) });
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
		if (handle !== undefined) pending.delete(handle);
		realClear(handle);
	}) as typeof clearTimeout;
	return {
		delays: () => Array.from(pending.values(), ({ ms }) => ms),
		async tick() {
			let ran = 0;
			for (const [handle, { run }] of Array.from(pending)) {
				if (!pending.delete(handle)) continue;
				realClear(handle);
				await run();
				ran++;
			}
			return { ran, pending: this.delays() };
		},
		restore() {
			for (const handle of pending.keys()) realClear(handle);
			pending.clear();
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
		},
	};
}
