// Reads an uploaded lesson file's text in the browser: .txt / .md directly,
// .docx with mammoth, .pdf with pdf.js. Both libraries load only when a file
// of that kind is uploaded, so they never weigh on the rest of the app.

export const lessonFileAccept = '.docx,.pdf,.txt,.md'

const maxFileBytes = 5 * 1024 * 1024
export const maxLessonTextLength = 30_000

export class LessonFileError extends Error {}

export async function readLessonFile(file: File): Promise<string> {
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (!['docx', 'pdf', 'txt', 'md'].includes(extension)) {
    throw new LessonFileError('This file type can’t be read. Upload a .docx, .pdf, .txt, or .md file.')
  }
  if (file.size > maxFileBytes) throw new LessonFileError('This file is larger than 5 MB. Upload a smaller file.')

  let text: string
  try {
    if (extension === 'docx') {
      const mammoth = await import('mammoth')
      text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value
    } else if (extension === 'pdf') {
      text = await readPdfText(await file.arrayBuffer())
    } else {
      text = await file.text()
    }
  } catch {
    throw new LessonFileError('This file couldn’t be read. It may be damaged or password-protected.')
  }

  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!cleaned) throw new LessonFileError('No text was found in this file. A scanned PDF (an image of a page) can’t be read.')
  if (cleaned.length > maxLessonTextLength) {
    throw new LessonFileError(`This lesson is too long to review (over ${maxLessonTextLength.toLocaleString()} characters). Upload a shorter lesson.`)
  }
  return cleaned
}

async function readPdfText(data: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const pdf = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const content = await (await pdf.getPage(number)).getTextContent()
    pages.push(
      content.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
        .join('')
        .replace(/[ \t]{2,}/g, ' '),
    )
  }
  return pages.join('\n\n')
}
