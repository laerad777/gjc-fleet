# Public release: privacy scan, clean export and CI

This is the operator workflow for building the public tree. Nothing here pushes, deploys or configures a remote.

## Privacy scan

```sh
bun scripts/privacy-scan.ts                    # tracked files of the repository containing cwd
bun scripts/privacy-scan.ts --dir PATH         # every file under PATH (.git skipped)
    [--deny-list FILE] [--allow-list FILE] [--show-digest]
```

Every finding is printed as `<file>:<line>:<rule> [redacted <rule> len=<n>]`. The matched text is never printed. When the relative path itself matches, the matched part of the path is shown as `[redacted]`. Exit status: 0 means no finding, 1 means at least one finding, 2 means a usage or configuration error, or a filesystem error (such as a file that cannot be read), which prints only its errno code.

Rules: `private-ipv4` (10/8, 172.16/12, 192.168/16, 100.64/10), `public-ipv4` (globally routable addresses; this-network 0/8, loopback 127/8, link-local 169.254/16, the documentation ranges 192.0.2/24, 198.51.100/24 and 203.0.113/24, benchmark 198.18/15, and multicast/reserved 224/4 and above are not reported), `ipv6` (unique-local first byte fd and global unicast first three bits 001, written out in full or with one `::`; loopback, unspecified, link-local, multicast, IPv4-mapped and the documentation prefix 2001:0db8 /32 are not reported), `email` (documentation domains and role noreply addresses are allowed), `home-path-macos`, `home-path-linux`, `home-path-windows` (`C:\Users\<name>`, the Git-Bash/MSYS `/c/Users/<name>`, WSL `/mnt/c/Users/<name>` and Cygwin `/cygdrive/c/Users/<name>` forms, and the UNC `\\HOST\c$\Users\<name>` and default `\\HOST\Users\<name>` share forms), `volumes-path`, `snowflake-id` (17 to 20 digit identifiers) and `deny-list`. Account names may contain any Unicode letter or digit. Placeholder names such as `user`, `runner` or `Public` are not reported.

Known false positives and gaps:

- `private-ipv4` and `public-ipv4` match any four-part dotted number, so a four-part numeric version string such as a build number with four fields is reported as an address when each part is 0 to 255. Reword the text, or add an allow-list entry after review. Strings with five or more parts are not reported.
- `ipv6` only reports text that parses as a full 8-group address or one with a single `::`. A shortened form that is not a valid address is ignored. First byte fc (the unused half of the unique-local range), link-local and IPv4-mapped addresses are not reported.
- `ipv6` does not report forms with a dotted IPv4 suffix, such as `2001:db8::192.0.2.1`: a candidate never spans the dotted suffix, and the prefix alone does not parse as an address. A globally routable address written that way is missed.

Line 0 is the file itself:

- A match in the file's relative path (file and directory names).
- `unscanned-large-file`: the file is larger than 5 MB.
- `unscanned-binary-file`: the file contains a NUL byte and is not UTF-16 with a byte-order mark, starts with a UTF-32 byte-order mark, or is UTF-16 that is invalid or decodes to U+0000. UTF-16LE and UTF-16BE files with a byte-order mark (for example, the output of Windows PowerShell 5.1 redirection) are decoded and scanned like any other text file.
- `unscanned-undecodable`: any other file that is not valid UTF-8, such as a log in a legacy code page (cp949, Windows-1252). It is never decoded lossily.
- `unscanned-not-regular`: the entry is a symlink or other non-regular file, a tracked file is missing from the working tree, or a parent directory between the file and the scanned root is a symlink (or junction), is missing or is not a directory. Such a file is never read, so a symlinked directory cannot pull outside content into the scan. The check is bound to the file that is actually opened: the file is opened with `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO cannot block the scan), `fstat()` of that descriptor must be a regular file, and after the open every parent must still be a real directory, the path must still name the same device and inode, and its realpath (on Linux also the descriptor's own `/proc/self/fd` path) must be inside the root. Only then is the content read, from that descriptor. A symlink swapped into the path between the check and the open is therefore refused, not followed.

A failing `git` command (default mode) exits 2 and prints only the subcommand and its exit status, for example `git rev-parse failed (exit 128)`. Its stderr is not captured and never printed, not even redacted, because it can name the repository, a gitdir, a remote URL or a credential.

## Deny-list

Host names, account names and personal names cannot be detected by pattern. Put them in a `.privacy-deny-list` file outside the repository, or at the repository root, where `.gitignore` keeps it untracked. Write one literal word per line. Lines that start with `#` and blank lines are ignored. Matching is case-insensitive. Pass the file with `--deny-list FILE`. Its words are never printed.

## Allow-list

`scripts/privacy-allow.json` (or `--allow-list FILE`) exempts reviewed findings:

```json
{ "allow": [{ "file": "docs/a.md", "rule": "email", "sha256": "<64 lowercase hex digits>" }] }
```

- An entry exempts only that exact `(file, rule, sha256)` triple. Plain-text values are refused.
- For a text finding, `sha256` is the digest of the matched text.
- For `unscanned-binary-file` and `unscanned-undecodable`, `sha256` is the digest of the whole file, so any change to the file makes it a finding again.
- `unscanned-large-file` and `unscanned-not-regular` cannot be exempted.

Run the scan with `--show-digest` to print the digest each entry needs. Short values can be guessed from their digest, so the flag is opt-in.

## Clean export

`scripts/export-public.ts` builds the public source tree. It is unrelated to `src/result-export.ts`, which implements the Fleet `export` command for run results.

```sh
bun scripts/export-public.ts --out PATH [--repo PATH] [--exclude FILE] [--deny-list FILE]
```

- The export copies every file committed at `HEAD` of the repository into the new directory `PATH`. Uncommitted and untracked files are never exported.
- `PATH` must not exist or must be an empty directory, and it must be outside the source repository.
- The paths listed in `scripts/export-exclude.json` (as committed at `HEAD`) are left out. The format is `{"exclude": [{"path", "reason"}]}`, with exact repository-relative paths and a required reason. The export warns about entries that match no tracked file.
- The export refuses tracked symlinks and submodules.
- Before writing anything, the export refuses (exit 2) every `HEAD` path that the candidate packager's `safePath()` (`scripts/candidate-package.ts`) refuses, and names the rule: among others a `.git` segment at any depth in any case or HFS-ignorable form (and its 8.3 alias such as `GIT~1`), an empty, `.` or `..` segment, a backslash, a colon, a control character, one of `< > " | ? *`, a win32 device name (`CON`, `NUL .txt`, `COM1`, ...), a segment that ends in a dot or space, a name that is not NFC, and a path over 240 UTF-8 bytes. This applies on every host. Each target must also resolve inside `PATH`.
- The files are written to a private staging directory next to `PATH` (`.<name>.staging-XXXXXX`, created by `mkdtemp` with a random suffix, then forced to mode `0700` and checked to be a real directory owned by the current user), and the privacy scan runs on it, including any `.git` directory in it. It sits next to `PATH` so that publishing is a single rename on the same file system. Only a clean scan publishes it: the staging directory is renamed to `PATH`.
- Any finding fails the export with exit 1. On a finding and on every other failure nothing is published: `PATH` is not created (an existing empty `PATH` stays empty) and the staging directory is removed. The findings are printed redacted; to inspect the files, check out the commit.
- A failure after the staging directory was created prints its name (basename only, never an absolute path), for example `export-public: staging directory .public.staging-Ab12Cd next to --out: removed`. If it could not be removed, the line says `NOT removed, check and delete it by hand`, so leftovers can be found next to `PATH`.
- When the parent directory of `PATH` does not exist, the export creates it (with any missing ancestors). That directory is **not** removed when the export fails; the failure then also prints `export-public: created the missing parent directory of --out; it is left in place`.
- Windows is not verified: the staging mode check, `O_NOFOLLOW` and the descriptor-path check do not apply there, and these failure paths have not been run on Windows. Only macOS and Linux behaviour is tested.
- A file that cannot be written (for example, two `HEAD` paths that differ only in case on a case-insensitive file system) stops the export with exit 2 and names the path; nothing is published.
- Usage and refusal errors exit 2. A filesystem error (for example, a regular file in the parent path of `PATH`) exits 2 and prints only its errno code. A failing `git` command exits 2 and prints only its subcommand and exit status, never its stderr.
- Every path in an export message is printed through the privacy scan's redaction, with the `--deny-list` words loaded, so a private value in a file name never reaches the log.
- The export only reads the source repository.

## CI

`.github/workflows/ci.yml` runs on pull requests only, with read-only `contents` permission, Bun 1.4.4 and no secrets. It uses no self-hosted runner, and every action is pinned to a full commit SHA. A newer push to the same pull request cancels the older run.

Jobs:

- `changes` compares the pull request against its merge base. Only a nonempty change set limited to `README.md` and Markdown under `docs/` can skip the hosted OS suites. Empty or mixed changes run the suites; a classification error blocks the gate.
- `static` runs on `ubuntu-latest`: it checks Git is at least 2.44, lints the workflow, then runs `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bunx tsc --noEmit -p tsconfig.test.json`, `bun run build` and both `bun src/cli.ts --help` and `bun .local/build/cli.js --help`.
- `security` runs on `ubuntu-latest`: `bun scripts/privacy-scan.ts`, `bun run license:check`, then a secret scan of the pull request commits that never prints what it finds.
- On docs-only changes, `docs` runs `bun test test/export-public.test.ts` to check release documentation and its workflow contract.
- Otherwise, `test` runs on `ubuntu-latest` and `macos-latest`, and the separate `windows` job runs on `windows-latest` as three parallel shards. The Ubuntu and macOS jobs run `git --version`, `bun install --frozen-lockfile`, and `bun test test`. Each Windows shard runs `git --version`, `bun install --frozen-lockfile`, and `bun test test --shard="${{ matrix.shard }}/3"`; Bun sorts the test files by path and deals them round-robin across the shards, so the shards cover the suite exactly once.
- Separate Windows focus jobs run VHDX cleanup, restart observation, and daemon performance checks in parallel. They report targeted results early; the full Windows suite remains required by the gate.
- `PR gate` always requires `changes`, `static`, and `security` to pass. For docs-only changes, it requires `docs` to pass and both `test` and `windows` to be skipped. Otherwise, it requires `docs` to be skipped and all three hosted OS suites to pass, including Windows.

The hosted Windows suite does not replace the native acceptance run. The 11 tests in `test/windows-native.test.ts` need a real NTFS fixture directory (`FLEET_NATIVE_TEST_ROOT`) and are skipped in CI; run them by hand on an isolated, single-use Windows x64 machine.

The CI privacy scan checks the tracked files without any deny-list or secrets. It does not replace the private deny-list check, which stays a separate gate before every publication. Run it by hand:

```sh
bun scripts/export-public.ts --out "${TMPDIR:-/tmp}/public-export" --deny-list .privacy-deny-list
```

`--deny-list` takes the file described under Deny-list: the untracked `.privacy-deny-list` at the repository root. The option has no default; with no deny-list, omit it.
