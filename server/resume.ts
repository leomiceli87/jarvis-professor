import { unzipSync, strFromU8 } from 'fflate';

export const RESUME_MAX_BYTES = 3_000_000;

/** Texto de um currículo em PDF, DOCX, TXT ou Markdown. Só texto: nada do arquivo sai da máquina além do texto, para o professor. */
export async function extractResumeText(data: Buffer, filename: string, contentType = ''): Promise<string> {
  if (data.length === 0) throw new Error('Arquivo vazio');
  if (data.length > RESUME_MAX_BYTES) throw new Error('Currículo grande demais (limite de 3 MB)');
  const ext = (filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '').trim();
  const isPdf = ext === 'pdf' || /pdf/.test(contentType) || data.subarray(0, 5).toString('latin1') === '%PDF-';
  const isDocx = ext === 'docx' || /officedocument\.wordprocessingml/.test(contentType) || (data[0] === 0x50 && data[1] === 0x4b && ext !== 'zip');
  let text: string;
  if (isPdf) text = await pdfText(data);
  else if (isDocx) text = docxText(data);
  else if (!ext || ['txt', 'md', 'markdown', 'text', 'rtf'].includes(ext) || /^text\//.test(contentType)) text = data.toString('utf8');
  else throw new Error(`Formato .${ext} não suportado. Envie PDF, DOCX, TXT ou Markdown.`);
  text = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/\s+/g, '').length < 80) throw new Error('Não achei texto no currículo. Se for um PDF escaneado (imagem), exporte de novo como PDF com texto, ou envie em DOCX ou TXT.');
  return text.slice(0, 60_000);
}

async function pdfText(data: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = ''; let out = '';
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      line += item.str;
      if (item.hasEOL) { out += line + '\n'; line = ''; } else if (item.str && !item.str.endsWith(' ')) line += ' ';
    }
    pages.push((out + line).trim());
  }
  await task.destroy();
  return pages.join('\n\n');
}

function docxText(data: Buffer): string {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(new Uint8Array(data)); } catch { throw new Error('Não consegui abrir o DOCX'); }
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('DOCX sem o documento principal');
  return strFromU8(xml)
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
