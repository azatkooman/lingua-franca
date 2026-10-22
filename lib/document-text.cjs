// Text from the files a church already has for a service: PowerPoint slides (with speaker
// notes), Word documents and plain text. The text goes into the translator's notes, where the
// operator can read and edit it before it is used. Pure Node, no dependencies, unit tested.
//
// .pptx and .docx are zip files of XML. Only the parts holding text are read, each inflated
// with a size cap, so a deck full of photos costs nothing beyond its upload.

const zlib = require('node:zlib');

const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

class DocumentError extends Error {}

/** The entries of a zip archive, by name, each with a function returning its bytes. */
function readZip(buffer) {
    // The end-of-central-directory record sits in the last 22 bytes plus any comment (<64 KB).
    const floor = Math.max(0, buffer.length - 22 - 0xffff);
    let end = -1;
    for (let index = buffer.length - 22; index >= floor; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
    }
    if (end < 0) throw new DocumentError('This file is not a PowerPoint or Word document.');
    const count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    if (count === 0xffff || offset === 0xffffffff) throw new DocumentError('This file is too large to read.');
    const entries = new Map();
    for (let index = 0; index < count; index += 1) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new DocumentError('This file is damaged.');
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        entries.set(name, () => {
            if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new DocumentError('This file is damaged.');
            const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
            const data = buffer.subarray(start, start + compressedSize);
            if (method === 0) return data;
            if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
            throw new DocumentError('This file uses a compression the app cannot read.');
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity) => {
    if (entity[0] === '#') {
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
});

/**
 * The paragraphs of an Office XML part. `paragraph` and `run` are the element names, such as
 * a:p and a:t in slides or w:p and w:t in Word. Tabs and line breaks inside a paragraph become
 * spaces.
 */
function paragraphs(xml, paragraph, run) {
    const result = [];
    const paragraphPattern = new RegExp(`<${paragraph}[\\s>][\\s\\S]*?</${paragraph}>`, 'g');
    const runPattern = new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>|<[a-z]:(?:tab|br)\\b[^>]*>`, 'g');
    for (const [block] of xml.matchAll(paragraphPattern)) {
        let text = '';
        for (const match of block.matchAll(runPattern)) text += match[1] === undefined ? ' ' : decode(match[1]);
        text = text.replace(/\s+/g, ' ').trim();
        if (text) result.push(text);
    }
    return result;
}

const read = (entries, name) => entries.get(name)?.().toString('utf8') ?? '';
const slideNumber = (name) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function pptxText(entries) {
    // Slides in their order in the presentation, which is not always their file numbering.
    const presentation = read(entries, 'ppt/presentation.xml');
    const relations = read(entries, 'ppt/_rels/presentation.xml.rels');
    const targets = new Map([...relations.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [
        /\bId="([^"]+)"/.exec(tag)?.[1], /\bTarget="([^"]+)"/.exec(tag)?.[1],
    ]));
    let slides = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
        .map(([, id]) => targets.get(id))
        .filter(Boolean)
        .map((target) => `ppt/${target.replace(/^\/?ppt\//, '').replace(/^\.\.\//, '')}`)
        .filter((name) => entries.has(name));
    if (!slides.length) {
        slides = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => slideNumber(a) - slideNumber(b));
    }
    if (!slides.length) throw new DocumentError('No slides were found in this presentation.');
    const sections = [];
    slides.forEach((slide, index) => {
        const text = paragraphs(read(entries, slide), 'a:p', 'a:t');
        // Speaker notes are linked from the slide; their own numbering need not match.
        const slideRelations = read(entries, slide.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'));
        const notesTarget = /Target="([^"]*notesSlide\d+\.xml)"/.exec(slideRelations)?.[1];
        const notesName = notesTarget ? `ppt/${notesTarget.replace(/^\.\.\//, '')}` : '';
        // A notes page repeats the slide number as text; drop lines that are only a number.
        const notes = notesName ? paragraphs(read(entries, notesName), 'a:p', 'a:t').filter((line) => !/^\d+$/.test(line)) : [];
        if (!text.length && !notes.length) return;
        const lines = [`Slide ${index + 1}:`, ...text];
        if (notes.length) lines.push(`Speaker notes: ${notes.join(' ')}`);
        sections.push(lines.join('\n'));
    });
    return sections.join('\n\n');
}

function docxText(entries) {
    const body = read(entries, 'word/document.xml');
    if (!body) throw new DocumentError('This Word document has no text.');
    return paragraphs(body, 'w:p', 'w:t').join('\n');
}

/**
 * The text of an uploaded document. Throws a DocumentError with a message fit for the
 * operator when the file cannot be read.
 */
function documentText(buffer, filename = '') {
    const extension = /\.([a-z0-9]+)$/i.exec(String(filename))?.[1]?.toLowerCase() || '';
    if (['txt', 'md', 'text'].includes(extension)) return buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (extension === 'pptx') return pptxText(readZip(buffer)).trim();
    if (extension === 'docx') return docxText(readZip(buffer)).trim();
    if (extension === 'ppt' || extension === 'doc') throw new DocumentError('Save it in the newer format first (.pptx or .docx), then load it again.');
    if (extension === 'pdf') throw new DocumentError('PDF files cannot be read. Copy the text from the PDF and paste it into the notes.');
    throw new DocumentError('Choose a PowerPoint (.pptx), Word (.docx) or text (.txt) file.');
}

module.exports = { DocumentError, documentText, readZip };
