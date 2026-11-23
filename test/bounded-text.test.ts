import { expect, test } from "bun:test";
import { boundedText } from "../src/execution";

test("boundedText redacts URL userinfo including empty username", () => {
	const userPass = boundedText("clone failed https://deploy:S3cr3tPw@git.internal.example.com/org/repo.git");
	expect(userPass).toContain("https://[redacted]@git.internal.example.com/org/repo.git");
	expect(userPass).not.toContain("S3cr3tPw");
	expect(userPass).not.toContain("deploy:");

	const emptyUser = boundedText("fetch https://:pw-only@host.example/path");
	expect(emptyUser).toContain("https://[redacted]@host.example/path");
	expect(emptyUser).not.toContain("pw-only");
});

test("boundedText redacts CLI secret flags including quoted multiword values", () => {
	const bare = boundedText("gjc login --password hunter2-Pa55w0rd! --json");
	expect(bare).toContain("--password [redacted]");
	expect(bare).not.toContain("hunter2");
	expect(bare).not.toContain("Pa55w0rd");

	const quoted = boundedText(`gjc login --password "alpha beta gamma" --json`);
	expect(quoted).toBe(`gjc login --password [redacted] --json`);
	expect(quoted).not.toContain("alpha");
	expect(quoted).not.toContain("beta");
	expect(quoted).not.toContain("gamma");

	const escaped = boundedText(`tool --password "say \\"hi\\" now" done`);
	expect(escaped).toContain("--password [redacted]");
	expect(escaped).not.toContain("say");
	expect(escaped).not.toContain("hi");
});

test("boundedText redacts JSON secret keys with quote-aware containers", () => {
	const scalars = boundedText('agent said {"password":"hunter2","token":"ghp_ABCDEFGHIJKLMNOP"}');
	expect(scalars).toContain('"password":"[redacted]"');
	expect(scalars).toContain('"token":"[redacted]"');
	expect(scalars).not.toContain("hunter2");
	expect(scalars).not.toContain("ghp_ABCDEF");

	const embedded = boundedText('leak {"password":["a]b","c}d"],"ok":1}');
	expect(embedded).toContain('"password":"[redacted]"');
	expect(embedded).toContain('"ok":1');
	expect(embedded).not.toContain("a]b");
	expect(embedded).not.toContain("c}d");

	const escVal = boundedText('x {"password":"say \\"hi\\" now","ok":true}');
	expect(escVal).toContain('"password":"[redacted]"');
	expect(escVal).toContain('"ok":true');
	expect(escVal).not.toContain("say");

	const escKey = boundedText('x {"pas\\"sword":"hunter2-visible","password":"hide-me"}');
	expect(escKey).toContain("hunter2-visible");
	expect(escKey).toContain('"password":"[redacted]"');
	expect(escKey).not.toContain("hide-me");
});

test("boundedText JSON container length is fail-closed at 256 content chars", () => {
	const exact = boundedText(`{"password":[${"a".repeat(256)}],"ok":1}`);
	expect(exact).toContain('"password":"[redacted]"');
	expect(exact).toContain('"ok":1');
	expect(exact).not.toContain("aaa");

	const over = boundedText(`{"password":[${"a".repeat(257)}],"ok":1}`);
	expect(over).toContain('"password":"[redacted]"');
	expect(over).not.toContain('"ok":1');
	expect(over).not.toContain("aaa");
});

test("boundedText JSON depth overflow and bare values fail-closed", () => {
	let nested = "1";
	for (let i = 0; i < 40; i++) nested = `{"n":${nested}}`;
	const deepOut = boundedText(`{"password":${nested},"ok":1}`);
	expect(deepOut).toContain('"password":"[redacted]"');
	expect(deepOut).not.toContain('"ok":1');

	const bare = boundedText('{"password":hunter2-bare,"ok":1}');
	expect(bare).toContain('"password":"[redacted]"');
	expect(bare).not.toContain("hunter2");
	expect(bare).toContain('"ok":1');
});

test("boundedText decodes unicode-escaped JSON secret keys", () => {
	const raw = '{"passwor\\u0064":"hunter2-secret","ok":1}';
	expect(Object.keys(JSON.parse(raw))).toContain("password");
	expect(JSON.parse(raw).password).toBe("hunter2-secret");
	const out = boundedText(raw);
	expect(out).toContain('"password":"[redacted]"');
	expect(out).toContain('"ok":1');
	expect(out).not.toContain("hunter2");
});

test("boundedText JSON scan ignores stray quotes and closed trailing strings", () => {
	const stray = 'note " ahead {"password":"hunter2","ok":1}';
	const strayOut = boundedText(stray);
	expect(strayOut).toContain('"password":"[redacted]"');
	expect(strayOut).toContain('"ok":1');
	expect(strayOut).not.toContain("hunter2");

	expect(boundedText('hello "world"')).toContain('"world"');
	expect(boundedText('hello "world"')).not.toMatch(/^\[redacted\]/);
});

test("boundedText keeps prior assignment and bearer coverage", () => {
	expect(boundedText("password=hunter2")).toBe("password=[redacted]");
	const auth = boundedText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
	expect(auth).not.toContain("eyJhbGci");
	expect(auth).toContain("[redacted]");
});

test("boundedText stays linear on long whitespace between a secret flag and its value", () => {
	const spaces = " ".repeat(100_000);
	const input = `--password${spaces}hunter2`;
	const start = performance.now();
	const out = boundedText(input);
	expect(performance.now() - start).toBeLessThan(250);
	expect(out).toContain("--password");
	expect(out).toContain("[redacted]");
	expect(out).not.toContain("hunter2");
});

test("boundedText JSON scan stays linear on 40k spans and depth 32/33", () => {
	const flood = '"' + '\\"'.repeat(40_000);
	const floodStart = performance.now();
	const flooded = boundedText(flood + ' {"password":"should-mask","ok":1}');
	expect(performance.now() - floodStart).toBeLessThan(250);
	expect(flooded).not.toContain("should-mask");
	// Structural form on a short stray-quote prefix (long floods are length-capped).
	expect(boundedText('" {"password":"should-mask","ok":1}')).toContain('"password":"[redacted]"');

	const closedNoise = Array.from({ length: 40_000 }, () => '"x"').join(" ");
	const noisyStart = performance.now();
	const noisy = boundedText(closedNoise + ' {"password":"hunter2","ok":1}');
	expect(performance.now() - noisyStart).toBeLessThan(250);
	expect(noisy).not.toContain("hunter2");

	const nest = (depth: number) => {
		let body = "1";
		for (let i = 0; i < depth; i++) body = `{"n":${body}}`;
		return body;
	};
	const at32 = boundedText(`{"password":${nest(32)},"ok":1}`);
	expect(at32).toContain('"password":"[redacted]"');
	expect(at32).toContain('"ok":1');

	const at33 = boundedText(`{"password":${nest(33)},"ok":1}`);
	expect(at33).toContain('"password":"[redacted]"');
	expect(at33).not.toContain('"ok":1');
});

test("boundedText asserts redacted JSON structure under a large limit", () => {
	// Default CAUSE_TEXT_LIMIT truncates long prefixes before structural asserts can land;
	// a large explicit limit keeps the full redacted form visible for review contracts.
	const closedNoise = Array.from({ length: 40_000 }, () => '"x"').join(" ");
	const large = 500_000;
	const out = boundedText(closedNoise + ' {"password":"hunter2","ok":1}', large);
	expect(out.length).toBeLessThan(large);
	expect(out).not.toMatch(/truncated/);
	expect(out).toContain('"password":"[redacted]"');
	expect(out).toContain('"ok":1');
	expect(out).not.toContain("hunter2");

	const flood = '"' + '\\"'.repeat(40_000);
	const flooded = boundedText(flood + ' {"password":"should-mask","ok":1}', large);
	expect(flooded).toContain('"password":"[redacted]"');
	expect(flooded).toContain('"ok":1');
	expect(flooded).not.toContain("should-mask");
});
