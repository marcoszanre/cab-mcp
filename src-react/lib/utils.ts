import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Strip HTML tags from a string and decode HTML entities
 * Useful for cleaning up meeting chat messages before sending to agents
 */
export function stripHtml(html: string): string {
  // First replace common HTML entities
  let text = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  
  // Remove all HTML tags
  text = text.replace(/<[^>]*>/g, '')
  
  // Clean up extra whitespace
  text = text.replace(/\s+/g, ' ').trim()
  
  return text
}

/**
 * Extract plain text from meeting chat message content
 * Handles Teams mention spans and other HTML markup
 */
export function extractMessageText(content: string): string {
  // Handle Teams-style mentions: extract the name from the span (without @ prefix)
  // This avoids multiple @ symbols like "@Meeting @Helper @CPSAuth"
  let text = content.replace(
    /<span[^>]*itemtype="http:\/\/schema\.skype\.com\/Mention"[^>]*>([^<]+)<\/span>/gi,
    '$1'
  )
  
  // Handle paragraph tags - replace with space
  text = text.replace(/<\/p>\s*<p[^>]*>/gi, ' ')
  text = text.replace(/<p[^>]*>/gi, '')
  text = text.replace(/<\/p>/gi, '')
  
  // Strip remaining HTML
  text = stripHtml(text)
  
  // Clean up multiple consecutive spaces and trim
  text = text.replace(/\s+/g, ' ').trim()
  
  return text
}
