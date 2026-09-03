import { getDocument, GlobalWorkerOptions, Util } from 'pdfjs-dist'
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js'
import type { DocumentState, PageTextData, ProcessingUpdate, SourceToken } from '../types'
import { parseDocument } from './parser'

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

type OCRProgress = (value: number, label: string) => void

export async function createOcrWorker(onProgress: OCRProgress): Promise<TesseractWorker> {
  return createWorker('eng', 1, {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/core',
    langPath: '/tesseract/lang',
    logger: (message) => onProgress(Math.round(message.progress * 100), message.status),
    errorHandler: (error) => onProgress(0, error instanceof Error ? error.message : 'OCR worker error'),
  })
}

export async function processBatch(
  documents: DocumentState[],
  onUpdate: (update: ProcessingUpdate) => void,
): Promise<Map<string, ReturnType<typeof parseDocument>>> {
  const results = new Map<string, ReturnType<typeof parseDocument>>()
  let worker: TesseractWorker | undefined
  try {
    worker = await createOcrWorker((progress, label) => {
      const current = documents.find((document) => document.status === 'processing')
      if (current) onUpdate({ documentId: current.id, progress, label })
    })

    for (const document of documents) {
      onUpdate({ documentId: document.id, progress: 0, label: 'Opening PDF' })
      const result = await processDocument(document.file, worker, (progress, label, page, totalPages) => {
        onUpdate({ documentId: document.id, progress, label, page, totalPages })
      })
      results.set(document.id, result)
    }
  } finally {
    if (worker) await worker.terminate()
  }
  return results
}

async function processDocument(file: File, worker: TesseractWorker, onProgress: (progress: number, label: string, page?: number, totalPages?: number) => void) {
  const buffer = await file.arrayBuffer()
  const pdf = await getDocument({ data: buffer }).promise
  const pages: PageTextData[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const scale = 2
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not create a PDF rendering context')

    onProgress(Math.round(((pageNumber - 1) / pdf.numPages) * 100), `Rendering page ${pageNumber} of ${pdf.numPages}`, pageNumber, pdf.numPages)
    await page.render({ canvasContext: context, canvas, viewport }).promise
    const imageUrl = canvas.toDataURL('image/jpeg', 0.86)
    const textContent = await page.getTextContent()
    const nativeTokens = nativeTokensFromPage(textContent.items, viewport, pageNumber)
    const nativeText = textContent.items.map((item) => ('str' in item ? item.str : '')).join('\n')

    onProgress(Math.round(((pageNumber - 0.5) / pdf.numPages) * 100), `Reading page ${pageNumber} with OCR`, pageNumber, pdf.numPages)
    const recognition = await worker.recognize(canvas, {}, { text: true, tsv: true })
    const ocrTokens = ocrTokensFromResult(recognition.data, pageNumber, canvas.width, canvas.height)

    pages.push({
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      imageUrl,
      nativeText,
      nativeTokens,
      ocrTokens,
    })
    onProgress(Math.round((pageNumber / pdf.numPages) * 100), `Finished page ${pageNumber}`, pageNumber, pdf.numPages)
  }

  return parseDocument(pages)
}

function nativeTokensFromPage(items: readonly unknown[], viewport: { width: number; height: number; transform: number[] }, pageNumber: number): SourceToken[] {
  const tokens: SourceToken[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item) || typeof item.str !== 'string' || !item.str.trim() || !('transform' in item)) continue
    const textItem = item as { str: string; transform: number[]; width?: number; height?: number }
    const transform = Util.transform(viewport.transform, textItem.transform)
    const fontHeight = Math.max(Math.hypot(transform[2], transform[3]), 1)
    const left = clamp(transform[4] / viewport.width)
    const top = clamp((transform[5] - fontHeight) / viewport.height)
    const scale = viewport.transform[0] ?? 1
    const width = clamp((textItem.width ?? fontHeight * textItem.str.length * 0.5) * scale / viewport.width, 0.005, 1)
    const height = clamp(fontHeight / viewport.height, 0.004, 1)
    const words = textItem.str.trim().split(/\s+/)
    const totalChars = Math.max(textItem.str.trim().length, 1)
    let offset = 0
    for (const word of words) {
      const start = textItem.str.indexOf(word, offset)
      offset = start + word.length
      const share = word.length / totalChars
      tokens.push({
        page: pageNumber,
        text: word,
        left: clamp(left + width * (start / totalChars)),
        top,
        width: clamp(width * share, 0.005, 1),
        height,
        confidence: null,
        method: 'native',
      })
    }
  }
  return tokens
}

function ocrTokensFromResult(data: unknown, pageNumber: number, imageWidth: number, imageHeight: number): SourceToken[] {
  const result = data as { words?: Array<{ text?: string; confidence?: number; bbox?: { x0: number; y0: number; x1: number; y1: number } }>; tsv?: string }
  if (Array.isArray(result.words) && result.words.length > 0) {
    return result.words.filter((word) => word.text?.trim() && word.bbox).map((word) => ({
      page: pageNumber,
      text: word.text?.trim() ?? '',
      left: clamp((word.bbox?.x0 ?? 0) / imageWidth),
      top: clamp((word.bbox?.y0 ?? 0) / imageHeight),
      width: clamp(((word.bbox?.x1 ?? 0) - (word.bbox?.x0 ?? 0)) / imageWidth, 0.002, 1),
      height: clamp(((word.bbox?.y1 ?? 0) - (word.bbox?.y0 ?? 0)) / imageHeight, 0.002, 1),
      confidence: validConfidence(word.confidence),
      method: 'ocr' as const,
    }))
  }
  return parseTsv(result.tsv ?? '', pageNumber, imageWidth, imageHeight)
}

function parseTsv(tsv: string, pageNumber: number, imageWidth: number, imageHeight: number): SourceToken[] {
  const lines = tsv.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const tokens: SourceToken[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split('\t')
    if (cells.length < 12) continue
    const text = cells.slice(11).join('\t').trim()
    if (!text) continue
    const left = Number(cells[6])
    const top = Number(cells[7])
    const width = Number(cells[8])
    const height = Number(cells[9])
    if (![left, top, width, height].every(Number.isFinite)) continue
    tokens.push({
      page: pageNumber,
      text,
      left: clamp(left / imageWidth),
      top: clamp(top / imageHeight),
      width: clamp(width / imageWidth, 0.002, 1),
      height: clamp(height / imageHeight, 0.002, 1),
      confidence: validConfidence(Number(cells[10])),
      method: 'ocr',
    })
  }
  return tokens
}

function validConfidence(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max)
}
