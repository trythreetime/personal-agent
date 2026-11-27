import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(value: string) {
  return DOMPurify.sanitize(marked.parse(value, { async: false }) as string, {
    ALLOWED_TAGS: [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'br',
      'hr',
      'blockquote',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'del',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
    ],
    ALLOWED_ATTR: ['href', 'title', 'start'],
  });
}
