### Fixed
- GJC chats on a busy machine give cold session lookups up to five seconds per command and
  ten seconds overall instead of timing out after two seconds per command. Session snapshots
  retain the shorter status lookup budget; failed status lookups
  are held for 30 seconds without preventing chat reads from retrying.
- Missing or unreadable managed process evidence stays temporarily unavailable without
  clearing the current chat or authorizing a provider child.
- Fresh and cached GJC transcript bindings recheck their generation after the final
  pane-process read, so a concurrent new session cannot reuse the previous transcript.
