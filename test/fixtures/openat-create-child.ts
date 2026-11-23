// Runs in its own process so changing the umask cannot affect the test runner. Prints OK or throws.
import { closeSync, constants, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openatCreate } from "../../src/inputs";

// mkdtemp creates the directory 0700, so the (empty) 0640/0604 files are unreachable by other users.
const dir = mkdtempSync(join(tmpdir(), "fleet-openat-"));
let fd: number | undefined;
try {
	fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
	process.umask(0);
	for (const mode of [0o600, 0o640, 0o604, 0o700]) {
		for (let i = 0; i < 50; i++) {
			const created = openatCreate(
				fd,
				Buffer.from(`f${mode.toString(8)}-${i}\0`),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				mode,
			);
			if (created < 0) throw new Error("openat failed for mode " + mode.toString(8));
			const actual = fstatSync(created).mode & 0o777;
			closeSync(created);
			if (actual !== mode) throw new Error(`mode ${mode.toString(8)} requested, ${actual.toString(8)} created`);
		}
	}
	console.log("OK");
} finally {
	if (fd !== undefined) closeSync(fd);
	rmSync(dir, { recursive: true, force: true });
}
