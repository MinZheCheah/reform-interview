import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./processing/pdfPipeline', () => ({
  processBatch: vi.fn(),
}))

import App from './App'

describe('portal upload flow', () => {
  it('accepts a PDF and places it in the processing queue', () => {
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['%PDF-fixture'], 'invoice.pdf', { type: 'application/pdf' })

    fireEvent.change(input, { target: { files: [file] } })

    expect(screen.getByText('invoice.pdf')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /process 1/i })).toBeEnabled()
  })
})
