/**
 * DOCX export — the submittable format.
 *
 * Turns the translated blocks into a real Word document. We do NOT use a PDF
 * library here: jsPDF/pdf-lib don't shape Arabic and would reintroduce the
 * disconnected-letter bug. Word shapes Arabic itself, so a .docx with proper
 * RTL paragraph/run properties renders perfectly — and the user can edit it,
 * add their name, and hand it in.
 *
 * Pure builder: returns a `docx` Document. The client packs it:
 *   import { Packer } from "docx";
 *   const blob = await Packer.toBlob(buildTranslationDoc(blocks, opts));
 */
import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell as DocxTableCell,
  AlignmentType,
  HeadingLevel,
  WidthType,
  Footer,
  PageNumber,
  ShadingType,
  type IParagraphOptions,
} from 'docx';
import type { Block, TableCell } from './types';

export interface DocxOptions {
  /** Shown on the title block — usually the original filename. */
  title?: string;
  /** Arabic-capable font. Default "Arial" (universally installed, shapes Arabic). */
  arabicFont?: string;
  /** Monospace font for code/equations. Default "Consolas". */
  monoFont?: string;
  /** Include the bilingual English term after key terms/headings. Default false. */
  showEnglishTerms?: boolean;
}

const COLOR = {
  ink: '1A1814',
  accent: '0E5C52',
  faint: '8A8070',
  amber: '9C5A14',
  tableHead: 'E7DDC8',
  codeBg: 'F3ECDD',
  figureBg: 'FBF3E6',
};

function font(name: string) {
  return { ascii: name, hAnsi: name, cs: name };
}

function rtlPara(opts: IParagraphOptions): Paragraph {
  return new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, ...opts });
}

/** Arabic run(s), optionally followed by a muted English term. */
function arRuns(ar: string, o: Required<DocxOptions>, en?: string, extra: Record<string, unknown> = {}): TextRun[] {
  const runs: TextRun[] = [new TextRun({ text: ar, rightToLeft: true, font: font(o.arabicFont), ...extra })];
  if (en && o.showEnglishTerms) {
    runs.push(new TextRun({ text: ` (${en})`, font: font('Arial'), size: 18, color: COLOR.faint }));
  }
  return runs;
}

function lowconfTag(o: Required<DocxOptions>): TextRun {
  return new TextRun({ text: '⚠ ', rightToLeft: true, font: font(o.arabicFont), color: COLOR.amber, bold: true });
}

function cellToParagraph(cell: TableCell, o: Required<DocxOptions>, header: boolean): Paragraph {
  const norm = typeof cell === 'string' ? { ar: cell } : cell;
  return rtlPara({
    children: arRuns(norm.ar ?? '', o, norm.en, header ? { bold: true, color: COLOR.accent } : {}),
  });
}

function blockToElements(block: Block, o: Required<DocxOptions>): (Paragraph | Table)[] {
  const lead = block.lowconf === true ? [lowconfTag(o)] : [];

  switch (block.type) {
    case 'heading':
      return [
        rtlPara({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          children: [...lead, ...arRuns(block.ar ?? '', o, block.en, { bold: true, color: COLOR.accent, size: 32 })],
        }),
      ];
    case 'subheading':
      return [
        rtlPara({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 },
          children: [...lead, ...arRuns(block.ar ?? '', o, block.en, { bold: true, size: 26 })],
        }),
      ];
    case 'paragraph':
      return [rtlPara({ spacing: { after: 140, line: 340 }, children: [...lead, ...arRuns(block.ar ?? '', o)] })];
    case 'list':
      return (block.items ?? []).map((item, i) =>
        rtlPara({ bullet: { level: 0 }, spacing: { after: 60 }, children: i === 0 ? [...lead, ...arRuns(item, o)] : arRuns(item, o) }),
      );
    case 'caption':
      return [
        rtlPara({
          spacing: { after: 140 },
          children: [...lead, ...arRuns(block.ar ?? '', o, undefined, { italics: true, color: COLOR.faint, size: 20 })],
        }),
      ];
    case 'figure':
      return [
        rtlPara({
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.figureBg },
          spacing: { before: 80, after: 80 },
          children: [
            ...lead,
            new TextRun({ text: 'شكل: ', rightToLeft: true, font: font(o.arabicFont), bold: true, color: COLOR.amber }),
            ...arRuns(block.ar ?? '', o),
          ],
        }),
      ];
    case 'equation':
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 80 },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.codeBg },
          children: [new TextRun({ text: block.content ?? '', font: font(o.monoFont), size: 22 })],
        }),
      ];
    case 'code':
      return [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 80, after: 80 },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.codeBg },
          children: [new TextRun({ text: block.content ?? '', font: font(o.monoFont), size: 20 })],
        }),
      ];
    case 'table': {
      const rows = block.rows ?? [];
      const table = new Table({
        visuallyRightToLeft: true, // mirrors columns so the first logical column sits on the right
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map(
          (row, ri) =>
            new TableRow({
              tableHeader: ri === 0,
              children: row.map(
                (cell) =>
                  new DocxTableCell({
                    shading: ri === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.tableHead } : undefined,
                    children: [cellToParagraph(cell, o, ri === 0)],
                  }),
              ),
            }),
        ),
      });
      return [table, new Paragraph({ spacing: { after: 120 }, children: [] })];
    }
    default:
      return [];
  }
}

export function buildTranslationDoc(blocks: Block[], options: DocxOptions = {}): Document {
  const o: Required<DocxOptions> = {
    title: options.title ?? '',
    arabicFont: options.arabicFont ?? 'Arial',
    monoFont: options.monoFont ?? 'Consolas',
    showEnglishTerms: options.showEnglishTerms ?? false,
  };

  const titleBlock: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: 'مُعرِّب', rightToLeft: true, font: font(o.arabicFont), bold: true, size: 56, color: COLOR.accent })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: o.title || 'ترجمة إلى العربية', rightToLeft: true, font: font(o.arabicFont), size: 24, color: COLOR.ink })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: 'ترجمة آلية — يُرجى مراجعة الأرقام والمصطلحات المهمة مقابل النص الأصلي.',
          rightToLeft: true,
          font: font(o.arabicFont),
          italics: true,
          size: 18,
          color: COLOR.faint,
        }),
      ],
    }),
  ];

  const body = blocks.flatMap((b) => blockToElements(b, o));

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: 'مُعرِّب · Muʿarrib — ', font: font('Arial'), size: 16, color: COLOR.faint }),
          new TextRun({ children: [PageNumber.CURRENT], font: font('Arial'), size: 16, color: COLOR.faint }),
        ],
      }),
    ],
  });

  return new Document({
    creator: 'Muʿarrib',
    title: o.title || 'Muʿarrib translation',
    sections: [
      {
        properties: {},
        footers: { default: footer },
        children: [...titleBlock, ...body],
      },
    ],
  });
}
