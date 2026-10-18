# Fork delta inventory

This fork follows `upstream/main` for application behavior. The candidate baseline is
`f1491383275c11d37d1f11bbd826009972d72f4d`; routine sync tracks the current `main` commit, not
release tags.

| Retained delta | Boundary | Contract |
| --- | --- | --- |
| Independent plugin identity and runtime | `herdr-plugin.toml`, `scripts/plugin.ts`, install scripts, `shared/protocol.ts` | Keep `haeminway1.herdr-web-ui`, port 7320 and its existing separate config/state. The canonical plugin remains independent. |
| Report theme | Theme blocks in `src/styles.css`, theme registration, generated theme outputs | Report is the default in light and dark. Upstream themes remain available. The client omits unsupported Report telemetry settings; the receiver and theme generator stay upstream. |
| Compact sidebar appearance | `src/components/ReportSidebar.css` | Use the upstream MachineSidebar, Sidebar and AgentSidebar structure and interactions. The fork adds visual tokens only. |
| Exact Manager sessions | `server/managed-sessions.ts` and narrow conversation, GJC status, OMO, protocol and prompt seams | Bind only the declared nonce and generation after exact process, cwd, session id, header, inode and public GJC generation checks. Never guess a sibling or nearby transcript. |
| Fork sync and release | `scripts/fork-sync.sh`, its prompt and tests, `scripts/fork-release.sh` | Detect `upstream/main` revision changes, resume one isolated candidate safely, require actual target containment and all release gates. |

Everything outside these boundaries follows upstream, including chat and refresh behavior, terminal
input, files, workspace and agent navigation, pins, native status, mobile controls and browser tests.
ClassicSidebar, folder grouping, AttentionInbox/read-state and resident launch/navigation were removed;
their private data files outside this repository are not changed or deleted.
