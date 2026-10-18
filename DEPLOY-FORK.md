# Fork deployment

`upstream/main` owns the UI, defaults, dependencies and runtime behavior. The retained fork differences
are listed in [docs/fork-inventory.md](docs/fork-inventory.md): the separate plugin identity and
port, Report colors, the existing classic sidebar with its residents, grouping, Manager pin and attention inbox, exact Manager session binding, and the
fork sync/release gates.

## Automatic sync

`scripts/fork-sync.sh` runs only from a clean `deploy/haemin` checkout. It fast-forwards that branch
from `origin/deploy/haemin`, fetches `upstream/main`, and compares the actual commit id. It does not
wait for a release tag. Dry-run reads remote state but never changes refs, the worktree, or sync
state. Each target revision has a dedicated worktree and explicit `started`, `failed`, `validated`,
`contained`, or `released` status. A status file alone is not completion: the target commit must be
contained in the candidate, and release completion also requires a fork tag that contains it.

Retries reuse the same branch and worktree. Active agent locks prevent duplicate launches. Existing
merge state and edits are preserved; unsafe or divergent worktrees are recorded as failures rather
than reset. The existing systemd timer and service remain unchanged.

The sync prompt preserves only the listed fork differences. It must use upstream files as the
baseline, run the applicable local checks, record a validated candidate only after checking actual
Git containment, and stop before tagging, pushing or publishing.

## Release gate

Keep the approved 0.4.1108 operating release and automatic installation disabled during stabilization.
Local tests or a hidden browser are not operational acceptance: the user's actual notebook Aside must
confirm the separate fake-data preview preserves the original sidebar, scrolling and navigation before
the supervising user session admits another deployment. A conflict never authorizes removing a kept UI.

Use `scripts/fork-release.sh X.Y.Z` only on a clean `deploy/haemin` checkout. The version in
`package.json` and `herdr-plugin.toml` must match and be newer than every published fork tag. The
script runs the locked install, Fast checks, Integration and browser checks, and requires the
`Native Windows install` check to pass for the exact commit. Any missing or failed gate stops the
release; no test is edited out or accepted as an upstream exception. Only after every gate passes
does the script create and push the fork tag and deployment branch, then mark contained targets as
released.

Do not deploy from a sync worktree, move an existing tag, force-push, or restart a Herdr/native
session. The canonical plugin and its config remain independent of this fork.
