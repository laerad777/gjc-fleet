# Local test environment

Use Bun 1.4.4 to match CI. From the repository root, run:

```sh
bun install --frozen-lockfile
bun test test
```

Keep Bun on PATH for these commands and for tests that launch it by name. The backlog test launches the active Bun binary directly, so it also works when Bun is started by absolute path.

Some tests exercise real filesystem behavior. Hardlinks require the source and destination to be on the same filesystem. The node-log hardlink fixture creates its target beside the log; do not substitute a cross-device target, because an `EXDEV` would prevent that test from reaching its assertions.

On Linux and macOS, three candidate-packaging tests need permission to create AF_UNIX sockets in a writable temporary directory. If a local run confirms that socket creation is denied or unsupported, it prints the reason and skips only those three socket cases. The FIFO and symlink checks still run. Node.js on PATH can supply the precise socket error when Bun omits it; an unverified failure is not skipped.

CI stays strict: it runs supported socket tests and fails if a socket cannot be created. Do not set or unset CI flags to hide fixture or product failures.
