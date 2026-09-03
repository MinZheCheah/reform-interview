# Reform Document Portal

Browser-local document review for bills of lading and commercial invoices.

## Requirements

- Node.js 20 or newer
- npm 10 or newer

A modern browser with Web Worker and Canvas support
## Run locally

```bash
git clone <repository-url>
cd reform-document-portal
npm install
npm run dev
```
## Verification

```bash
npm test
npm run build
```

Open the local Vite URL, choose a PDF or a bundled sample, and select **Process**. The app renders every page with PDF.js, extracts native PDF text, runs Tesseract.js OCR in one persistent worker, and parses the requested fields with source evidence and OCR confidence.

## Design

### Structure

```text
src/
├── components/       Upload, processing, review, fields, and PDF viewer UI
├── extraction/       PDF rendering, OCR, token grouping, and deterministic parsing
├── models/            TypeScript types for fields, evidence, line items, and results
├── state/             Document queue and review state
└── workers/           Tesseract.js worker entrypoint
public/
└── samples/           Bundled PDF fixtures
```

### Key design decisions

- Use Browser-local processing that keeps customer documents on the operator’s device and avoids a server, account system, storage layer, or API key for the first version.
- OCR on every page gives every extracted field a consistent Tesseract confidence score and supports scanned documents.
- Deterministic parsing makes extraction behavior inspectable. The parser uses labeled regions and table headers, and it does not fill missing values from nearby unrelated numbers.
- Field-level provenance makes results reviewable. Each value keeps page, rectangle, source text, method, and OCR confidence.
- Split-panel review that keeps the source document and extracted data visible together, reducing context switching during verification, easy flow for intended users.

## Assumptions

- Input files are PDFs, and the browser can render their pages to canvas images.
- The first release targets English-language freight documents and uses Tesseract’s English trained data.
- Documents expose recognizable labels or table headers for the requested fields. Unclear or conflicting candidates are shown for review.
- Missing values remain missing. The application does not infer invoice numbers, HTS codes, totals, parties, or line-item values.
- `total value of goods` follows the invoice-total rule described above.
- Sample files are supplied as local fixtures and are selectable from the upload screen.

## Improvements
- I would add authentication and access control.
- Add a LLM paring approach as a feature instead of deterministic apporach if there are no proper documents, many missing fields, no proper schema.
- Support document templates, rotations, and difficult table layouts.
- Add cancellation, retry, and concurrency controls for large multi-file uploads.
- Input files and extracted data can be stored in a PostgreSQL database.
- Improve parsing with configurable document schemas.

