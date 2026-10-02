/**
 * A pane is known by its project, not by where it sits on disk. A shell's terminal title is
 * usually its working directory written out ("/home/me/dev/api", "~/dev/api", "C:\\work\\api"):
 * shown whole, it is cut off long before the part that tells panes apart. Such a title shows as
 * its last folder; the full path stays in the row's tooltip. Any other title is left alone.
 */
const PATH_TITLE = /^(?:~(?=$|[\\/])|\/|[A-Za-z]:[\\/])/;

export function shortPathTitle(title: string): string {
  const trimmed = title.trim();
  if (!PATH_TITLE.test(trimmed)) return title;
  const parts = trimmed.split(/[\\/]+/).filter((part) => part !== "");
  const last = parts.at(-1);
  if (last === undefined) return trimmed; // "/" itself
  return /^[A-Za-z]:$/.test(last) ? `${last}\\` : last;
}

/** "workspace · folder", without saying the same name twice. */
export function placeLine(workspace: string, folder: string): string {
  return !folder || folder === workspace ? workspace : !workspace ? folder : `${workspace} · ${folder}`;
}
