### Fixed
- Restore automatic fork sync with released-policy fast-forwards and read-only dry runs.
- Explain pending or blocked managed-session identity inside the chat instead of an empty timeline.
- Recheck native GJC generations independently of cached listings, retain chat during SDK outages, and keep managed identity independent of saved transcript indexing.
- Treat broker, process-info, Git and transcript read failures as unavailable instead of a missing session. Keep managed panes pending without authorizing provider children, and distinguish a proven non-worktree directory from Git permission or ownership failures.
