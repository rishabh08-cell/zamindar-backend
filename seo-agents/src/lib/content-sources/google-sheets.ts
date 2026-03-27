import { google } from 'googleapis';
import type { ParsedContent } from '../../types';

interface GoogleSheetsConfig {
  access_token: string;
  refresh_token?: string;
}

export interface SheetRow {
  row_number: number;
  data: Record<string, string>;
}

export interface SheetColumnMapping {
  title?: string;
  body?: string;
  slug?: string;
  meta_title?: string;
  meta_description?: string;
  categories?: string;
  tags?: string;
  featured_image_url?: string;
  focus_keyword?: string;
  canonical_url?: string;
  og_title?: string;
  og_description?: string;
  status?: string;
  [key: string]: string | undefined;
}

export class GoogleSheetsSource {
  private sheets;

  constructor(config: GoogleSheetsConfig) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({
      access_token: config.access_token,
      refresh_token: config.refresh_token,
    });

    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async fetchRows(
    sheetIdOrUrl: string,
    range: string = 'Sheet1',
    columnMapping?: SheetColumnMapping
  ): Promise<SheetRow[]> {
    const sheetId = this.extractSheetId(sheetIdOrUrl);

    const result = await this.sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });

    const rows = result.data.values;
    if (!rows || rows.length < 2) return [];

    // First row is headers
    const headers = rows[0] as string[];
    const dataRows: SheetRow[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as string[];
      const data: Record<string, string> = {};

      for (let j = 0; j < headers.length; j++) {
        const header = headers[j]?.trim();
        if (header) {
          data[header] = row[j]?.trim() || '';
        }
      }

      dataRows.push({ row_number: i + 1, data });
    }

    return dataRows;
  }

  rowToContent(row: SheetRow, mapping: SheetColumnMapping): ParsedContent {
    const get = (field: string | undefined): string => {
      if (!field) return '';
      return row.data[field] || '';
    };

    const title = get(mapping.title) || 'Untitled';
    const body = get(mapping.body);

    return {
      title,
      body_html: body,
      excerpt: body.replace(/<[^>]*>/g, '').slice(0, 300).trim(),
      images: mapping.featured_image_url
        ? [{ url: get(mapping.featured_image_url), is_featured: true }]
        : [],
      headings: [],
      raw_text: body.replace(/<[^>]*>/g, ''),
      word_count: body.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean).length,
      source: { type: 'google_sheet', ref: `row:${row.row_number}` },
    };
  }

  async getSheetMetadata(sheetIdOrUrl: string): Promise<{ title: string; sheets: string[] }> {
    const sheetId = this.extractSheetId(sheetIdOrUrl);

    const result = await this.sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'properties.title,sheets.properties.title',
    });

    return {
      title: result.data.properties?.title || '',
      sheets: result.data.sheets?.map((s) => s.properties?.title || '') || [],
    };
  }

  async getHeaders(sheetIdOrUrl: string, sheetName: string = 'Sheet1'): Promise<string[]> {
    const sheetId = this.extractSheetId(sheetIdOrUrl);

    const result = await this.sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!1:1`,
    });

    return (result.data.values?.[0] as string[]) || [];
  }

  private extractSheetId(sheetIdOrUrl: string): string {
    const match = sheetIdOrUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return sheetIdOrUrl;
  }
}
