import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { supabase } from '../config/supabase';
import { GoogleDocsSource, GoogleSheetsSource } from '../lib/content-sources';

const router = Router();

// POST /content/sources — register a content source
router.post('/sources', requireAuth, async (req: AuthRequest, res: Response) => {
  const { source_type, source_ref, title, column_mapping } = req.body;

  if (!source_type || !source_ref) {
    res.status(400).json({ error: 'source_type and source_ref are required' });
    return;
  }

  try {
    const { data: source, error } = await supabase
      .from('content_sources')
      .insert({
        user_id: req.userId,
        source_type,
        source_ref,
        title: title || 'Untitled',
        column_mapping: column_mapping || null,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ source });
  } catch (err) {
    console.error('Create content source error:', err);
    res.status(500).json({ error: 'Failed to register content source' });
  }
});

// GET /content/sources — list user's content sources
router.get('/sources', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { data: sources, error } = await supabase
      .from('content_sources')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ sources: sources || [] });
  } catch (err) {
    console.error('List content sources error:', err);
    res.status(500).json({ error: 'Failed to fetch content sources' });
  }
});

// POST /content/fetch-doc — fetch and parse a Google Doc
router.post('/fetch-doc', requireAuth, async (req: AuthRequest, res: Response) => {
  const { doc_url } = req.body;

  if (!doc_url) {
    res.status(400).json({ error: 'doc_url is required' });
    return;
  }

  try {
    // Get user's Google tokens
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', req.userId)
      .single();

    if (userError || !user?.google_access_token) {
      res.status(400).json({ error: 'Google account not connected. Please connect your Google account first.' });
      return;
    }

    const docsSource = new GoogleDocsSource({
      access_token: user.google_access_token,
      refresh_token: user.google_refresh_token,
    });

    const content = await docsSource.fetchDocument(doc_url);

    res.json({ content });
  } catch (err) {
    console.error('Fetch doc error:', err);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// POST /content/fetch-sheet — fetch rows from a Google Sheet
router.post('/fetch-sheet', requireAuth, async (req: AuthRequest, res: Response) => {
  const { sheet_url, range, column_mapping } = req.body;

  if (!sheet_url) {
    res.status(400).json({ error: 'sheet_url is required' });
    return;
  }

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', req.userId)
      .single();

    if (userError || !user?.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' });
      return;
    }

    const sheetsSource = new GoogleSheetsSource({
      access_token: user.google_access_token,
      refresh_token: user.google_refresh_token,
    });

    const rows = await sheetsSource.fetchRows(sheet_url, range);
    const headers = rows.length > 0 ? Object.keys(rows[0].data) : [];

    // If column mapping provided, convert rows to content
    let parsedContent;
    if (column_mapping) {
      parsedContent = rows.map((row) => sheetsSource.rowToContent(row, column_mapping));
    }

    res.json({ rows, headers, parsed_content: parsedContent });
  } catch (err) {
    console.error('Fetch sheet error:', err);
    res.status(500).json({ error: 'Failed to fetch spreadsheet' });
  }
});

// GET /content/sheet-headers — get column headers for mapping
router.get('/sheet-headers', requireAuth, async (req: AuthRequest, res: Response) => {
  const { sheet_url, sheet_name } = req.query;

  if (!sheet_url) {
    res.status(400).json({ error: 'sheet_url is required' });
    return;
  }

  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('google_access_token, google_refresh_token')
      .eq('id', req.userId)
      .single();

    if (userError || !user?.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' });
      return;
    }

    const sheetsSource = new GoogleSheetsSource({
      access_token: user.google_access_token,
      refresh_token: user.google_refresh_token,
    });

    const [metadata, headers] = await Promise.all([
      sheetsSource.getSheetMetadata(sheet_url as string),
      sheetsSource.getHeaders(sheet_url as string, (sheet_name as string) || undefined),
    ]);

    res.json({ metadata, headers });
  } catch (err) {
    console.error('Sheet headers error:', err);
    res.status(500).json({ error: 'Failed to fetch sheet headers' });
  }
});

// DELETE /content/sources/:id
router.delete('/sources/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { error } = await supabase
      .from('content_sources')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete content source error:', err);
    res.status(500).json({ error: 'Failed to delete content source' });
  }
});

export default router;
