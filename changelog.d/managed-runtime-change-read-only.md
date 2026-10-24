### Fixed
- A managed chat no longer reports a blocked connection after the Manager runtime changes while
  the same verified session process is still alive. The saved conversation stays available, with
  restarting the managed session restricted, until Manager changes the record again, and the
  temporary state no longer clears the loaded turns.
