# Source-transfer byte-wire contract repair

Ready for independent re-review; not an overall green-suite claim.

## Contract

Untrusted delivery parameters of `receiveSource` and `deliverSource`, and the request parameter of `boundedLocal`, accept only a string or Uint8Array containing UTF-8 JSON. Object graphs are no longer an input format. There is no legacy fallback or object walker. The original string's UTF-8 byte length (not character count), or the original typed array's intrinsic byteLength, is checked against the inclusive 32 MiB limit before decoding, copying or parsing. Proxies and non-byte objects are rejected without property traversal. Byte input uses fatal UTF-8 decoding. The size is the actual serialized representation, including whitespace and escapes; JSON is not re-serialized to estimate an incoming size.

The incremental parser rejects duplicate keys (including escaped aliases), invalid JSON, trailing data, non-finite numeric values, more than 50,000 values and depth above eight before constructing the next value. Containers are built incrementally; no unbounded own-key list from a caller object is ever obtained. Allocation is bounded by the admitted 32 MiB text plus bounded constructed values, parser strings and downstream validation/copies; this is not a hard RSS quota. The strict delivery/InputPackage shape check rejects unexpected or missing fields, wrong types and containers deeper than the expected schema before content validation. Existing authorization, digest, object closure, path, file-count, base/final materialization and 16 MiB aggregate decoded-byte validation remain in force. Duplicate properties are refused rather than last-key-wins.

`stageSource` is a trusted producer: its binding/package arguments are internal objects, not an untrusted ingress. It serializes once and returns the checked serialized string, not a cloned object. Local NodeConfig, process arguments, transport configuration and result identity are trusted producer-side configuration. `receiveSource` parses an admitted delivery, validates it, and serializes the internal worker envelope once; that envelope has its own actual 32 MiB wire limit including node configuration. `returnResult` serializes its internal collect request once. The worker's streamed input checks aggregate bytes before concatenation and uses the same parser. Consumers must pass the staged string directly or supply their own already-serialized bytes; tests that mutate packages explicitly serialize their fixtures at the call boundary.

## Retained guarantees and limits

- Only Darwin/Linux local POSIX execution is supported. Windows and remote/SSH transports are explicitly unsupported; no remote cancellation guarantee is claimed.
- The detached child process group has a maximum 30-second execution deadline; shorter positive deadlines are allowed. Retained descendant pipes cannot bypass it. Every exit path kills the group, destroys pipes and awaits the direct child. Descendants cannot be waitpid-reaped here and must remain in the group; trusted executables must not escape it. Filesystem operations and parser CPU time are not an OS-wide deadline or quota.
- workspaceRoot must be new, canonical and single-use, with a trusted existing parent. Exclusive mkdir prevents deleting an existing/concurrent workspace. Failed preparation removes only the exclusively owned root, after child cleanup.
- No source history fetch, pack/bundle transport, authentication, shared services or production DB changes. Existing raw-object/authorized narrow-tree import remains. Parent commit identifiers are not removal of metadata; omitted parent objects do not travel.
- No hard RSS/filesystem quota, Linux/Windows execution proof, hostile group-escape containment or remote support is claimed.

## Verification

The focused tests cover both reviewer reproductions: sparse arrays and a 100,000-key object are refused as non-wire inputs, with zero Reflect.ownKeys allocation on the latter. Other tests cover UTF-8 string/byte wire counts, exact inclusive size boundary, duplicate keys, invalid UTF-8, node/depth limits, strict schema refusals, real Git roundtrip, history exclusion, root single-use, timeout cleanup, process-group descendants and output bounds.

On win32 those POSIX-behaviour tests are explicit named skips (`test/source-transfer-platform.ts`), not passes; the "platform gate" test runs on every platform and asserts that win32 refuses every entry point with `source_transfer_platform_unsupported` before parsing or spawning, while darwin/linux pass the gate.
