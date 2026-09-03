# Reform Document Portal

Browser-local document review for bills of lading and commercial invoices.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL, choose a PDF or a bundled sample, and select **Process**. The app renders every page with PDF.js, extracts native PDF text, runs Tesseract.js OCR in one persistent worker, and parses the requested fields with source evidence and OCR confidence.

## Architecture

- `src/processing/pdfPipeline.ts` loads and renders PDFs, manages the documented Tesseract.js worker lifecycle, parses TSV coordinates, and emits page evidence.
- `src/processing/parser.ts` performs deterministic label/table parsing. It does not infer missing values; it marks them missing or needing review.
- `src/App.tsx` provides upload, processing, and document review flows, including editable fields and PDF evidence highlights.
- `public/tesseract/` contains the pinned worker, core variants, and English traineddata required for local OCR.
- `public/samples/` contains the four supplied PDF fixtures.

## Verification

```bash
npm test
npm run build
```

The UI is browser-only and does not upload document data to a server. OCR asset loading requires the app to be served over HTTP; opening `index.html` directly is not supported.
