### Changed
- GJC chat follows the active session reported by its native extension when present, and uses
  verified SDK discovery otherwise. A pane with native authority never switches to a provider
  child when its record is unavailable. Command menus retain the filesystem skill catalog.

### Fixed
- Temporary GJC identity, broker or transcript read failures keep the displayed conversation
  while verification is pending, including a native record disappearing during its final check.
- Revoked SDK generations discard cached transcript authority before native skill discovery
  can refresh again; a fresh transcript proof is required before another broker read.
