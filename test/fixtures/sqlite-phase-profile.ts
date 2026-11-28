import { Database } from "bun:sqlite";

type Phase = <T>(name: string, action: () => T) => T;
export const unprofiled: Phase = (_name, action) => action();

const localOpt = process.env.FLEET_PROFILE_NODE_HEALTH;
const enabled = localOpt === "1" || (
	localOpt === undefined && process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
);

/** Draft-only diagnostic. The two callers are synchronous; the wrapper is never installed outside
 * their bodies. It observes Bun's normal transactions, without issuing SQL or changing options.
 * Durations are inclusive of native work/scheduling; finish_ms cannot isolate an fsync syscall.
 */
export function sqlitePhaseProfile(caseId: string, action: (phase: Phase) => void) {
	if (!enabled) return action(unprofiled);
	const prior = Database.prototype.transaction;
	const phases = new Map<string, { calls: number; ms: number }>();
	let scope: string | undefined;
	const add = (name: string, ms: number) => {
		const row = phases.get(name) ?? { calls: 0, ms: 0 };
		row.calls++;
		row.ms += ms;
		phases.set(name, row);
	};
	const phase: Phase = (name, step) => {
		const saved = scope;
		scope = name;
		const started = performance.now();
		try { return step(); }
		finally {
			add(name, performance.now() - started);
			scope = saved;
		}
	};
	Database.prototype.transaction = function <A extends any[], T>(this: Database, body: (...args: A) => T) {
		const name = scope;
		if (name === undefined) return prior.call(this, body);
		let entered: number | undefined, left: number | undefined;
		const native = prior.call(this, function (this: unknown, ...args: A) {
			entered = performance.now();
			try { return body.apply(this, args); }
			finally { left = performance.now(); }
		});
		const wrap = (run: (...args: A) => unknown) => (...args: A) => {
			entered = left = undefined;
			const start = performance.now();
			let success = false;
			try {
				const result = run.apply(native, args);
				success = true;
				return result;
			} finally {
				const end = performance.now();
				if (entered !== undefined && left !== undefined) {
					add(name + ".txn_enter", entered - start);
					add(name + ".txn_body", left - entered);
					add(name + (success ? ".txn_finish" : ".txn_error"), end - left);
				} else {
					add(name + ".txn_error_before_body", end - start);
				}
			}
		};
		const wrapped = wrap(native);
		return Object.assign(wrapped, {
			default: wrapped,
			deferred: wrap(native.deferred),
			immediate: wrap(native.immediate),
			exclusive: wrap(native.exclusive),
			database: this,
		});
	} as typeof Database.prototype.transaction;
	const started = performance.now();
	try { action(phase); }
	finally {
		const total = performance.now() - started;
		Database.prototype.transaction = prior;
		const rounded = (ms: number) => Math.round(ms * 100) / 100;
		const report = {
			case: caseId,
			platform: process.platform,
			bun: Bun.version,
			body_ms: rounded(total),
			phases: Object.fromEntries([...phases].map(([name, { calls, ms }]) => [name, { calls, ms: rounded(ms) }])),
		};
		console.log("NODE_HEALTH_SQLITE_PROFILE " + JSON.stringify(report));
	}
}
