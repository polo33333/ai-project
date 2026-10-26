'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');

const clean = value => String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const decode = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function wordPageInfo(buffer) {
  // Word stores the last saved page count, which can differ after layout changes.
  const archive = XLSX.CFB.read(buffer, { type: 'buffer' });
  const entry = XLSX.CFB.find(archive, '/docProps/app.xml');
  const xml = entry?.content ? Buffer.from(entry.content).toString('utf8') : '';
  const count = Number(xml.match(/<(?:\w+:)?Pages\b[^>]*>\s*(\d+)\s*<\//i)?.[1]);
  return Number.isInteger(count) && count > 0 ? { pageCount: count, pageCountSource: 'word_saved_metadata' } : null;
}

function sections(text) {
  const result = [];
  let section = null, lines = [];
  const push = () => { if (clean(lines.join('\n'))) result.push({ text: clean(lines.join('\n')), section }); lines = []; };
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s+\S|^(?:Điều|Chương|Mục)\s+\d+[.:\s]/iu.test(line)) {
      push(); section = line.replace(/^#+\s*/, '').trim();
    }
    lines.push(line);
  }
  push();
  return result;
}

async function extract(buffer, fileType) {
  const type = String(fileType).toUpperCase();
  if (type === 'PDF') {
    const pages = [];
    const parsed = await pdfParse(buffer, { pagerender: async page => {
      const content = await page.getTextContent();
      let lastY = null, lastEnd = null, text = '';
      for (const item of content.items) {
        const [a, b, , , x, y] = item.transform;
        // Fonts split Vietnamese words around accented glyphs ("Tài li" + "ệ" + "u");
        // pieces that touch on the same line belong to one word.
        const touching = lastY === y && lastEnd !== null && x - lastEnd < 0.15 * (Math.hypot(a, b) || 10);
        text += (lastY === null ? '' : lastY !== y ? '\n' : touching ? '' : ' ') + item.str;
        lastY = y; lastEnd = x + (item.width || 0);
      }
      pages.push({ page: page.pageNumber, text: clean(text) });
      return text;
    } });
    if (pages.length !== parsed.numpages) throw new Error('PDF_PAGE_EXTRACTION_INCOMPLETE');
    return pages.sort((a, b) => a.page - b.page).flatMap(page => {
      const parts = sections(page.text);
      return (parts.length ? parts : [{ text: '', section: null }]).map(part => ({ ...part, page: page.page }));
    });
  }
  if (['XLSX', 'XLS'].includes(type)) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    return workbook.SheetNames.map(sheet => {
      const worksheet = workbook.Sheets[sheet];
      return { sheet, rowOffset: worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']).s.r : 0,
        rows: XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: true, raw: false }) };
    });
  }
  if (type === 'CSV') return [{ rows: parse(buffer.toString('utf8'), { relax_column_count: true, skip_empty_lines: false }) }];
  if (type === 'DOCX') {
    const { value } = await mammoth.convertToHtml({ buffer });
    const tables = [];
    const html = value.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, table => {
      const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
        [...row[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
          .map(cell => clean(decode(cell[1].replace(/<[^>]+>/g, ' ')))));
      tables.push(rows);
      return `\n\n@@TABLE_${tables.length - 1}@@\n\n`;
    });
    // Preserve headings and table rows before removing presentation markup.
    const text = decode(html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, title) => `\n\n${'#'.repeat(Number(level))} ${title}\n`)
      .replace(/<\/(?:td|th)>\s*<(?:td|th)[^>]*>/gi, ' | ')
      .replace(/<\/(?:p|tr|table|li)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    let section = null;
    return clean(text).split(/(@@TABLE_\d+@@)/).flatMap(fragment => {
      const table = fragment.match(/^@@TABLE_(\d+)@@$/);
      if (table) return [{ rows: tables[Number(table[1])], section }];
      const parts = sections(clean(fragment));
      for (const part of parts) { part.section ||= section; section = part.section; }
      return parts;
    });
  }
  if (['TXT', 'MD', 'SQL'].includes(type)) return sections(clean(buffer.toString('utf8')));
  throw new Error(`Định dạng ${type} chưa được hỗ trợ.`);
}

function chunks(parts, split, maxChars = 2200) {
  const result = [];
  parts.forEach((part, parentIndex) => {
    const locator = { page: part.page || null, sheet: part.sheet || null, section: part.section || null, parentIndex };
    if (!part.rows) {
      const prefix = part.section ? `${part.section}\n` : '';
      split(part.text, Math.max(128, maxChars - prefix.length)).forEach(text =>
        result.push({ text: prefix && !text.startsWith(part.section) ? prefix + text : text, ...locator }));
      return;
    }
    const headerIndex = part.rows.findIndex(row => row.some(cell => String(cell).trim()));
    if (headerIndex < 0) return;
    const header = part.rows[headerIndex].join(' | ');
    const prefix = `${part.sheet ? `# Sheet: ${part.sheet}\n` : ''}${part.section ? `${part.section}\n` : ''}${header}\n`;
    let body = '', rowStart = null, rowEnd = null;
    const push = () => { if (body) result.push({ text: prefix + body, ...locator, rowStart, rowEnd, tableHeader: header }); body = ''; rowStart = null; };
    part.rows.slice(headerIndex + 1).forEach((row, index) => {
      const rowNumber = (part.rowOffset || 0) + headerIndex + index + 2;
      const line = row.join(' | ');
      if (!line.replace(/[|\s]/g, '')) return;
      if (body && prefix.length + body.length + line.length + 1 > maxChars) push();
      if (prefix.length + line.length > maxChars) {
        push();
        split(line, Math.max(128, maxChars - prefix.length), 0).forEach(text => result.push({ text: prefix + text, ...locator, rowStart: rowNumber, rowEnd: rowNumber, tableHeader: header }));
      } else { rowStart ??= rowNumber; rowEnd = rowNumber; body += `${body ? '\n' : ''}${line}`; }
    });
    push();
    if (!result.some(chunk => chunk.parentIndex === parentIndex)) result.push({ text: prefix.trim(), ...locator, tableHeader: header });
  });
  // A heading with no body of its own ("3. Chuẩn bị hạ tầng" before "3.1 …") is read with what follows it.
  const key = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const merged = [];
  result.forEach((chunk, index) => {
    const next = result[index + 1];
    const body = chunk.text.split('\n').filter(line => !/^\s*#{1,6}\s/.test(line) && key(line) !== key(chunk.section)).join('');
    if (!chunk.rowStart && !chunk.tableHeader && key(body).length < 20 && next && (next.page || null) === (chunk.page || null)
      && chunk.text.length + next.text.length < maxChars) {
      next.text = `${chunk.text}\n${next.text}`;
      return;
    }
    merged.push(chunk);
  });
  return merged.map((chunk, chunkIndex) => ({ ...chunk, chunkIndex }));
}

module.exports = { extract, chunks, sections, wordPageInfo };
