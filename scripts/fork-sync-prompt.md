Upstream herdr-web-ui released {{TAG}}. scripts/fork-sync.sh began merging it into the fork in this worktree ({{TREE}}, branch sync/upstream-{{TAG}} from origin/deploy/haemin); the merge is uncommitted and left: {{MERGE}}.

Finish the sync so the user can keep every customization they use today and still get upstream's work. Reply to the user in concise Korean.

1. Read DEPLOY-FORK.md first: its "Fork features" list is what must keep working, and its release rules apply.
2. Resolve every conflict. Keep both sides: upstream's fixes and features, and each fork feature's user-visible behavior. Where upstream reimplemented a fork feature, use upstream's code only if the fork behavior survives; otherwise blend. Understand a hunk from `git log`/`git show` of both sides before choosing. Even with a clean merge, check that no fork feature was silently undone (code paths, settings defaults, i18n keys, tests).
3. Version: upstream X.Y.P becomes fork X.Y.(P*100+n), n starting at 1 and above any fork tag already on that base; set it in package.json and herdr-plugin.toml.
4. Run `bun install`, `bun run typecheck` and the focused tests of every file you touched until they pass, then commit the merge (`merge upstream {{TAG}}; fork features kept`).
5. Merge the branch into deploy/haemin in /home/haemin/lazy_projects/herdr-web-ui-worktrees/deploy (fast-forward; it must still descend from the running build), then run `scripts/fork-release.sh <version>` there. It tags and pushes only when its gates pass; never tag by hand.
6. If a fork feature cannot be kept without a design choice the user must make, or a gate fails for a reason you cannot fix, stop and ask in Korean with the options; do not release a build that drops a fork feature.
7. When released: update the "Fork features" list in DEPLOY-FORK.md if anything changed (commit it in the release), remove this worktree, and say in Korean what upstream brought, which conflicts you resolved and how, and the released version.
