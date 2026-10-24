### Fixed
- Mobile chat yields to upward touch and wheel input before updates or viewport resizing can pull
  the reader back down, and preserves the visible message when earlier history finishes laying out.
- Resending a restored draft no longer reports an automatic terminal cleanup as an in-flight edit
  or loses the draft when delivery is unconfirmed.
