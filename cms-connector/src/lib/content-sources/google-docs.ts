import { google } from 'googleapis';
import type { ParsedContent, ContentImage, ContentHeading } from '../../types';

interface GoogleDocsConfig {
  access_token: string;
  refresh_token?: string;
}

export class GoogleDocsSource {
  private docs;
  private drive;

  constructor(config: GoogleDocsConfig) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({
      access_token: config.access_token,
      refresh_token: config.refresh_token,
    });

    this.docs = google.docs({ version: 'v1', auth });
    this.drive = google.drive({ version: 'v3', auth });
  }

  async fetchDocument(docIdOrUrl: string): Promise<ParsedContent> {
    const docId = this.extractDocId(docIdOrUrl);
    const doc = await this.docs.documents.get({ documentId: docId });

    const body = doc.data.body;
    if (!body?.content) {
      throw new Error('Document has no content');
    }

    const title = doc.data.title || 'Untitled';
    const images: ContentImage[] = [];
    const headings: ContentHeading[] = [];
    let htmlParts: string[] = [];
    let rawTextParts: string[] = [];

    for (const element of body.content) {
      if (element.paragraph) {
        const { html, text, heading, image } = this.parseParagraph(
          element.paragraph as unknown as Record<string, unknown>,
          doc.data.inlineObjects as unknown as Record<string, unknown> | null
        );

        if (html) htmlParts.push(html);
        if (text) rawTextParts.push(text);
        if (heading) headings.push(heading);
        if (image) images.push(image);
      } else if (element.table) {
        htmlParts.push(this.parseTable(element.table as unknown as Record<string, unknown>));
      }
    }

    const rawText = rawTextParts.join('\n');

    return {
      title,
      body_html: htmlParts.join('\n'),
      excerpt: rawText.slice(0, 300).trim(),
      images,
      headings,
      raw_text: rawText,
      word_count: rawText.split(/\s+/).filter(Boolean).length,
      source: { type: 'google_doc', ref: docIdOrUrl },
    };
  }

  private parseParagraph(
    paragraph: Record<string, unknown>,
    inlineObjects?: Record<string, unknown> | null
  ): { html: string; text: string; heading: ContentHeading | null; image: ContentImage | null } {
    const style = paragraph.paragraphStyle as Record<string, unknown> | undefined;
    const namedStyle = style?.namedStyleType as string;
    const elements = paragraph.elements as Array<Record<string, unknown>> | undefined;

    let text = '';
    let html = '';
    let heading: ContentHeading | null = null;
    let image: ContentImage | null = null;

    if (!elements) return { html: '', text: '', heading: null, image: null };

    for (const el of elements) {
      if (el.textRun) {
        const run = el.textRun as { content: string; textStyle?: Record<string, unknown> };
        const content = run.content || '';
        text += content;

        let fragment = this.escapeHtml(content);
        if (run.textStyle?.bold) fragment = `<strong>${fragment}</strong>`;
        if (run.textStyle?.italic) fragment = `<em>${fragment}</em>`;
        if (run.textStyle?.underline) fragment = `<u>${fragment}</u>`;

        const link = run.textStyle?.link as Record<string, unknown> | undefined;
        if (link?.url) {
          fragment = `<a href="${link.url}">${fragment}</a>`;
        }

        html += fragment;
      }

      if (el.inlineObjectElement && inlineObjects) {
        const objId = (el.inlineObjectElement as Record<string, unknown>).inlineObjectId as string;
        const obj = (inlineObjects as Record<string, Record<string, unknown>>)[objId];
        if (obj) {
          const props = (obj.inlineObjectProperties as Record<string, unknown>)?.embeddedObject as Record<string, unknown>;
          if (props) {
            const imgUrl = (props.imageProperties as Record<string, unknown>)?.contentUri as string || '';
            const alt = props.title as string || props.description as string || '';
            image = { url: imgUrl, alt };
            html += `<img src="${imgUrl}" alt="${this.escapeHtml(alt)}" />`;
          }
        }
      }
    }

    // Wrap in appropriate tag based on heading style
    if (namedStyle?.startsWith('HEADING_')) {
      const level = parseInt(namedStyle.replace('HEADING_', ''), 10) as 1 | 2 | 3 | 4 | 5 | 6;
      heading = { level, text: text.trim() };
      html = `<h${level}>${html.trim()}</h${level}>`;
    } else if (namedStyle === 'TITLE') {
      heading = { level: 1, text: text.trim() };
      html = `<h1>${html.trim()}</h1>`;
    } else if (text.trim()) {
      html = `<p>${html}</p>`;
    }

    return { html, text, heading, image };
  }

  private parseTable(table: Record<string, unknown>): string {
    const rows = table.tableRows as Array<Record<string, unknown>> | undefined;
    if (!rows) return '';

    let html = '<table>';
    for (const row of rows) {
      html += '<tr>';
      const cells = row.tableCells as Array<Record<string, unknown>> | undefined;
      if (cells) {
        for (const cell of cells) {
          const content = cell.content as Array<Record<string, unknown>> | undefined;
          let cellText = '';
          if (content) {
            for (const el of content) {
              if (el.paragraph) {
                const { text } = this.parseParagraph(el.paragraph as Record<string, unknown>, null);
                cellText += text;
              }
            }
          }
          html += `<td>${this.escapeHtml(cellText.trim())}</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</table>';
    return html;
  }

  private extractDocId(docIdOrUrl: string): string {
    // Handle full URLs like https://docs.google.com/document/d/DOC_ID/edit
    const match = docIdOrUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];

    // Assume it's already a doc ID
    return docIdOrUrl;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
