// Deny-by-default failure diagnostics: no free text from an error, a node or a transport is
// ever stored, and nothing derived from it either (no length, no hash). Only Fleet-defined
// identifiers, the error class, an allowlisted code and the fixed text for that code survive.
// The thrown value is only classified by its prototype chain and, for Fleet's own error classes,
// by an own data property `code`; no getter, toString or Proxy trap is ever invoked.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetError } from "../src/core";
import {
	DIAGNOSTIC_CODE_PATTERN,
	DIAGNOSTIC_TEXT,
	conditionDiagnostic,
	diagnosticErrorClasses,
	diagnosticOperationKinds,
	diagnosticPhases,
	diagnosticSources,
	failureDiagnostic,
	normalizeDiagnostic,
	type DiagnosticErrorClass,
	type DiagnosticStep,
	type FailureDiagnostic,
} from "../src/diagnostic";
import { StdioRpc, TransportError } from "../src/rpc";
import { NodeReplyError } from "../src/node";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";

const nodeReply = (certainty: "before_send" | "unknown" = "unknown") =>
	new NodeReplyError({ ok: false, error: "internal", detail: "exception", certainty, correlationId: "0f0e0d0c-0b0a-4908-8706-050403020100" });
const nodeTransportCodes = ["node_transport_failed", "node_timeout", "node_output_limit"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNCLASSIFIED = DIAGNOSTIC_TEXT.get("unclassified")!;

// ---- sensitive corpus: every class the README must not store -------------------------------
const username = userInfo().username;
// A fallback "unknown" also appears in valid fixed output, so it cannot identify a leaked username.
const identityUser = username.toLowerCase() === "unknown" ? "fleet-fixture-local-user-qzv" : username;
const local = [hostname(), identityUser].filter((value) => value.length >= 3);
const corpus = {
	password: "password=hunter2-Pa55w0rd!",
	token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
	awsKey: "AKIAIOSFODNN7EXAMPLE",
	jwt: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib2IifQ.c2lnbmF0dXJl",
	pem: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----",
	url: "https://deploy:S3cr3tPw@git.internal.example.com/org/repo.git",
	winPath: "C:\\Users\\alice\\secret\\id_rsa",
	uncPath: "\\\\fileserver01\\share$\\bob\\repo",
	posixPath: "/home/bob/.ssh/id_ed25519",
	relPath: "home/dave/notes.txt",
	host: "build01",
	fqdn: "db7.corp.example.com",
	ip: "10.1.2.3 fe80::1:2:3",
	userAtHost: "erin@build02.corp.example.com",
	user: "Test User",
	env: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\nPATH=/usr/local/sbin:/opt/secretbin\nHOME=/home/carol",
	hex: "9f8e7d6c5b4a3f2e",
	letterHex: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	stack: "boom\n    at Object.<anonymous> (/srv/app/x.ts:1:2)\u202e\u0000\u001b[31m",
	// Every leak the independent review (02e79179) demonstrated against the pattern sanitizer.
	reviewBrace: "x {/home/bob/secret",
	reviewDashC: "git -C/home/bob/repo",
	reviewPipe: "x |/srv/key",
	reviewApikey: "apikey 9f8e7d6c5b4a3f2e",
	reviewSha: "sha deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	reviewHost: "connect build01 failed",
	reviewUser: "user Test User",
	reviewRelative: "file at home/bob/x",
	reviewE2e: "git -C/home/bob/repo failed with key 9f8e7d6c5b4a3f2e on build01",
	reviewRefusalAws: "AKIAIOSFODNN7EXAMPLE",
	reviewRefusalPassword: "password_hunter2_for_alice",
	reviewErrno: "EAKIAIOSFODNN7EX",
	localIdentity: local.join(" "),
} as const;
// Distinctive fragments that must never appear in a stored diagnostic (or, where base itself stores
// nothing from the input, anywhere in the database).
const sentinels = [
	"hunter2", "Pa55w0rd", "ghp_ABCDEF", "AKIAIOSFODNN7", "akiaiosfodnn7", "eyJhbGci", "BEGIN OPENSSH", "b3BlbnNzaC1rZXk",
	"S3cr3tPw", "deploy:", "git.internal", "alice", "id_rsa", "fileserver01", "share$", "/home/bob", "home/bob", "id_ed25519",
	"home/dave", "build01", "build02", "db7.corp", "example.com", "10.1.2.3", "fe80::", "erin@", "Test User", "wJalrXUtnFEMI",
	"AWS_SECRET", "aws_secret", "/opt/secretbin", "carol", "9f8e7d6c5b4a3f2e", "deadbeefdeadbeef", "/srv/", "anonymous",
	"\u202e", "\u001b", "{/home", "-C/home", "|/srv", "apikey", "password_hunter2", "eakiaiosfodnn7", "EAKIAIOSFODNN7",
	...local,
	...local.map((value) => value.toLowerCase()),
];
const secretValues: string[] = Object.values(corpus);
const localSentinels = new Set([...local, ...local.map((value) => value.toLowerCase())]);

const step: DiagnosticStep = { source: "Fleet.start.prepare", phase: "call", operationKind: "prepare", operationId: "0f6b5d8e-2c1a-4b7e-9d3f-123456789abc" };

const fixedDiagnostic = (errorClass: DiagnosticErrorClass, code = "unclassified"): FailureDiagnostic => ({ version: 1, use: "diagnostic_only_not_evidence", ...step, errorClass, code, message: DIAGNOSTIC_TEXT.get(code)! });

// ---- structural allowlist check -------------------------------------------------------------
const allowedKeys = new Set(["version", "use", "source", "phase", "operationKind", "operationId", "errorClass", "code", "message"]);
const allowedStrings = new Set<string>([
	"diagnostic_only_not_evidence",
	...diagnosticSources, ...diagnosticPhases, ...diagnosticOperationKinds, ...diagnosticErrorClasses,
	...DIAGNOSTIC_TEXT.keys(), ...DIAGNOSTIC_TEXT.values(),
]);
/** Every leaf is an allowlisted identifier or a Fleet operation UUID; there is no number and no hash. */
function assertOnlyAllowlisted(diagnostic: unknown) {
	expect(diagnostic).toBeObject();
	const d = diagnostic as Record<string, unknown>;
	for (const key of Object.keys(d)) expect(allowedKeys.has(key)).toBe(true);
	expect(d.version).toBe(1);
	expect(d.use).toBe("diagnostic_only_not_evidence");
	for (const key of ["source", "phase", "errorClass", "code", "message"] as const) {
		expect(typeof d[key]).toBe("string");
		expect(allowedStrings.has(d[key] as string)).toBe(true);
	}
	expect(DIAGNOSTIC_TEXT.has(d.code as string)).toBe(true);
	expect(d.message).toBe(DIAGNOSTIC_TEXT.get(d.code as string)!);
	expect(d.code as string).toMatch(DIAGNOSTIC_CODE_PATTERN);
	if ("operationKind" in d) expect(allowedStrings.has(d.operationKind as string)).toBe(true);
	if ("operationId" in d) expect(d.operationId as string).toMatch(uuid);
	// No derivative of the message: no hash-like hex run and no number other than the version.
	const text = JSON.stringify(d);
	expect(text).not.toMatch(/[0-9a-f]{16}/);
	for (const [key, value] of Object.entries(d)) if (key !== "version") expect(typeof value).toBe("string");
	assertNoSentinel(text);
}
function assertNoSentinel(text: string, database = false) {
	// Raw SQLite pages naturally contain single control bytes; whole-value checks still cover them.
	for (const sentinel of sentinels) if (!(database && (localSentinels.has(sentinel) || sentinel.length < 3))) expect(text).not.toContain(sentinel);
	for (const value of secretValues) if (!(database && value === corpus.localIdentity)) expect(text).not.toContain(value);
}
/** Database bytes: base itself stores temp paths (which contain the local user name) in node snapshots. */
function assertDatabaseClean(db: string) {
	assertNoSentinel(dbBytes(db), true);
}

// ---- every input carrying every secret ------------------------------------------------------
function namedClass(name: string): new (message: string) => Error {
	const holder = { [name]: class extends Error {} };
	return holder[name]!;
}
type Variant = { input: string; build: (secret: string) => unknown };
const variants: Variant[] = [
	{ input: "Error message", build: (s) => new Error(s) },
	{ input: "Error message with errno code", build: (s) => Object.assign(new Error("EACCES: permission denied, open '" + s + "'"), { code: "EACCES" }) },
	{ input: "message prefixed by a known Fleet error code", build: (s) => new Error("git_failed:" + s) },
	{ input: "FleetError message", build: (s) => new FleetError("WORKSPACE_BINDING", s) },
	{ input: "FleetError code", build: (s) => new FleetError(s, "fixed") },
	{ input: "TransportError message", build: (s) => new TransportError("transport_exited", "unknown", s) },
	{ input: "TransportError code", build: (s) => new TransportError(s, "unknown", "fixed") },
	{ input: "TransportError tool_refused reason", build: (s) => new TransportError("tool_refused:" + s.replace(/[^a-zA-Z0-9_:.-]/g, "_"), "unknown") },
	{ input: "TransportError certainty", build: (s) => new TransportError("transport_closed", s as any, "fixed") },
	{ input: "TransportError publicResponse", build: (s) => new TransportError("EXECUTION_QUERY_FAILED", "unknown", s, { error: { code: s, message: s } }) },
	{ input: "own error code", build: (s) => Object.assign(new Error("fixed"), { code: s }) },
	{ input: "own errno-shaped code", build: (s) => Object.assign(new Error("fixed"), { code: "E" + s.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 14) }) },
	{ input: "error class name", build: (s) => new (namedClass(s))("fixed") },
	{ input: "error name property", build: (s) => Object.assign(new Error("fixed"), { name: s }) },
	{ input: "Symbol.toStringTag", build: (s) => Object.assign(new Error("fixed"), { [Symbol.toStringTag]: s }) },
	{ input: "cause and stack", build: (s) => Object.assign(new Error("fixed", { cause: new Error(s) }), { stack: s }) },
	{ input: "NodeReplyError forged message", build: (s) => Object.defineProperty(nodeReply(), "message", { value: s }) },
	{ input: "NodeReplyError forged reply", build: (s) => new NodeReplyError({ ok: false, error: s as any, detail: s, certainty: "before_send", correlationId: s }) },
	{ input: "thrown string", build: (s) => s },
	{ input: "thrown plain object", build: (s) => ({ message: s, code: s, name: s, stderr: s }) },
];

describe("deny-by-default diagnostic stores no input bytes and nothing derived from them", () => {
	for (const variant of variants)
		test(`${variant.input}: only allowlisted identifiers survive for every secret class`, () => {
			for (const [label, secret] of Object.entries(corpus)) {
				const error = variant.build(secret);
				const diagnostic = failureDiagnostic(error, step);
				try {
					assertOnlyAllowlisted(diagnostic);
					// The store rebuilds the diagnostic again before persisting it.
					assertOnlyAllowlisted(normalizeDiagnostic(diagnostic));
				} catch (cause) {
					throw new Error(`${variant.input} / ${label}: ${JSON.stringify(diagnostic)}`, { cause });
				}
			}
		});

	test("review M-1: nothing that depends on the message is stored, so no message can be guessed from the database", () => {
		// The four messages the review recovered from messageSha256 + messageLength, and every review M-1 string.
		const recovered = [
			"git_failed:fetch:fatal: unable to access 'https://deploy:4821@git.internal.example.com/org/repo.git/': The requested URL returned error: 403",
			"excluded_input:/Users/example/.aws/credentials",
			"Summer2024!",
			"getaddrinfo ENOTFOUND build-mac-07.corp.example",
		];
		for (const raw of [...recovered, corpus.reviewBrace, corpus.reviewDashC, corpus.reviewPipe, corpus.reviewApikey, corpus.reviewSha, corpus.reviewHost, corpus.reviewUser, corpus.reviewRelative, corpus.reviewE2e]) {
			expect(failureDiagnostic(new Error(raw), step)).toEqual(fixedDiagnostic("Error"));
			expect(failureDiagnostic(raw, step)).toEqual(fixedDiagnostic("non_error"));
			expect(failureDiagnostic(Object.assign(new Error(raw), { code: "ENOTFOUND" }), step)).toEqual(fixedDiagnostic("Error"));
		}
		// Every PIN of the review's brute-force case yields byte-identical diagnostics: there is nothing to brute-force.
		const pins = new Set<string>();
		for (let pin = 0; pin < 10000; pin++)
			pins.add(JSON.stringify(failureDiagnostic(new Error(`git_failed:fetch:fatal: unable to access 'https://deploy:${pin}@git.internal.example.com/org/repo.git/'`), step)));
		expect(pins.size).toBe(1);
		// A FleetError message is not used either: only its own code.
		expect(failureDiagnostic(new FleetError("WORKSPACE_BINDING", "a"), step)).toEqual(failureDiagnostic(new FleetError("WORKSPACE_BINDING", "completely different " + corpus.posixPath), step));
	});

	test("only Fleet's own error classes contribute a code; plain and Node errors keep only their class", () => {
		expect(failureDiagnostic(Object.assign(new Error("x"), { code: "ENOENT" }), step)).toEqual(fixedDiagnostic("Error"));
		expect(failureDiagnostic(Object.assign(new TypeError("x"), { code: "ROOT_DENIED" }), step)).toEqual(fixedDiagnostic("TypeError"));
		expect(failureDiagnostic(new Error("node_operation_refused"), step)).toEqual(fixedDiagnostic("Error"));
		expect(failureDiagnostic(new Error("git_failed:" + corpus.posixPath), step)).toEqual(fixedDiagnostic("Error"));
		expect(failureDiagnostic(new SyntaxError(corpus.token), step)).toEqual(fixedDiagnostic("SyntaxError"));
		expect(failureDiagnostic(new RangeError(corpus.token), step)).toEqual(fixedDiagnostic("RangeError"));
		expect(failureDiagnostic({ code: "ROOT_DENIED" }, step)).toEqual(fixedDiagnostic("non_error"));
	});

	test("known codes keep their identifier and fixed text", () => {
		expect(failureDiagnostic(new FleetError("WORKSPACE_BINDING", corpus.posixPath), step)).toEqual(fixedDiagnostic("FleetError", "fleet:workspace_binding"));
		expect(failureDiagnostic(new TransportError("transport_timeout", "unknown", corpus.url), step)).toEqual(fixedDiagnostic("TransportError", "transport:transport_timeout"));
		expect(failureDiagnostic(new TransportError("tool_refused:" + corpus.awsKey, "unknown"), step)).toEqual(fixedDiagnostic("TransportError", "transport:tool_refused"));
		expect(failureDiagnostic(new TransportError("EXECUTION_QUERY_FAILED", "unknown", corpus.url), step)).toEqual(fixedDiagnostic("TransportError", "transport:execution_query_failed"));
		for (const code of nodeTransportCodes) expect(failureDiagnostic(new TransportError(code, "unknown"), step)).toEqual(fixedDiagnostic("TransportError", "transport:" + code));
		// A typed node reply keeps only its certainty prefix: no error/detail pair, no correlation id.
		expect(failureDiagnostic(nodeReply("before_send"), step)).toEqual(fixedDiagnostic("TransportError", "transport:node_refused"));
		expect(failureDiagnostic(nodeReply("unknown"), step)).toEqual(fixedDiagnostic("TransportError", "transport:node_failed"));
		// Codes that exist only on production main (review M-2) are classified, not unclassified.
		for (const code of ["RETURN_NODE_BLOCKED", "RETURN_LIST_INVALID", "RETURN_LEASE_LOST", "OVERRIDE_SESSION_RUNNING", "OVERRIDE_LISTING_REQUIRED", "LATE_RECEIPT_STATE", "LATE_RECEIPT_CHANGED", "RECEIPTLESS_UNVERIFIABLE"])
			expect(failureDiagnostic(new FleetError(code, corpus.posixPath), step).code).toBe("fleet:" + code.toLowerCase());
		expect(conditionDiagnostic(step, "operation_already_claimed")).toEqual({ version: 1, use: "diagnostic_only_not_evidence", ...step, errorClass: "none", code: "condition:operation_already_claimed", message: DIAGNOSTIC_TEXT.get("condition:operation_already_claimed")! });
	});

	test("forged stored diagnostics are rebuilt from allowlisted fields; message is recomputed from code", () => {
		for (const secret of secretValues) {
			const forged = {
				version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.prompt", phase: "call", operationKind: "prompt", operationId: secret,
				errorClass: secret, code: secret, certainty: secret, refusal: { code: secret, stage: secret, extra: secret }, message: secret,
				messageLength: secret.length, messageSha256: "a".repeat(64), extra: secret,
			};
			expect(normalizeDiagnostic(forged)).toBeUndefined();
			const plausible = normalizeDiagnostic({ ...forged, errorClass: "Error", code: "transport:transport_timeout" })!;
			expect(plausible).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.prompt", phase: "call", errorClass: "Error", code: "transport:transport_timeout", message: DIAGNOSTIC_TEXT.get("transport:transport_timeout")! });
			const unknownCode = normalizeDiagnostic({ ...forged, errorClass: "Error" })!;
			expect(unknownCode.code).toBe("unclassified");
			assertOnlyAllowlisted(unknownCode);
		}
	});
});

// ---- review I-1: hostile thrown values ----------------------------------------------------------
/** Records every Proxy trap; the trap itself would also leak a secret if its result were used. */
function trapped(target: object, log: string[]) {
	const handler: ProxyHandler<object> = {};
	for (const trap of ["get", "set", "has", "ownKeys", "getOwnPropertyDescriptor", "defineProperty", "deleteProperty", "getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions", "apply", "construct"] as const)
		(handler as any)[trap] = (...args: unknown[]) => {
			log.push(trap);
			return (Reflect as any)[trap](...args);
		};
	return new Proxy(target, handler);
}
/** Every accessor and conversion hook a reader could invoke, each recording its call. */
function rigged<T extends object>(value: T, log: string[], keys = ["code", "message", "name", "stack", "cause", "certainty", "publicResponse", "refusal", "constructor", "toString", "toJSON", "valueOf", "errors"]): T {
	for (const key of keys)
		Object.defineProperty(value, key, { configurable: true, get() { log.push(key); return corpus.token; } });
	for (const symbol of [Symbol.toPrimitive, Symbol.toStringTag, Symbol.hasInstance])
		Object.defineProperty(value, symbol, { configurable: true, get() { log.push(String(symbol)); return () => corpus.token; } });
	return value;
}

describe("review I-1: the diagnostic reads nothing but the prototype chain and an own data `code`", () => {
	test("getters on Fleet's own classes and on built-in errors are never invoked", () => {
		const log: string[] = [];
		const cases: [unknown, DiagnosticErrorClass, string?][] = [
			[rigged(new FleetError("ROOT_DENIED", corpus.password), log), "FleetError"],
			[rigged(new TransportError("transport_closed", "unknown", corpus.password, corpus.password), log), "TransportError"],
			[rigged(nodeReply("before_send"), log, ["message", "name", "stack", "cause", "toString", "toJSON", "reply", "certainty", "publicResponse"]), "TransportError", "transport:node_refused"],
			[rigged(new Error(corpus.password), log), "Error"],
			[rigged(new TypeError(corpus.password), log), "TypeError"],
			[rigged(Object.create(FleetError.prototype), log), "FleetError"],
			[rigged(Object.create(TransportError.prototype), log), "TransportError"],
			[rigged({}, log), "non_error"],
			[rigged(() => corpus.token, log, ["code", "message"]), "non_error"],
		];
		for (const [value, errorClass, code] of cases) expect(failureDiagnostic(value, step)).toEqual(fixedDiagnostic(errorClass, code));
		expect(log).toEqual([]);
	});

	test("an accessor `code` on a Fleet class is not read: the code is unclassified, the getter never runs", () => {
		const log: string[] = [];
		const fleet = new FleetError("ROOT_DENIED", "x");
		Object.defineProperty(fleet, "code", { get() { log.push("code"); return "ROOT_DENIED"; } });
		const transport = new TransportError("transport_closed", "unknown");
		Object.defineProperty(transport, "code", { get() { log.push("code"); return "transport_closed"; } });
		class Sub extends FleetError {}
		// A subclass-level accessor `code` (TypeScript refuses to declare an accessor over the base data property).
		Object.defineProperty(Sub.prototype, "code", { get() { log.push("code"); return "ROOT_DENIED"; }, set() {}, configurable: true });
		expect(failureDiagnostic(fleet, step)).toEqual(fixedDiagnostic("FleetError"));
		expect(failureDiagnostic(transport, step)).toEqual(fixedDiagnostic("TransportError"));
		expect(failureDiagnostic(Object.create(Sub.prototype), step)).toEqual(fixedDiagnostic("FleetError"));
		expect(log).toEqual([]);
		// The genuine own data property is read.
		expect(failureDiagnostic(new FleetError("ROOT_DENIED", "x"), step).code).toBe("fleet:root_denied");
		// A non-string own data property is ignored without conversion.
		const toStringLog: string[] = [];
		const weird = new FleetError("ROOT_DENIED", "x");
		Object.defineProperty(weird, "code", { value: { toString() { toStringLog.push("toString"); return "ROOT_DENIED"; } } });
		expect(failureDiagnostic(weird, step)).toEqual(fixedDiagnostic("FleetError"));
		expect(toStringLog).toEqual([]);
	});

	test("Proxies: no trap ever fires, whether the value, a prototype or a revoked proxy", () => {
		const log: string[] = [];
		const revocable = Proxy.revocable(new FleetError("ROOT_DENIED", corpus.password), {});
		revocable.revoke();
		const values = [
			trapped(new FleetError("ROOT_DENIED", corpus.password), log),
			trapped(new TransportError("transport_closed", "unknown"), log),
			trapped(nodeReply(), log),
			trapped(new Error(corpus.password), log),
			trapped({ code: "ROOT_DENIED" }, log),
			trapped(function hostile() {}, log),
			Object.create(trapped(FleetError.prototype, log)),
			Object.create(Object.create(trapped(Error.prototype, log))),
			revocable.proxy,
		];
		for (const value of values) expect(failureDiagnostic(value, step)).toEqual(fixedDiagnostic("unclassified"));
		expect(log).toEqual([]);
	});

	test("throwing and exotic values never throw out of the diagnostic", () => {
		let deep: object = new FleetError("ROOT_DENIED", "x");
		for (let i = 0; i < 200; i++) deep = Object.create(deep);
		const circular: any = new Error(corpus.posixPath);
		circular.self = circular;
		circular.cause = circular;
		const huge = new Error("A".repeat(2_000_000) + corpus.posixPath);
		const frozen = Object.freeze(new FleetError("ROOT_DENIED", "x"));
		const nullProto = Object.create(null);
		for (const [value, errorClass] of [
			[deep, "unclassified"], [circular, "Error"], [huge, "Error"], [nullProto, "non_error"],
			[null, "non_error"], [undefined, "non_error"], [Symbol(corpus.token), "non_error"], [10n, "non_error"], [42, "non_error"], [[corpus.token], "non_error"],
		] as [unknown, DiagnosticErrorClass][]) {
			expect(failureDiagnostic(value, step)).toEqual(fixedDiagnostic(errorClass));
			assertOnlyAllowlisted(normalizeDiagnostic(failureDiagnostic(value, step)));
		}
		expect(failureDiagnostic(frozen, step).code).toBe("fleet:root_denied");
	});
});

describe("code table", () => {
	test("every key is short, [a-z0-9_:.-] only, and every text is fixed short ASCII without input-like content", () => {
		expect(UNCLASSIFIED).toBeString();
		for (const [code, text] of DIAGNOSTIC_TEXT) {
			expect(code).toMatch(DIAGNOSTIC_CODE_PATTERN);
			expect(code).toMatch(/^(unclassified|(fleet|transport|condition):[a-z0-9_]{1,63})$/);
			expect(text).toMatch(/^[A-Za-z0-9 ,;.()'-]{1,80}$/);
		}
	});

	// Review 9fbbbd8d F-2: driven, not read from source. Codes Fleet's own errors carry on the paths that
	// convert a failure are checked by catch-site-behaviour.test.ts (no FleetError/TransportError diagnostic
	// there may be "unclassified"); the two families with composed codes are driven here.
	test("composed codes of Fleet's own errors keep only their allowlisted prefix (NodeReplyError, rpc tool refusal)", async () => {
		for (const [certainty, prefix] of [["before_send", "node_refused"], ["unknown", "node_failed"]] as const) {
			const error = nodeReply(certainty);
			expect(error.code).toStartWith(prefix + ":");
			expect(failureDiagnostic(error, step)).toEqual(fixedDiagnostic("TransportError", "transport:" + prefix));
		}
		const refusal = (reason: string | undefined) =>
			`let b='';for await(const p of Bun.stdin.stream()){b+=new TextDecoder().decode(p);let n;while((n=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(r.id===undefined)continue;` +
			`const value=r.method==='initialize'?{}:{isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:${JSON.stringify(reason === undefined ? {} : { code: reason })}})}]};` +
			`console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:value}));}}`;
		for (const reason of ["authorization_denied", corpus.token.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 100), undefined]) {
			const rpc = new StdioRpc(process.execPath, ["--eval", refusal(reason)], 5000);
			try {
				await rpc.request("initialize", {});
				const error = await rpc.call("effect", {}).then(() => undefined, (e: unknown) => e);
				expect(error).toBeInstanceOf(TransportError);
				expect((error as TransportError).code).toBe(reason === undefined ? "tool_refused" : "tool_refused:" + reason);
				expect(failureDiagnostic(error, step)).toEqual(fixedDiagnostic("TransportError", "transport:tool_refused"));
			} finally {
				rpc.close();
			}
		}
	}, 60_000);
});

// ---- end to end: real store, real Fleet.start, real child processes -------------------------
// These spawn real helper/transport/CLI processes (66 helper runs in one test); the default 5 s
// per-test limit is too short on slow hosts, and a timed-out test would keep running and race cleanup.
const E2E_TIMEOUT = 120_000;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
function fixture(workspaceScript?: string, sdkScript?: string) {
	const root = mkdtempSync(join(tmpdir(), "fleet-deny-"));
	roots.push(root);
	const spy = join(root, "spy.ts");
	writeFileSync(spy, "process.exit(90);");
	const transport = { command: process.execPath, args: [spy] };
	let workspaceTransport = transport;
	if (workspaceScript) {
		const script = join(root, "helper.ts");
		writeFileSync(script, workspaceScript);
		workspaceTransport = { command: process.execPath, args: [script] };
	}
	let mainTransport = transport;
	if (sdkScript) {
		const script = join(root, "transport.ts");
		writeFileSync(script, sdkScript);
		mainTransport = { command: process.execPath, args: [script] };
	}
	const node: NodeConfig = {
		id: "node", os: process.platform, arch: process.arch, roots: { repo: root }, workspaceRoot: join(root, "work"),
		maxConcurrency: 8, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: mainTransport, workspaceTransport,
	};
	const db = join(root, "fleet.sqlite");
	const store = new FleetStore(db, 8);
	store.putNode(node);
	return { root, db, store, workspacePath: join(root, "work", "ws") };
}
function input(key: string): TaskInput {
	return { schemaVersion: 1, key, caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "prompt", required: {} };
}
function identity(task: TaskRecord, path: string) {
	return { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: task.nodeId!, inputDigest: task.inputDigest, baseCommit: task.input.baseCommit, path };
}
function dbBytes(db: string): string {
	return [db, db + "-wal"].map((file) => { try { return readFileSync(file).toString("latin1") + readFileSync(file).toString("utf8"); } catch { return ""; } }).join("\n");
}
/** The base fields of the event are unchanged by this patch; the diagnostic is the only addition. */
function diagnosticOf(store: FleetStore, taskId: string) {
	const event = store.events(taskId).findLast((row) => row.kind === "unknown")!;
	return { event, diagnostic: (event.data as any).failureDiagnostic };
}


describe("end to end through Fleet.start and the real store", () => {
	test("review M-1 end-to-end message: unknown event stores only class, step and fixed text", async () => {
		const f = fixture();
		try {
			const task = f.store.reserve(f.store.submit(input("m1")).id);
			const fleet = new Fleet(f.store);
			(fleet as any).node = async () => { throw new Error(corpus.reviewE2e); };
			const result = await fleet.start(task.id);
			expect(result).toMatchObject({ phase: "blocked_unknown", held: true, reason: "node_operation_failed_original_attempt_held" });
			const { event, diagnostic } = diagnosticOf(f.store, task.id);
			const op = f.store.getOperation(task.id, "prepare")!;
			expect(diagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.prepare", phase: "call", operationKind: "prepare", operationId: op.id, errorClass: "Error", code: "unclassified", message: UNCLASSIFIED });
			assertNoSentinel(JSON.stringify(event));
			f.store.close();
			assertDatabaseClean(f.db);
		} finally {
			f.store.close();
		}
	}, E2E_TIMEOUT);

	// Base itself stores TransportError code/certainty in `reason`/`failure`; those inputs are covered below.
	const baseStoresTransportFields = ["TransportError code", "TransportError tool_refused reason", "TransportError certainty"];
	// A before_send NodeReplyError is a retained refusal on production main: base stores its reply as the prepare
	// receipt (real replies are bounded by the helper protocol) and the task is not marked unknown.
	const baseStoresNodeReply = ["NodeReplyError forged reply"];
	for (const variant of variants.filter((v) => !baseStoresTransportFields.includes(v.input) && !baseStoresNodeReply.includes(v.input)))
		test(`prepare throws (${variant.input}) carrying every secret: nothing reaches the database`, async () => {
			const f = fixture();
			try {
				for (const [index, secret] of secretValues.entries()) {
					const task = f.store.reserve(f.store.submit(input(`k${index}`)).id);
					const fleet = new Fleet(f.store);
					(fleet as any).node = async () => { throw variant.build(secret); };
					await fleet.start(task.id);
					const { diagnostic } = diagnosticOf(f.store, task.id);
					assertOnlyAllowlisted(diagnostic);
				}
				f.store.close();
				assertDatabaseClean(f.db);
			} finally {
				f.store.close();
			}
		}, E2E_TIMEOUT);

	test("transport-code inputs: the diagnostic stores only the allowlisted prefix (base reason/failure fields are unchanged)", async () => {
		const f = fixture();
		try {
			for (const [v, variant] of variants.filter((v) => baseStoresTransportFields.includes(v.input)).entries())
				for (const [index, secret] of secretValues.entries()) {
					const task = f.store.reserve(f.store.submit(input(`k${v}-${index}`)).id);
					const fleet = new Fleet(f.store);
					(fleet as any).node = async () => identity(task, f.workspacePath);
					(fleet as any).connect = async () => { throw variant.build(secret); };
					await fleet.start(task.id);
					assertOnlyAllowlisted(diagnosticOf(f.store, task.id).diagnostic);
				}
		} finally {
			f.store.close();
		}
	}, E2E_TIMEOUT);

	test("hostile node helper: refusal stdout and stderr never reach the database", async () => {
		const lines = secretValues.flatMap((secret) => [
			{ ok: false, error: secret, message: secret, code: secret, stage: "prepare" },
			{ ok: false, error: secret, code: "fleet:root_denied", stage: secret },
		]);
		for (const line of lines) {
			const script = `await Bun.stdin.text(); console.error(${JSON.stringify(secretValues.join("\n"))}); console.log(${JSON.stringify(JSON.stringify(line))}); process.exit(1);`;
			const f = fixture(script);
			try {
				const task = f.store.reserve(f.store.submit(input("helper")).id);
				const result = await new Fleet(f.store).start(task.id);
				// Not a typed reply: production main's oneShot fails it as node_transport_failed (unknown).
				expect(result).toMatchObject({ phase: "blocked_unknown", reason: "node_transport_failed" });
				const { diagnostic } = diagnosticOf(f.store, task.id);
				assertOnlyAllowlisted(diagnostic);
				expect(diagnostic).toMatchObject({ errorClass: "TransportError", code: "transport:node_transport_failed" });
				f.store.close();
				assertDatabaseClean(f.db);
			} finally {
				f.store.close();
			}
		}
	}, E2E_TIMEOUT);

	test("hostile transport stderr and exit: only the transport code is stored", async () => {
		const script = `console.error(${JSON.stringify(secretValues.join("\n"))}); process.exit(3);`;
		const f = fixture(undefined, script);
		try {
			const task = f.store.reserve(f.store.submit(input("stderr")).id);
			const fleet = new Fleet(f.store);
			(fleet as any).node = async () => identity(task, f.workspacePath);
			const result = await fleet.start(task.id);
			expect(result.phase).toBe("blocked_unknown");
			const { diagnostic } = diagnosticOf(f.store, task.id);
			expect(diagnostic).toMatchObject({ source: "Fleet.start.connect", errorClass: "TransportError" });
			assertOnlyAllowlisted(diagnostic);
			f.store.close();
			assertDatabaseClean(f.db);
		} finally {
			f.store.close();
		}
	}, E2E_TIMEOUT);

	test("Store.transaction refusal diagnostic carries no message text and no message derivative", () => {
		const f = fixture();
		try {
			const task = f.store.reserve(f.store.submit(input("refusal")).id);
			expect(() => f.store.recordTurn(task.id, "turn-x")).toThrow();
			const refused = f.store.events(task.id).findLast((row) => row.kind === "refused")!;
			expect(refused.data).toMatchObject({ action: "recordTurn", code: "NO_SESSION", certainty: "local_transaction_rolled_back" });
			expect((refused.data as any).failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Store.transaction", phase: "record", errorClass: "FleetError", code: "fleet:no_session", message: DIAGNOSTIC_TEXT.get("fleet:no_session")! });
			assertOnlyAllowlisted((refused.data as any).failureDiagnostic);
		} finally {
			f.store.close();
		}
	});
});

describe("CLI show names the diagnostic behind the current reason", () => {
	test("a later refusal does not replace the diagnostic of the event that set the reason", async () => {
		const f = fixture();
		const task = f.store.reserve(f.store.submit(input("show")).id);
		const fleet = new Fleet(f.store);
		(fleet as any).node = async () => identity(task, f.workspacePath);
		(fleet as any).connect = async () => { throw new TransportError("transport_exited", "unknown"); };
		await fleet.start(task.id);
		expect(() => f.store.recordTurn(task.id, "turn-x")).toThrow();
		const refused = f.store.events(task.id).findLast((row) => row.kind === "refused")!;
		expect((refused.data as any).failureDiagnostic).toBeObject();
		const unknown = f.store.events(task.id).findLast((row) => row.kind === "unknown")!;
		f.store.close();
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const child = Bun.spawn([process.execPath, cli, "--db", f.db, "--cap", "8", "--read-only", "show", task.id], { stdout: "pipe", stderr: "pipe" });
		const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(exit).toBe(0);
		const value = JSON.parse(stdout);
		expect(value.reason).toBe("transport_exited");
		expect(value.failureDiagnostic).toEqual({ event: "unknown", sequence: unknown.sequence, ...(unknown.data as any).failureDiagnostic });
		expect(value.failureDiagnostic.code).toBe("transport:transport_exited");
	}, E2E_TIMEOUT);
});
