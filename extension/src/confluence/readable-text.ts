export function readableText(html: string): string {
  // Template contents are inert, including images and embedded frames.
  const template = document.createElement('template')
  template.innerHTML = html
  for (const node of template.content.querySelectorAll('script, style, template, iframe, object, noscript, [hidden]')) {
    node.remove()
  }
  for (const node of template.content.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, pre, blockquote, tr, br')) {
    node.after('\n')
  }
  for (const node of template.content.querySelectorAll('th, td')) node.after(' ')
  return (template.content.textContent ?? '')
    .replace(/[\t\f\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
