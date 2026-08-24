// Client-side document text extraction for Paper Studio uploads.
// PDF via pdfjs-dist, .docx via mammoth, .txt directly. The extracted text is
// fed to the existing /uploads paste path (Qwen pulls title/authors/abstract/DOI
// from the front matter), so no server-side file handling is needed.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import mammoth from 'mammoth';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Front matter + early pages carry title/authors/abstract; no need to read a
// whole 40-page paper just to identify it.
const MAX_PDF_PAGES = 15;
const MAX_CHARS = 12000;

export interface ExtractedDoc {
  text: string;
  kind: 'pdf' | 'docx' | 'txt';
  pages?: number;
}

export async function extractDocText(file: File): Promise<ExtractedDoc> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.pdf')) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const limit = Math.min(pdf.numPages, MAX_PDF_PAGES);
    let text = '';
    for (let i = 1; i <= limit && text.length < MAX_CHARS; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => ('str' in it ? (it as { str: string }).str : '')).join(' ') + '\n';
    }
    text = text.trim();
    if (!text) throw new Error('No selectable text found — this looks like a scanned/image PDF. Try a different file or paste the title + abstract.');
    return { text: text.slice(0, MAX_CHARS), kind: 'pdf', pages: pdf.numPages };
  }

  if (name.endsWith('.docx')) {
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    const text = (value ?? '').trim();
    if (!text) throw new Error('Could not read any text from this Word file.');
    return { text: text.slice(0, MAX_CHARS), kind: 'docx' };
  }

  if (name.endsWith('.txt')) {
    const text = (await file.text()).trim();
    if (!text) throw new Error('The file is empty.');
    return { text: text.slice(0, MAX_CHARS), kind: 'txt' };
  }

  throw new Error('Unsupported file. Upload a PDF, .docx, or .txt (old .doc isn’t supported — re-save as .docx).');
}
