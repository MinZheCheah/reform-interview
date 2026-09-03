import type {
  Evidence,
  ExtractedField,
  ExtractionResult,
  LineItem,
  PageTextData,
  SourceToken,
} from '../types'

interface VisualLine {
  page: number
  tokens: SourceToken[]
  ocrTokens: SourceToken[]
  text: string
  top: number
  bottom: number
}

const AMOUNT_RE = /^\$?\(?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?$/
const NUMERIC_RE = /^-?\d+(?:,\d{3})*(?:\.\d+)?$/
const CODE_RE = /^[A-Z0-9][A-Z0-9./_-]{5,}$/i
const HTS_RE = /^\d{6,12}$/

export function parseDocument(pages: PageTextData[]): ExtractionResult {
  const lines = pages.flatMap((page) => buildLines(page))
  const billOfLadingNumber = parseIdentifier(lines, 'billOfLading')
  const invoiceNumber = parseIdentifier(lines, 'invoice')

  const shipper = parseParty(lines, 'shipper')
  const consignee = parseParty(lines, 'consignee')
  const lineItems = parseLineItems(lines)
  const totalValueOfGoods = parseTotal(lines)

  return {
    billOfLadingNumber,
    invoiceNumber,
    shipperName: shipper.name,
    shipperAddress: shipper.address,
    consigneeName: consignee.name,
    consigneeAddress: consignee.address,
    lineItems,
    totalValueOfGoods,
    pages,
    processedAt: new Date().toISOString(),
  }
}

function buildLines(page: PageTextData): VisualLine[] {
  const tokens = (page.nativeTokens.length > 0 ? page.nativeTokens : page.ocrTokens)
    .filter((token) => token.text.trim())
    .sort((a, b) => a.top - b.top || a.left - b.left)

  const lines: VisualLine[] = []
  for (const token of tokens) {
    const center = token.top + token.height / 2
    const existing = lines.find(
      (line) => line.page === page.page && Math.abs(center - (line.top + line.bottom) / 2) < Math.max(token.height, 0.012),
    )
    if (existing) {
      existing.tokens.push(token)
      existing.top = Math.min(existing.top, token.top)
      existing.bottom = Math.max(existing.bottom, token.top + token.height)
      existing.tokens.sort((a, b) => a.left - b.left)
      existing.text = existing.tokens.map((item) => item.text).join(' ')
    } else {
      lines.push({
        page: page.page,
        tokens: [token],
        ocrTokens: page.ocrTokens,
        text: token.text,
        top: token.top,
        bottom: token.top + token.height,
      })
    }
  }
  return lines.sort((a, b) => a.page - b.page || a.top - b.top)
}

function parseIdentifier(lines: VisualLine[], kind: 'billOfLading' | 'invoice'): ExtractedField<string> {
  for (const line of lines) {
    const compact = compactText(line.text)
    const label = kind === 'invoice'
      ? compact.includes('INVOICENO') || compact.includes('INVOICENUMBER') || compact.includes('INVOICE#')
      : compact.includes('BLNO') || compact.includes('BLNUMBER') || compact.includes('BILLOFLADINGNO') || compact.includes('BILLOFLADINGNUMBER')

    if (!label) continue

    const labelMatch = kind === 'invoice'
      ? line.text.match(/invoice\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9-]+)/i)
      : line.text.match(/(?:B\s*\/\s*L|B\s*\/\s*L\s*No\.?|bill\s+of\s+lading)\s*(?:no\.?|number)?\s*[:#-]?\s*([A-Z0-9-]+)/i)

    if (labelMatch?.[1] && !looksLikeDate(labelMatch[1])) {
      const source = findTokensForText(line.tokens, labelMatch[1])
      return field(labelMatch[1].trim(), source, lines)
    }

    const next = lines.find((candidate) => candidate.page === line.page && candidate.top > line.bottom && candidate.top - line.bottom < 0.06)
    if (next) {
      const value = next.tokens.map((token) => token.text).join('').replace(/[^A-Z0-9-]/gi, '')
      if (value && !looksLikeDate(value)) return field(value, next.tokens, lines)
    }
  }

  return missingField()
}

function parseParty(lines: VisualLine[], kind: 'shipper' | 'consignee') {
  const aliases = kind === 'shipper' ? ['shipper', 'exporter'] : ['consignee', 'consigned to']
  const stopLabels = kind === 'shipper'
    ? ['consignee', 'consigned to', 'notify', 'invoice to', 'marks', 'terms']
    : ['notify', 'invoice to', 'forwarder', 'marks', 'terms', 'place of shipment', 'mode of transportation']

  const anchorIndex = lines.findIndex((line) => aliases.some((alias) => compactText(line.text).includes(compactText(alias))))
  if (anchorIndex >= 0) {
    const anchor = lines[anchorIndex]
    const sameColumn = anchor.tokens[0]?.left < 0.53 ? 'left' : 'right'
    const candidateLines: VisualLine[] = []
    for (let index = anchorIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.page !== anchor.page) break
      if (stopLabels.some((label) => compactText(line.text).includes(compactText(label)))) break
      const center = line.tokens.reduce((sum, token) => sum + token.left + token.width / 2, 0) / Math.max(line.tokens.length, 1)
      const inColumn = sameColumn === 'left' ? center < 0.53 : center >= 0.47
      if (inColumn) candidateLines.push(line)
    }

    const tokens = candidateLines.flatMap((line) => line.tokens)
    const cleaned = tokens.filter((token) => !aliases.some((alias) => compactText(token.text) === compactText(alias)))
    if (cleaned.length > 0) return splitParty(cleaned, lines)
  }

  if (kind === 'shipper') {
    const fallback = lines
      .filter((line) => line.page === 1 && line.top < 0.22 && line.tokens[0]?.left < 0.53)
      .flatMap((line) => line.tokens)
      .filter((token) => !/commercial|invoice|page|number|date/i.test(token.text))
    if (fallback.length > 0) return splitParty(fallback.slice(0, 12), lines)
  }

  return { name: missingField<string>(), address: missingField<string>() }
}

function splitParty(tokens: SourceToken[], lines: VisualLine[]) {
  const nonEmpty = tokens.filter((token) => token.text.trim())
  if (nonEmpty.length === 0) return { name: missingField<string>(), address: missingField<string>() }

  const grouped: SourceToken[][] = []
  for (const token of nonEmpty) {
    const previous = grouped[grouped.length - 1]
    if (!previous || Math.abs(token.top - previous[0].top) > Math.max(token.height, 0.012)) grouped.push([token])
    else previous.push(token)
  }
  const nameTokens = grouped[0] ?? []
  const addressTokens = grouped.slice(1).flat()
  return {
    name: field(nameTokens.map((token) => token.text).join(' '), nameTokens, lines),
    address: addressTokens.length > 0
      ? field(grouped.slice(1).map((row) => row.map((token) => token.text).join(' ')).join('\n'), addressTokens, lines)
      : missingField<string>(),
  }
}

function parseLineItems(lines: VisualLine[]): LineItem[] {
  const headerIndex = lines.findIndex((line) => {
    const text = compactText(line.text)
    return (text.includes('EXTENDED') || text.includes('EXTENSION')) && (text.includes('QUANTITY') || text.includes('QTY'))
  })
  if (headerIndex < 0) return []

  const header = lines[headerIndex]
  const quantityX = findHeaderX(header, ['quantity', 'qty'])
  const descriptionX = findHeaderX(header, ['description', 'modelno', 'partnumber'])
  const htsX = findHeaderX(header, ['htsus', 'hts'])
  const valueX = findHeaderX(header, ['extended', 'extension'])
  const result: LineItem[] = []
  let current: LineItem | null = null

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.page !== header.page) break
    const compact = compactText(line.text)
    if (/^(SUBTOTAL|INVOICETOTAL|TOTAL|COST)/.test(compact)) break

    const codeToken = line.tokens.find((token) => CODE_RE.test(token.text.replace(/[^A-Z0-9._/-]/gi, '')) && !AMOUNT_RE.test(token.text))
    const quantityToken = nearestNumeric(line.tokens, quantityX, false)
    const valueToken = nearestNumeric(line.tokens, valueX, true)
    const htsToken = htsX === null ? undefined : line.tokens.find((token) => HTS_RE.test(token.text.replace(/[^0-9]/g, '')) && Math.abs(token.left - htsX) < 0.18)

    if (codeToken && (quantityToken || valueToken)) {
      if (current) result.push(current)
      const descriptionTokens = line.tokens.filter((token) => {
        const center = token.left + token.width / 2
        const start = Math.min(codeToken.left + codeToken.width, descriptionX ?? codeToken.left)
        const end = htsX ?? quantityX ?? valueX ?? 1
        return center >= start - 0.01 && center < end - 0.02 && token !== codeToken
      })
      current = {
        quantity: quantityToken ? field(parseNumber(quantityToken.text), [quantityToken], lines) : missingField(),
        description: descriptionTokens.length > 0 ? field(descriptionTokens.map((token) => token.text).join(' '), descriptionTokens, lines) : missingField(),
        value: valueToken ? field(parseNumber(valueToken.text), [valueToken], lines) : missingField(),
        htsCode: htsToken ? field(htsToken.text.replace(/[^0-9]/g, ''), [htsToken], lines) : missingField(),
      }
    } else if (current && line.tokens.some((token) => /[A-Za-z]/.test(token.text))) {
      const continuation = line.tokens.filter((token) => !AMOUNT_RE.test(token.text) && !NUMERIC_RE.test(token.text))
      if (continuation.length > 0) {
        const updated = current.description.value ? `${current.description.value} ${continuation.map((token) => token.text).join(' ')}` : continuation.map((token) => token.text).join(' ')
        current.description = field(updated, [...current.description.evidence.map((item) => evidenceToToken(item)), ...continuation], lines)
      }
    }
  }
  if (current) result.push(current)
  return result
}

function parseTotal(lines: VisualLine[]): ExtractedField<number> {
  const candidates = lines.filter((line) => {
    const compact = compactText(line.text)
    return compact.includes('INVOICETOTAL') || compact === 'TOTAL' || compact.startsWith('TOTAL ')
  })

  for (const line of candidates) {
    const amount = [...line.tokens].reverse().find((token) => AMOUNT_RE.test(token.text.replace(/\s/g, '')))
    if (amount) return field(parseNumber(amount.text), [amount], lines)
    const next = lines.find((candidate) => candidate.page === line.page && candidate.top > line.bottom && candidate.top - line.bottom < 0.06)
    const nextAmount = next?.tokens.find((token) => AMOUNT_RE.test(token.text.replace(/\s/g, '')))
    if (nextAmount) return field(parseNumber(nextAmount.text), [nextAmount], lines)
  }
  return missingField()
}

function field<T>(value: T, source: SourceToken[], lines: VisualLine[], status: ExtractedField<T>['status'] = 'found'): ExtractedField<T> {
  const evidence = mapEvidence(source, lines)
  const ocrScores = evidence.map((item) => item.confidence).filter((score): score is number => score !== null)
  return {
    value,
    status,
    confidence: ocrScores.length > 0 ? Math.round(ocrScores.reduce((sum, score) => sum + score, 0) / ocrScores.length) : null,
    rawText: source.map((token) => token.text).join(' '),
    evidence,
  }
}

function missingField<T>(): ExtractedField<T> {
  return { value: null, status: 'missing', confidence: null, rawText: null, evidence: [] }
}

function mapEvidence(source: SourceToken[], lines: VisualLine[]): Evidence[] {
  const ocrTokens = Array.from(new Map(
    lines.flatMap((line) => line.ocrTokens).map((token) => [`${token.page}:${token.left}:${token.top}:${token.text}`, token]),
  ).values())
  return source.map((token) => {
    const ocrMatch = ocrTokens
      .filter((candidate) => candidate.page === token.page)
      .sort((a, b) => distance(a, token) - distance(b, token))
      .find((candidate) => normalizedToken(candidate.text) === normalizedToken(token.text))
    const chosen = ocrMatch ?? token
    return {
      page: chosen.page,
      rect: { left: chosen.left, top: chosen.top, width: chosen.width, height: chosen.height },
      text: chosen.text,
      method: chosen.method,
      confidence: chosen.confidence,
    }
  })
}

function evidenceToToken(item: Evidence): SourceToken {
  return {
    page: item.page,
    text: item.text,
    left: item.rect.left,
    top: item.rect.top,
    width: item.rect.width,
    height: item.rect.height,
    method: item.method,
    confidence: item.confidence,
  }
}

function parseNumber(value: string): number {
  return Number(value.replace(/[$,()\s]/g, ''))
}

function findHeaderX(line: VisualLine, aliases: string[]): number | null {
  const token = line.tokens.find((item) => aliases.some((alias) => normalizedToken(item.text).includes(normalizedToken(alias))))
  return token ? token.left + token.width / 2 : null
}

function nearestNumeric(tokens: SourceToken[], targetX: number | null, preferRight: boolean): SourceToken | undefined {
  const candidates = tokens.filter((token) => {
    const normalized = token.text.replace(/\s/g, '')
    return AMOUNT_RE.test(normalized) || NUMERIC_RE.test(normalized)
  })
  if (candidates.length === 0) return undefined
  if (targetX === null) return preferRight ? candidates[candidates.length - 1] : candidates[0]
  return candidates.sort((a, b) => {
    const aDistance = Math.abs(a.left + a.width / 2 - targetX)
    const bDistance = Math.abs(b.left + b.width / 2 - targetX)
    return aDistance - bDistance
  })[0]
}

function findTokensForText(tokens: SourceToken[], text: string): SourceToken[] {
  const target = normalizedToken(text)
  return tokens.filter((token) => normalizedToken(token.text) === target)
}

function distance(a: SourceToken, b: SourceToken): number {
  return Math.abs(a.left - b.left) + Math.abs(a.top - b.top)
}

function normalizedToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function compactText(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function looksLikeDate(value: string): boolean {
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value)
}
