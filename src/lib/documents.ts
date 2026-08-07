/** Client-side document text extraction (PDF / DOCX / TXT) + section-aware chunking. */

export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " "),
      );
    }
    await doc.cleanup();
    return pages.join("\n\n");
  }
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth/mammoth.browser.js");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  return file.text();
}

export function cleanText(raw: string): string {
  return raw
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SECTION_PATTERNS: { type: string; re: RegExp }[] = [
  { type: "summary", re: /^(professional\s+)?(summary|profile|objective|about)\b/i },
  { type: "skills", re: /^(technical\s+)?(skills|technologies|tech stack|competencies)\b/i },
  { type: "experience", re: /^(work\s+|professional\s+)?(experience|employment|career history)\b/i },
  { type: "projects", re: /^(projects|selected projects|side projects)\b/i },
  { type: "education", re: /^education\b/i },
  { type: "certifications", re: /^(certifications?|licenses?)\b/i },
  { type: "achievements", re: /^(achievements|awards|honors)\b/i },
];

export type Chunk = { content: string; chunk_type: string; chunk_index: number };

export function chunkDocument(text: string): Chunk[] {
  const lines = text.split("\n");
  const sections: { type: string; lines: string[] }[] = [{ type: "general", lines: [] }];

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.length <= 60 ? SECTION_PATTERNS.find((p) => p.re.test(trimmed)) : undefined;
    if (match) {
      sections.push({ type: match.type, lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }

  const chunks: Chunk[] = [];
  let index = 0;
  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    if (!body) continue;
    // Split long sections on paragraph boundaries, ~900 chars per chunk.
    const paragraphs = body.split(/\n\s*\n/);
    let buffer = "";
    const flush = () => {
      if (!buffer.trim()) return;
      chunks.push({ content: buffer.trim().slice(0, 2000), chunk_type: section.type, chunk_index: index++ });
      buffer = "";
    };
    for (const paragraph of paragraphs) {
      if ((buffer + paragraph).length > 900) flush();
      buffer += (buffer ? "\n\n" : "") + paragraph;
    }
    flush();
  }
  return chunks.length ? chunks : [{ content: text.slice(0, 2000), chunk_type: "general", chunk_index: 0 }];
}
