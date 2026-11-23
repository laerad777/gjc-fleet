# Collection trust model

Collection (`collectResult` in `src/workspace.ts`) decides what a worker's workspace exports. Round 9 replaces route-by-route checks of the workspace's Git state with one rule: **the worker controls the workspace's files and nothing else is read from it.**

## Preparation (before the worker exists)

`checkPreparation` reads the source repository once (`sourceFacts`). `materializeWorkspace` then writes `<workspaceRoot>/.collection-snapshots/<task>-<attempt>.json` and `.index`. These files sit next to the workspace and never inside it. The identity holds `collectionSnapshot`, which is the SHA256 of the JSON. The JSON records:

| Field | Content |
|---|---|
| `baseCommit` | The commit the workspace was checked out at. |
| `objectFormat`, `objects` | The source repository's object store. This is the only source of base content. |
| `config` | The values of `COLLECTION_CONFIG_KEYS` (eol/autocrlf/filemode/ignorecase/precompose/symlinks/`diff.*`, ...). Any other value for these keys refuses preparation with `collection_config_unsupported`. |
| `rules.info_exclude` | The text of the shared `info/exclude`. |
| `rules.excludes_file` | The text of the repository-selected `core.excludesFile` (every scope and include; `includeIf` evaluated on the source repository). |
| `rules.node_excludes_file` | The text of the node's own global/system excludes file (else Git's default). |
| `root` | The filesystem identity (`dev:ino`) of the workspace directory. |
| `index` | The SHA256 of the `.index` file. This is the index of the fresh checkout: exactly the base tree, with its stat data. The base tree's in-tree `.gitignore` files are recorded here by blob id. |

## Collection

1. The node verifies the snapshot digests. Any mismatch, missing file or symlink gives `collection_snapshot_mismatch`. The node then requires the workspace path to be the same directory (`workspace_identity_mismatch`).
2. The node creates a neutral repository in the OS temp dir (`neutralRepository`):
   - `HEAD` is the base commit, and the source object store is an alternate.
   - The config is written from the snapshot alone, and `info/exclude` and the excludes files hold the snapshotted rule text.
   - The snapshotted index is copied in.
3. Git then runs with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, no system or global config, and HOME/XDG inside the neutral directory. Git never discovers the workspace `.git`.
4. If the base tree is no longer in the store, collection fails with `source_repository_missing`.
5. The workspace tree is walked by filesystem identity (`scanWorkspace`), which finds nested repositories and `.gitignore` locations. Git serves only as a matcher: `status`/`ls-files --ignored`. Diffs are taken against the node index, so the result is the base tree compared with the files.
6. The node's own excludes file is applied both as snapshotted and as it is now. The live value is resolved with the node's real HOME/XDG, and `includeIf` is evaluated on an empty detached repository. If the file resolves inside the workspace, collection fails with `ignore_rules_inside_workspace`.
7. Collection makes no export decision from, and lets no Git process of the export read:
   - the workspace `.git` file or directory;
   - the admin directory (index, HEAD, refs, `config.worktree`, `commondir`, `gitdir`);
   - the source repository's config or `info/exclude`;
   - `GIT_*` from the environment.

   The one exception is `outputHead` (provenance only, below): one `git rev-parse HEAD` run in the workspace with discovery, so it reads the workspace `.git` and, through a `.git` file, the Git directory it names (which may be outside the workspace), bounded by `COLLECTION_GIT_TIMEOUT_MS`.

The exported shapes, design (a) (`result.exportIncomplete` and audited acceptance bound to the manifest digest, enforced by the store's `verifyResult`, `requireExportReview` and `acceptIncompleteExport`; no schema trigger or table is added), nested-repository detection and OS junk handling are unchanged. A stored legacy-v1 manifest (an earlier release's collector) is compared with a fresh collection on identity and exported files only: that collector took the patch from `git diff <baseCommit>` of the worktree, which differs here once a worker commits (review fx-093cc54b F3). `outputHead` is still the workspace HEAD as Git reports it (`git rev-parse HEAD` in the workspace, last, after every export check), because production's work-unit provenance reads it. This read is worker-controlled: a redirected `.git` makes it report that repository's HEAD. It is bounded by `COLLECTION_GIT_TIMEOUT_MS`, and a HEAD Git cannot read (a deleted or garbage `.git`, a timeout, output that is not a commit id) gives `outputHead = baseCommit`, which `outputHeadCreated` treats as no output head created (deny by default); it no longer refuses the collection (production: `git_failed`). It is never part of the export decision. The verification receipt binds the stored manifest's own digest.

## What stays worker-controlled

- **Every file in the workspace.** This includes in-tree `.gitignore` and `.gitattributes` files. These are deliverables: they are exported and visible in the patch. An in-tree `!negation` can therefore re-include a path that the node's global rules ignore, which is Git's precedence (preprepare W13). The negation and the file are both in the reviewed export, the same as on main.
- **Deletion of a base-tracked file.** This is the only way to stop tracking it. A worker's `git rm --cached` or `git add`/`commit`, staged gitlinks, HEAD moves, config (including `extensions.worktreeConfig` + `core.worktree`, MEDIUM-A), `info/exclude`, `.git` redirects and admin-directory edits change nothing in the export; HEAD moves and `.git` redirects do change `outputHead` (provenance only, see above).
- **Content of the shared object store.** The store is shared with the worker in a same-uid deployment. A replaced loose object can alter only the preimage of the exported patch, because the tracked set comes from the snapshotted index, not from objects. A wrong preimage does not apply to the trusted base.
- **The node's live excludes file**, if the worker can write it. It is applied in addition to the snapshot, so it can only add exclusions and never remove one that was snapshotted.
- **Edits to the source repository's `info/exclude` or `core.excludesFile` after preparation.** These are ignored in both directions (W11, W12, J6). Operator rules must be in place before preparation.

## Legacy identities

An identity prepared without a snapshot (by a release before snapshots) is collected from the source root's rules and configuration as they are at collection, as that release collected it. Those are worker-writable, so the node reports the result as legacy-v1 (no completeness fields): its completeness is `unknown`, and a passing verification waits for operator acceptance of the export review. A verification receipt of such a collection records `observedExclusions: null` (observed nothing), which is accepted only for a manifest whose identity has no snapshot. A stored legacy-v1 manifest from an earlier release's collector can hold files this collector withholds at a repository boundary (an untracked bare repository, a directory holding a `.git` entry that is not a repository). Explicit verification names the stored file paths to the node (`observeBoundaries`) and asks for the fresh collection's boundaries and for what the workspace holds at each stored path they withhold, read as the collector reads a file (answered outside the manifest as `withheldBoundaries` and `withheldFiles`: the entry without its content, or `unreadable`). When every fresh file is exactly the stored one and every stored file it lacks lies at or below a `nested_repository`/`gitlink` boundary and is byte-, mode- and deletion-identical to what the node read there (review fx-1091e277 F2), this is not `ARTIFACT_CHANGED`: the receipt records the boundaries holding them as `observedExclusions` (completeness `incomplete`), and the task awaits export review (review fx-6f923f88 F2).

## Verification evidence (MEDIUM-B)

`verificationEvidence` keeps cb1b744's exact shape `{manifestDigest, testCount, trust}`, so an older release reads every task this release verified. Completeness and acceptance are recorded in `result.exportEvidence`.

Until an operator accepts a pending export review, no persisted shape verifies the task in an older release (review fx-093cc54b F1): a fresh collection with passing commands is stored `not_run` without tests (the verifier receipt stays `testReceipt`), and an explicit verification's receipt is held once, as its receipt-less result-test claim's `held` field in the operations table; the task row keeps only its digest (`result.exportIncomplete.resultTestDigest`, review fx-6f923f88 F3). This release joins them again on every read. Acceptance never rewrites the stored manifest: a held `not_run` manifest stays `not_run` beside its retained `testReceipt`. In its own transaction acceptance moves a held receipt to the claim's `receipt` (removing `held`) and records the acceptance and `verified`.
