export type FieldStatus = 'found' | 'missing' | 'needs_review' | 'manual'
export type ExtractionMethod = 'native' | 'ocr' | 'manual'

export interface EvidenceRect {
  left: number
  top: number
  width: number
  height: number
}

export interface Evidence {
  page: number
  rect: EvidenceRect
  text: string
  method: ExtractionMethod
  confidence: number | null
}

export interface ExtractedField<T> {
  value: T | null
  status: FieldStatus
  confidence: number | null
  rawText: string | null
  evidence: Evidence[]
}

export interface LineItem {
  quantity: ExtractedField<number>
  description: ExtractedField<string>
  value: ExtractedField<number>
  htsCode: ExtractedField<string>
}

export interface SourceToken {
  page: number
  text: string
  left: number
  top: number
  width: number
  height: number
  confidence: number | null
  method: ExtractionMethod
}

export interface PageTextData {
  page: number
  width: number
  height: number
  imageUrl: string
  nativeText: string
  nativeTokens: SourceToken[]
  ocrTokens: SourceToken[]
}

export interface ExtractionResult {
  billOfLadingNumber: ExtractedField<string>
  invoiceNumber: ExtractedField<string>
  shipperName: ExtractedField<string>
  shipperAddress: ExtractedField<string>
  consigneeName: ExtractedField<string>
  consigneeAddress: ExtractedField<string>
  lineItems: LineItem[]
  totalValueOfGoods: ExtractedField<number>
  pages: PageTextData[]
  processedAt: string
}

export type DocumentStatus = 'queued' | 'processing' | 'complete' | 'error'

export interface DocumentState {
  id: string
  file: File
  name: string
  size: number
  status: DocumentStatus
  progress: number
  progressLabel: string
  result?: ExtractionResult
  error?: string
}

export interface ProcessingUpdate {
  documentId: string
  progress: number
  label: string
  page?: number
  totalPages?: number
}
