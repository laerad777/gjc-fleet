# GJC Fleet notices and reuse inventory

This module's original implementation is MIT licensed; see LICENSE. No third-party source, docs, tests, assets or generated code have been copied or vendored into the distributable module source. Pattern references below are not incorporated components. No upstream NOTICE has been modified. This is not a claim of a full legal audit.

## Runtime and dependencies

There are no npm production or development dependencies and no install lifecycle scripts. The module uses Bun built-ins (SQLite, FFI, subprocess, test runner), Node-compatible standard APIs, and the operator's existing Git, OpenSSH and GJC executables. Bun's distribution has its own MIT and bundled-component notices; SQLite is public domain. System libc/libSystem (`*at` operations) and Windows kernel32/ntdll (handle-relative file operations) are dynamically opened and not redistributed. OS API names/layouts are used for interoperability; no OS implementation source is copied. These external runtimes are not bundled by `bun run build`. Bun FFI is experimental; this inventory is not native-ABI or production-safety acceptance.

GJC public CLI integration was inspected at `gajae-code` source commit `3a8783c44f5067ff105cc698cbca47dd39de7f2a` (MIT); the locally observed binary reports `gjc/0.19.3`. A matching version string is not proof that binary and source commits match. No SDK source or credential store is copied. Compatibility is operation-specific and must be checked on each installed node.

## Local development tooling

An isolated, non-redistributed formatting tool is installed only under ignored `.local/tools`: `@biomejs/biome@2.3.11` and its same-version Darwin arm64 binary, source `1550e7399da3e51c1d22fe26f37a8ff45058c355`, dual `MIT OR Apache-2.0`. Registry metadata, exact integrity values and scope are recorded in `license-inventory.json`; lifecycle scripts were disabled with `--ignore-scripts`. This is not a root package dependency, module source incorporation or permission to relabel the tool's licenses. Its distribution and notices are not part of the Fleet build.

## Reference-only sources

| Canonical repository | Exact commit | Investigated terms | Use |
|---|---|---|---|
| https://github.com/openai/symphony | be10a1b79df723d6d7612b5651c8522704dafb2e | Apache-2.0, upstream NOTICE exists | Host/workspace affinity and same-host follow-up identity; no source/expression incorporated |
| https://github.com/hatchet-dev/hatchet | 4a0a4f10b132f9d71236e6ab7324e4efb682c192 | MIT investigated scope; subtree terms require recheck before incorporation | Required constraints before preferences, global/node held slots; no dependency/source incorporation |
| https://github.com/OrchestratorInc/agent-orchestrator | 64129be1bfac1b20dab5ea267e91fc3444133e65 | Apache-2.0 root; assets/subtrees can differ | Session-host lifetime separate from hub projection; no incorporation |
| https://github.com/dbos-inc/dbos-transact-ts | 306b7324a050d3fc661aec4c4eef774c8bd38336 | MIT investigated scope | Considered but not adopted; no PostgreSQL/service/dependency |
| https://github.com/temporalio/sdk-typescript | 615a684ac41a22c881df11157775e326843f7b04 | MIT investigated scope | External-effect replay risk comparison only; not adopted |
| https://github.com/hashicorp/nomad | e77c361fd055c12659a194ed62eae477b6e45f40 | BSL-1.1, not treated as permissive | Disconnect/replacement counterexample only; no vendoring |

## Apache incorporation conditions

The current reference-only implementation does not ship Apache component bytes, so it does not pretend to include a vendored Apache NOTICE section. Before any future source, documentation, test, asset, derivative-expression or library incorporation:

1. Record canonical repository, full commit, original and destination paths, byte digests, use classification, exact file/subtree terms and transitive dependencies.
2. Preserve copyright/license/patent/trademark attribution, original headers and relevant NOTICE content. Do not relabel Apache portions as MIT-only.
3. Add a prominent modification notice in every changed incorporated file. Documentation or a PR body alone is insufficient.
4. Include the actual Apache LICENSE text and relevant readable NOTICE in every source/package/archive/object/binary distribution containing those portions. A link or inventory is not a license-copy substitute.
5. Only a separately authorized future PR may be opened. Its body must list canonical source, full commit, incorporation scope and modifications; this repository creates no PR.

Missing or unknown terms, NOTICE, modification marking, subtree overrides or distribution inclusion block incorporation/publication. Rewriting names or languages is not assumed to erase derivative-expression obligations. A licensing check never substitutes for functional acceptance, and passing functional tests never excuses missing notices.
