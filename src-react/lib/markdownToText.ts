// Convert Markdown to plain text suitable for channels that render plain text
// (Teams meeting chat via ACS, and the bridge's own chat view). Agent responses
// — especially from the Copilot CLI — often contain **bold**, headings, bullets,
// links and code fences that show up as literal markup in those channels.
//
// Deliberately conservative: it removes the common markup the agents emit but
// avoids mangling text that merely *contains* markdown-like characters, e.g.
// single underscores inside identifiers/emails/paths ("SE&O_ABS_US1639",
// "marcos.zanre@microsoft.com"). Single-underscore italics are intentionally
// left untouched for that reason.

export function markdownToPlainText(md: string): string {
  if (!md) return md
  let t = md

  // Fenced code blocks ```lang\n...\n``` → keep only the inner code.
  t = t.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
  // Inline code `x` → x
  t = t.replace(/`([^`]+)`/g, '$1')

  // Images ![alt](url) → alt
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Links [text](url) → text (url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')

  // Bold: **x** or __x__ → x  (double underscore is safe — identifiers use single)
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  // Italic: *x* → x  (only when the * hugs non-space, so "a * b" / bullets are safe).
  // Single-underscore italics are NOT stripped to protect identifiers/emails/paths.
  t = t.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '$1')
  // Strikethrough ~~x~~ → x
  t = t.replace(/~~([^~]+)~~/g, '$1')

  // ATX headings: "### Title" → "Title"
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  // Blockquotes: "> quote" → "quote"
  t = t.replace(/^\s{0,3}>\s?/gm, '')
  // Horizontal rules (---, ***, ___) → removed
  t = t.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
  // Unordered list markers (-, *, +) → bullet
  t = t.replace(/^(\s*)[-*+]\s+/gm, '$1• ')

  // Collapse 3+ blank lines to at most 2.
  t = t.replace(/\n{3,}/g, '\n\n')

  return t.trim()
}
