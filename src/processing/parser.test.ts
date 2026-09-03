import { describe, expect, it } from 'vitest'
import { parseDocument } from './parser'
import type { PageTextData, SourceToken } from '../types'

function makePage(rows: Array<Array<{ text: string; left?: number; width?: number }>>, native = true): PageTextData {
  const tokens: SourceToken[] = []
  rows.forEach((row, rowIndex) => row.forEach((item, itemIndex) => {
    tokens.push({
      page: 1,
      text: item.text,
      left: item.left ?? itemIndex * 0.08,
      top: 0.05 + rowIndex * 0.045,
      width: item.width ?? 0.06,
      height: 0.018,
      confidence: null,
      method: 'native',
    })
  }))
  const ocrTokens = tokens.map((token) => ({ ...token, method: 'ocr' as const, confidence: 94 }))
  return {
    page: 1,
    width: 612,
    height: 792,
    imageUrl: 'data:image/png;base64,fixture',
    nativeText: native ? tokens.map((token) => token.text).join(' ') : '',
    nativeTokens: native ? tokens : [],
    ocrTokens,
  }
}

describe('document parser', () => {
  it('extracts invoice fields, line items, extended values, and invoice total', () => {
    const page = makePage([
      [{ text: 'Shipper', left: 0.04 }],
      [{ text: 'Snap-on Logistic Company', left: 0.04 }],
      [{ text: '66-0411657', left: 0.04 }],
      [{ text: '3011 East IL Rt 176', left: 0.04 }],
      [{ text: 'Consignee', left: 0.04 }],
      [{ text: 'Central de Repuestos Hondureña S.A.', left: 0.04 }],
      [{ text: '12 CALLE, 4TA Y 5TA', left: 0.04 }],
      [{ text: 'Invoice number', left: 0.58 }, { text: '53527825', left: 0.78 }],
      [{ text: 'Line #', left: 0.04 }, { text: 'Description', left: 0.22 }, { text: 'HTSUS', left: 0.58 }, { text: 'Qty.', left: 0.73 }, { text: 'Extended price', left: 0.88 }],
      [{ text: '19', left: 0.04 }, { text: 'EEJP4001', left: 0.11 }, { text: '12/24 WHEELED HD ENGINE STARTER', left: 0.22, width: 0.3 }, { text: '8507600020', left: 0.58, width: 0.11 }, { text: '1.00', left: 0.73 }, { text: '564.00', left: 0.91 }],
      [{ text: '20', left: 0.04 }, { text: 'EEJP1224', left: 0.11 }, { text: '12/24V ENGINE STARTER', left: 0.22, width: 0.25 }, { text: '8507100090', left: 0.58, width: 0.11 }, { text: '2.00', left: 0.73 }, { text: '792.00', left: 0.91 }],
      [{ text: 'Invoice total', left: 0.73 }, { text: '1,496.00', left: 0.91 }],
    ])

    const result = parseDocument([page])

    expect(result.invoiceNumber.value).toBe('53527825')
    expect(result.shipperName.value).toBe('Snap-on Logistic Company')
    expect(result.consigneeName.value).toBe('Central de Repuestos Hondureña S.A.')
    expect(result.lineItems).toHaveLength(2)
    expect(result.lineItems[0].quantity.value).toBe(1)
    expect(result.lineItems[0].value.value).toBe(564)
    expect(result.lineItems[0].htsCode.value).toBe('8507600020')
    expect(result.lineItems[1].value.value).toBe(792)
    expect(result.totalValueOfGoods.value).toBe(1496)
    expect(result.totalValueOfGoods.confidence).toBe(94)
    expect(result.totalValueOfGoods.evidence[0].method).toBe('ocr')
  })

  it('uses B/L numbers and works with OCR-only pages', () => {
    const page = makePage([
      [{ text: 'B/L No.', left: 0.72 }, { text: '953074879', left: 0.84 }],
      [{ text: 'Shipper', left: 0.04 }],
      [{ text: 'TME', left: 0.04 }],
      [{ text: '40 DEVILS TOWER ROAD', left: 0.04 }],
      [{ text: 'Consignee', left: 0.04 }],
      [{ text: 'UNDP Tanzania', left: 0.04 }],
      [{ text: 'International House', left: 0.04 }],
    ], false)

    const result = parseDocument([page])

    expect(result.billOfLadingNumber.value).toBe('953074879')
    expect(result.billOfLadingNumber.confidence).toBe(94)
    expect(result.shipperName.value).toBe('TME')
    expect(result.consigneeName.value).toBe('UNDP Tanzania')
  })

  it('keeps absent values missing instead of fabricating them', () => {
    const page = makePage([
      [{ text: 'Invoice number', left: 0.6 }, { text: '53527825', left: 0.8 }],
      [{ text: 'Invoice total', left: 0.6 }],
    ])

    const result = parseDocument([page])

    expect(result.billOfLadingNumber.status).toBe('missing')
    expect(result.totalValueOfGoods.status).toBe('missing')
    expect(result.lineItems).toHaveLength(0)
  })
})
