import { useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, ReactNode } from 'react'
import { processBatch } from './processing/pdfPipeline'
import type { DocumentState, Evidence, ExtractedField, ExtractionResult, FieldStatus, LineItem } from './types'
import './styles.css'

type Step = 'upload' | 'processing' | 'review'

const SAMPLE_FILES = [
  { name: 'document1.pdf', label: 'Maersk bill of lading', path: '/samples/document1.pdf' },
  { name: 'document2.pdf', label: 'Crowley bill of lading', path: '/samples/document2.pdf' },
  { name: 'document5.pdf', label: 'Snap-on commercial invoice', path: '/samples/document5.pdf' },
  { name: 'document6.pdf', label: 'Brother commercial invoice', path: '/samples/document6.pdf' },
]

const FIELD_LABELS: Record<string, string> = {
  billOfLadingNumber: 'Bill of lading number',
  invoiceNumber: 'Invoice number',
  shipperName: 'Shipper name',
  shipperAddress: 'Shipper address',
  consigneeName: 'Consignee name',
  consigneeAddress: 'Consignee address',
  totalValueOfGoods: 'Total value of goods',
}

function App() {
  const [step, setStep] = useState<Step>('upload')
  const [documents, setDocuments] = useState<DocumentState[]>([])
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [activeField, setActiveField] = useState<string | null>(null)
  const [activePage, setActivePage] = useState(1)
  const [showAllHighlights, setShowAllHighlights] = useState(true)
  const [dragActive, setDragActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? documents.find((document) => document.status === 'complete')
  const activeResult = activeDocument?.result

  const addFiles = (files: File[]) => {
    const pdfs = files.filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length === 0) return
    const next = pdfs.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      name: file.name,
      size: file.size,
      status: 'queued' as const,
      progress: 0,
      progressLabel: 'Ready to process',
    }))
    setDocuments((current) => [...current, ...next])
    if (!activeDocumentId) setActiveDocumentId(next[0].id)
  }

  const loadSample = async (path: string, name: string) => {
    const response = await fetch(path)
    const blob = await response.blob()
    addFiles([new File([blob], name, { type: 'application/pdf' })])
  }

  const startProcessing = async () => {
    const queued = documents.filter((document) => document.status === 'queued')
    if (queued.length === 0) return
    setStep('processing')
    setDocuments((current) => current.map((document) => queued.some((item) => item.id === document.id) ? { ...document, status: 'processing', progressLabel: 'Starting' } : document))
    try {
      const results = await processBatch(queued, (update) => {
        setDocuments((current) => current.map((document) => document.id === update.documentId ? {
          ...document,
          status: 'processing',
          progress: Math.max(0, Math.min(100, update.progress)),
          progressLabel: update.page && update.totalPages ? `${update.label} · page ${update.page}/${update.totalPages}` : update.label,
        } : document))
      })
      setDocuments((current) => current.map((document) => {
        const result = results.get(document.id)
        return result ? { ...document, status: 'complete', progress: 100, progressLabel: 'Ready for review', result } : document
      }))
      const firstResult = queued.find((document) => results.has(document.id))
      if (firstResult) setActiveDocumentId(firstResult.id)
      setStep('review')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Processing failed'
      setDocuments((current) => current.map((document) => document.status === 'processing' ? { ...document, status: 'error', progressLabel: 'Could not process', error: message } : document))
      setStep('upload')
    }
  }

  const removeDocument = (id: string) => {
    setDocuments((current) => current.filter((document) => document.id !== id))
    if (activeDocumentId === id) setActiveDocumentId(null)
  }

  const selectField = (key: string, evidence: Evidence[]) => {
    setActiveField(key)
    if (evidence[0]) setActivePage(evidence[0].page)
  }

  const updateField = (key: string, value: string) => {
    if (!activeDocument?.result) return
    setDocuments((current) => current.map((document) => {
      if (document.id !== activeDocument.id || !document.result) return document
      const result = { ...document.result }
      const currentField = result[key as keyof ExtractionResult]
      if (!isExtractedField(currentField)) return document
      const numeric = key === 'totalValueOfGoods'
      const parsedValue = numeric ? parseEditableNumber(value) : value
      ;(result as unknown as Record<string, unknown>)[key] = {
        ...currentField,
        value: parsedValue,
        status: 'manual' as FieldStatus,
        rawText: value,
      }
      return { ...document, result }
    }))
  }

  const updateLineItem = (index: number, key: keyof LineItem, value: string) => {
    if (!activeDocument?.result) return
    setDocuments((current) => current.map((document) => {
      if (document.id !== activeDocument.id || !document.result) return document
      const result = { ...document.result, lineItems: [...document.result.lineItems] }
      const item = { ...result.lineItems[index] }
      const currentField = item[key]
      const numeric = key === 'quantity' || key === 'value'
      item[key] = {
        ...currentField,
        value: numeric ? parseEditableNumber(value) : value,
        status: 'manual',
        rawText: value,
      } as never
      result.lineItems[index] = item
      return { ...document, result }
    }))
  }

  const content = step === 'upload'
    ? <UploadStep documents={documents} onAddFiles={addFiles} onDrop={addFiles} onRemove={removeDocument} onProcess={startProcessing} onLoadSample={loadSample} inputRef={inputRef} dragActive={dragActive} setDragActive={setDragActive} />
    : step === 'processing'
      ? <ProcessingStep documents={documents} />
      : <ReviewStep
        documents={documents}
        activeDocument={activeDocument}
        activePage={activePage}
        setActivePage={setActivePage}
        activeField={activeField}
        selectField={selectField}
        showAllHighlights={showAllHighlights}
        setShowAllHighlights={setShowAllHighlights}
        updateField={updateField}
        updateLineItem={updateLineItem}
        onBack={() => setStep('upload')}
        onSelectDocument={(id) => { setActiveDocumentId(id); setActiveField(null); setActivePage(1) }}
      />

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-lockup"><span className="brand-mark">R</span><span>reform</span></div>
      <div className="topbar-context"><span className="context-dot" /> Document intelligence <span className="slash">/</span> Operations</div>
      <div className="topbar-user"><span className="avatar">MC</span><span>Ops workspace</span><span className="chevron">⌄</span></div>
    </header>
    <main className="page-content">
      <div className="stepper" aria-label="Workflow progress">
        {(['upload', 'processing', 'review'] as Step[]).map((item, index) => <div className={`step ${step === item ? 'active' : index < ['upload', 'processing', 'review'].indexOf(step) ? 'done' : ''}`} key={item}>
          <span className="step-number">{index < ['upload', 'processing', 'review'].indexOf(step) ? '✓' : index + 1}</span>
          <span>{item === 'upload' ? 'Upload' : item === 'processing' ? 'Processing' : 'Review'}</span>
          {index < 2 && <span className="step-line" />}
        </div>)}
      </div>
      {content}
    </main>
  </div>
}

function UploadStep(props: {
  documents: DocumentState[]
  onAddFiles: (files: File[]) => void
  onDrop: (files: File[]) => void
  onRemove: (id: string) => void
  onProcess: () => void
  onLoadSample: (path: string, name: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  dragActive: boolean
  setDragActive: (value: boolean) => void
}) {
  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    props.onAddFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }
  const onDragOver = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); props.setDragActive(true) }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); props.setDragActive(false) }
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); props.setDragActive(false); props.onDrop(Array.from(event.dataTransfer.files)) }
  const queuedCount = props.documents.filter((document) => document.status === 'queued').length

  return <section className="upload-section">
    <div className="hero-copy">
      <div className="eyebrow">INBOUND DOCUMENTS</div>
      <h1>Turn paperwork into<br /><em>actionable data.</em></h1>
      <p>Upload bills of lading and commercial invoices. Reform will find the details your operations team needs and show you exactly where they came from.</p>
    </div>
    <div className={`dropzone ${props.dragActive ? 'dragging' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={() => props.inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') props.inputRef.current?.click() }}>
      <input ref={props.inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onInput} />
      <div className="upload-icon"><span>↑</span></div>
      <h2>Drop your PDFs here</h2>
      <p>or <span className="link-text">browse files</span> from your computer</p>
      <span className="file-note">PDF files only · Multiple files supported</span>
    </div>
    <div className="sample-row">
      <span className="sample-label">TRY A SAMPLE</span>
      {SAMPLE_FILES.map((sample) => <button className="sample-chip" key={sample.name} onClick={(event) => { event.stopPropagation(); props.onLoadSample(sample.path, sample.name) }}><span className="pdf-glyph">PDF</span>{sample.label}<span className="plus">+</span></button>)}
    </div>
    {props.documents.length > 0 && <div className="queue-card">
      <div className="queue-header"><div><span className="section-kicker">READY TO PROCESS</span><h3>{props.documents.length} document{props.documents.length === 1 ? '' : 's'}</h3></div><span className="queue-count">{queuedCount} queued</span></div>
      <div className="queue-list">{props.documents.map((document) => <DocumentRow document={document} onRemove={props.onRemove} key={document.id} />)}</div>
      <button className="primary-button process-button" disabled={queuedCount === 0} onClick={props.onProcess}>Process {queuedCount || 'documents'} <span>→</span></button>
    </div>}
    <div className="privacy-note"><span className="lock">⌑</span> Your documents stay in this browser. Nothing is uploaded to a server.</div>
  </section>
}

function ProcessingStep({ documents }: { documents: DocumentState[] }) {
  const processing = documents.filter((document) => document.status === 'processing' || document.status === 'complete')
  return <section className="processing-section">
    <div className="processing-heading"><div className="eyebrow">STEP 02 · PROCESSING</div><h1>Reading your documents<span className="animated-dots">...</span></h1><p>Reform is looking for the fields that matter to your operations team.</p></div>
    <div className="processing-grid">
      <div className="progress-card">{documents.map((document) => <div className="progress-row" key={document.id}><div className="progress-file"><span className="file-icon">PDF</span><div><strong>{document.name}</strong><span>{document.progressLabel}</span></div></div><div className="progress-value">{document.status === 'complete' ? 'Done' : `${document.progress}%`}</div><div className="progress-track"><span style={{ width: `${document.progress}%` }} /></div></div>)}</div>
      <div className="looking-card"><span className="section-kicker">EXTRACTING</span><h3>The details that<br /><em>keep freight moving.</em></h3><div className="looking-list">{['Bill of lading & invoice numbers', 'Shipper & consignee details', 'Line items, HTS codes & values', 'Total value of goods'].map((item) => <div key={item}><span className="checkmark">✓</span>{item}</div>)}</div></div>
    </div>
    <div className="ocr-footnote"><span className="spark">✦</span> OCR runs locally in a background worker. Coordinates and scores are kept with every extracted value.</div>
    <span className="sr-only">{processing.length} documents are being processed</span>
  </section>
}

function ReviewStep(props: {
  documents: DocumentState[]
  activeDocument?: DocumentState
  activePage: number
  setActivePage: (page: number) => void
  activeField: string | null
  selectField: (key: string, evidence: Evidence[]) => void
  showAllHighlights: boolean
  setShowAllHighlights: (value: boolean) => void
  updateField: (key: string, value: string) => void
  updateLineItem: (index: number, key: keyof LineItem, value: string) => void
  onBack: () => void
  onSelectDocument: (id: string) => void
}) {
  const result = props.activeDocument?.result
  const page = result?.pages[props.activePage - 1]
  const highlights = useMemo(() => {
    if (!result) return []
    if (!props.showAllHighlights && props.activeField) return evidenceForKey(result, props.activeField)
    return allEvidence(result)
  }, [result, props.showAllHighlights, props.activeField])

  return <section className="review-section">
    <div className="review-toolbar"><div><div className="eyebrow">STEP 03 · DOCUMENT REVIEW</div><h1>Review extracted data</h1></div><button className="secondary-button" onClick={props.onBack}>← Add more documents</button></div>
    <div className="review-layout">
      <aside className="document-sidebar"><div className="sidebar-heading"><span className="section-kicker">DOCUMENTS</span><span className="document-total">{props.documents.length}</span></div>{props.documents.map((document) => <button className={`document-tab ${document.id === props.activeDocument?.id ? 'selected' : ''}`} key={document.id} onClick={() => props.onSelectDocument(document.id)}><span className="mini-pdf">PDF</span><span className="document-tab-copy"><strong>{document.name}</strong><small>{document.result?.pages.length ?? 0} pages · {document.status === 'complete' ? 'Processed' : document.status}</small></span><span className="tab-status">{document.status === 'complete' ? '✓' : '!'}</span></button>)}</aside>
      <div className="viewer-panel"><div className="viewer-header"><div><strong>{props.activeDocument?.name ?? 'No document selected'}</strong><span>{result?.pages.length ?? 0} pages · OCR complete</span></div><button className={`highlight-toggle ${props.showAllHighlights ? 'on' : ''}`} onClick={() => props.setShowAllHighlights(!props.showAllHighlights)}><span className="toggle-dot" /> {props.showAllHighlights ? 'All highlights' : 'Selected highlight'}</button></div>{page ? <div className="pdf-stage"><div className="pdf-page-wrap"><img src={page.imageUrl} alt={`Page ${page.page} of ${props.activeDocument?.name}`} /><div className="highlight-layer">{highlights.filter((item) => item.page === page.page).map((item, index) => <button className={`pdf-highlight ${item.key === props.activeField ? 'focused' : ''}`} style={{ left: `${item.rect.left * 100}%`, top: `${item.rect.top * 100}%`, width: `${item.rect.width * 100}%`, height: `${Math.max(item.rect.height * 100, 1.2)}%` }} title={item.label} key={`${item.key}-${index}`} onClick={() => props.selectField(item.key, [item])} />)}</div></div></div> : <div className="empty-viewer">Upload a PDF to preview it here.</div>}<div className="viewer-footer"><button disabled={props.activePage <= 1} onClick={() => props.setActivePage(Math.max(1, props.activePage - 1))}>←</button><span>Page {props.activePage} of {result?.pages.length ?? 0}</span><button disabled={props.activePage >= (result?.pages.length ?? 1)} onClick={() => props.setActivePage(Math.min(result?.pages.length ?? 1, props.activePage + 1))}>→</button><span className="zoom-label">100%</span></div></div>
      <aside className="extraction-panel"><div className="panel-heading"><div><span className="section-kicker">EXTRACTED FIELDS</span><h2>Document data</h2></div><span className="score-legend"><span className="legend-dot" /> OCR score</span></div>{result ? <div className="fields-scroll"><FieldSection title="Identifiers"><EditableField fieldKey="billOfLadingNumber" field={result.billOfLadingNumber} activeField={props.activeField} onSelect={props.selectField} onChange={props.updateField} /><EditableField fieldKey="invoiceNumber" field={result.invoiceNumber} activeField={props.activeField} onSelect={props.selectField} onChange={props.updateField} /></FieldSection><FieldSection title="Parties"><EditableField fieldKey="shipperName" field={result.shipperName} activeField={props.activeField} onSelect={props.selectField} onChange={props.updateField} /><EditableField fieldKey="shipperAddress" field={result.shipperAddress} activeField={props.activeField} onSelect={props.selectField} onChange={props.updateField} multiline /><EditableField fieldKey="consigneeName" field={result.consigneeName} activeField={props.activeField} onSelect={props.selectField} onChange={props.updateField} /><EditableField fieldKey="consigneeAddress" field={result.consigneeAddress} activeField={props.activeField} onSelect={props.selectField} onChange={props.updateField} multiline /></FieldSection><FieldSection title="Line items"><LineItemsTable items={result.lineItems} onSelect={(key, evidence) => props.selectField(key, evidence)} onChange={props.updateLineItem} /></FieldSection><FieldSection title="Value"><EditableField fieldKey="totalValueOfGoods" field={result.totalValueOfGoods} activeField={props.activeField} onSelect={props.selectField} onChange={props.updateField} numeric /></FieldSection></div> : <div className="empty-fields">No extracted data yet.</div>}</aside>
    </div>
  </section>
}

function DocumentRow({ document, onRemove }: { document: DocumentState; onRemove: (id: string) => void }) {
  return <div className="queue-row"><span className="file-icon">PDF</span><div className="queue-file"><strong>{document.name}</strong><span>{formatBytes(document.size)} · {document.status === 'error' ? document.error : document.progressLabel}</span></div><span className={`status-dot ${document.status}`} />{document.status === 'queued' && <button className="icon-button" onClick={() => onRemove(document.id)} aria-label={`Remove ${document.name}`}>×</button>}</div>
}

function FieldSection({ title, children }: { title: string; children: ReactNode }) {
  return <div className="field-section"><div className="field-section-title">{title}</div>{children}</div>
}

function EditableField<T>({ fieldKey, field, activeField, onSelect, onChange, multiline = false, numeric = false }: { fieldKey: string; field: ExtractedField<T>; activeField: string | null; onSelect: (key: string, evidence: Evidence[]) => void; onChange: (key: string, value: string) => void; multiline?: boolean; numeric?: boolean }) {
  const display = field.value === null ? '' : typeof field.value === 'number' ? field.value.toLocaleString('en-US', { minimumFractionDigits: fieldKey === 'totalValueOfGoods' ? 2 : 0 }) : String(field.value)
  return <div className={`field-card ${activeField === fieldKey ? 'active' : ''} ${field.status === 'missing' ? 'missing' : ''}`} onClick={() => onSelect(fieldKey, field.evidence)}><div className="field-card-top"><label htmlFor={fieldKey}>{FIELD_LABELS[fieldKey]}</label><Confidence field={field} /></div>{multiline ? <textarea id={fieldKey} value={display} placeholder="Not found in document" onChange={(event) => onChange(fieldKey, event.target.value)} onClick={(event) => event.stopPropagation()} rows={2} /> : <input id={fieldKey} type={numeric ? 'text' : 'text'} value={display} placeholder="Not found in document" onChange={(event) => onChange(fieldKey, event.target.value)} onClick={(event) => event.stopPropagation()} />}{field.status === 'missing' && <span className="missing-note">Not found in the document</span>}</div>
}

function LineItemsTable({ items, onSelect, onChange }: { items: LineItem[]; onSelect: (key: string, evidence: Evidence[]) => void; onChange: (index: number, key: keyof LineItem, value: string) => void }) {
  if (items.length === 0) return <div className="line-items-empty">No line items found in this document.</div>
  return <div className="line-items-table"><div className="line-item-head"><span>Qty</span><span>Description</span><span>HTS</span><span>Value</span></div>{items.map((item, index) => <div className="line-item-row" key={index}><LineItemInput item={item} itemIndex={index} fieldKey="quantity" onSelect={onSelect} onChange={onChange} /><LineItemInput item={item} itemIndex={index} fieldKey="description" onSelect={onSelect} onChange={onChange} /><LineItemInput item={item} itemIndex={index} fieldKey="htsCode" onSelect={onSelect} onChange={onChange} /><LineItemInput item={item} itemIndex={index} fieldKey="value" onSelect={onSelect} onChange={onChange} /></div>)}</div>
}

function LineItemInput({ item, itemIndex, fieldKey, onSelect, onChange }: { item: LineItem; itemIndex: number; fieldKey: keyof LineItem; onSelect: (key: string, evidence: Evidence[]) => void; onChange: (index: number, key: keyof LineItem, value: string) => void }) {
  const field = item[fieldKey] as ExtractedField<string | number>
  const key = `lineItems.${itemIndex}.${fieldKey}`
  const display = field.value === null ? '' : String(field.value)
  return <div className={`line-item-input ${field.status === 'missing' ? 'missing' : ''}`} onClick={() => onSelect(key, field.evidence)}><input value={display} placeholder="—" onChange={(event) => onChange(itemIndex, fieldKey, event.target.value)} onClick={(event) => event.stopPropagation()} /></div>
}

function Confidence<T>({ field }: { field: ExtractedField<T> }) {
  const label = field.confidence === null ? 'No score' : `${field.confidence}%`
  return <span className={`confidence ${field.status}`}><span className="confidence-dot" />{label}</span>
}

function evidenceForKey(result: ExtractionResult, key: string): Array<Evidence & { key: string; label: string }> {
  const field = getField(result, key)
  return field ? field.evidence.map((evidence) => ({ ...evidence, key, label: FIELD_LABELS[key] ?? key })) : []
}

function allEvidence(result: ExtractionResult): Array<Evidence & { key: string; label: string }> {
  const keys = Object.keys(FIELD_LABELS)
  const fields = keys.flatMap((key) => evidenceForKey(result, key))
  result.lineItems.forEach((item, index) => {
    ;(['quantity', 'description', 'htsCode', 'value'] as (keyof LineItem)[]).forEach((key) => {
      fields.push(...item[key].evidence.map((evidence) => ({ ...evidence, key: `lineItems.${index}.${key}`, label: `${key} · line ${index + 1}` })))
    })
  })
  return fields
}

function getField(result: ExtractionResult, key: string): ExtractedField<unknown> | null {
  const lineMatch = key.match(/^lineItems\.(\d+)\.(quantity|description|value|htsCode)$/)
  if (lineMatch) {
    const item = result.lineItems[Number(lineMatch[1])]
    const itemField = item?.[lineMatch[2] as keyof LineItem]
    return isExtractedField(itemField) ? itemField : null
  }
  const value = result[key as keyof ExtractionResult]
  return isExtractedField(value) ? value : null
}

function isExtractedField(value: unknown): value is ExtractedField<unknown> {
  return Boolean(value && typeof value === 'object' && 'status' in value && 'evidence' in value)
}

function parseEditableNumber(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value.replace(/[$,\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default App
