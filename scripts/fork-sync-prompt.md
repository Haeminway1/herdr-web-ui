You are integrating upstream/main revision $FORK_SYNC_TARGET in $FORK_SYNC_WORKTREE on $FORK_SYNC_BRANCH. This is an isolated candidate; inspect the existing worktree and continue its current merge without resetting or discarding files. Read DEPLOY-FORK.md and docs/fork-inventory.md first.

Use upstream/main as the baseline. Keep only these fork-specific changes:

- The haeminway1.herdr-web-ui identity, version, port 7320 and separate config.
- Report dark/light colors, Report as the default, generated theme artifacts and accurate omission of unsupported Report telemetry settings. Do not change the theme generator or telemetry receiver.
- A compact visual skin over the native upstream MachineSidebar/Sidebar/AgentSidebar architecture. Keep upstream row controls, pins, keyboard/touch behavior, chat, terminal, files, input, refresh and other upstream features. Remove ClassicSidebar, custom grouping, attention/read-state and residents launch/navigation code.
- The exact managed-session resolver and only the conversation, prompt, runtime or protocol hooks needed for Manager identities. Keep nonce/generation, pid birth and boot, cwd, session id, header, inode and file checks. A GJC SDK timeout or execution failure must remain a sanitized retryable 504/503 through initial resolution and read-after-validation. It must never become pending/blocked identity or an empty HTTP 200. Preserve fresh public generationStatus proof, generation-scoped cursors, attachment/question fences and fail-closed behavior for absent, retired, mismatched or changed generations. Do not select a sibling or nearby transcript.
- The upstream-main revision sync and strict fork release gates.

Remove old fork-only features outside that list and their dead callsites, settings, tests and docs. Preserve user state and files outside this worktree. Do not add dependencies, services, timers or daemons. Do not change authentication, managed-session state, or native Herdr sessions.

Resolve conflicts against upstream code, then add back only the retained seams above. Do not copy old chat, sidebar, SDK queue/cache, or runtime files over upstream. Run the project's formatter, typecheck and focused tests for the retained seams. Run unit, integration and browser checks when practical and record exact failures. Use isolated fixtures only; never read or screenshot a live conversation.

Before recording validation, verify that $FORK_SYNC_TARGET is an ancestor of the candidate HEAD and that the candidate worktree is clean. After all local checks pass, atomically update $FORK_SYNC_STATE_FILE with state=validated, validation=local, target=$FORK_SYNC_TARGET, candidate=<HEAD>, and the check summary. On failure, atomically update state=failed with the target and a short safe reason. Preserve the existing attempt, branch, worktree and pane fields in either update so a retry resumes the same work. Never tag, push, publish, install, deploy, restart a service or user session, or run the release script.
