### Fixed
- A managed chat no longer reports a blocked connection after the Manager runtime changes while
  the same verified session process is still alive. The saved conversation stays readable in
  read-only mode until Manager finishes revalidating it, and the temporary state no longer clears
  the loaded turns.
