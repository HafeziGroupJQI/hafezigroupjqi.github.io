// A folder's name as people read it: "group-meeting-2026-09-29" is "Group meeting 2026-09-29".
// Dashes and underscores between words become spaces; the ones inside a date or a number stay.
export const folderTitle = (name) =>
  String(name)
    .replace(/(?<!\d)[-_]+|[-_]+(?!\d)/g, " ")
    .trim()
    .replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())
