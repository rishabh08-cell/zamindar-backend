import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { supabase } from '../config/supabase';
import { createAdapter } from '../lib/cms';
import { PublishingAgent } from '../lib/agent';
import { validateContent } from '../lib/agent/validator';
import { decrypt } from '../lib/encryption';
import type { PublishRequest, CMSConnection, PublishableContent } from '../types';

const router = Router();

// POST /publish/prepare — run agent to prepare content for publishing
router.post('/prepare', requireAuth, async (req: AuthRequest, res: Response) => {
  const { content, cms_connection_id, instructions } = req.body;

  if (!content) {
    res.status(400).json({ error: 'content is required (ParsedContent object)' });
    return;
  }

  try {
    // Get CMS schema if a connection is specified
    let schema = null;
    if (cms_connection_id) {
      const { data: connection } = await supabase
        .from('cms_connections')
        .select('schema_cache')
        .eq('id', cms_connection_id)
        .eq('user_id', req.userId)
        .single();

      schema = connection?.schema_cache || null;
    }

    // Load user's custom playbook if exists
    const { data: playbook } = await supabase
      .from('seo_playbooks')
      .select('content')
      .eq('user_id', req.userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Run the agent
    const agent = new PublishingAgent(playbook?.content ? undefined : undefined);
    const result = await agent.prepare(content, schema, instructions);

    res.json({ result });
  } catch (err) {
    console.error('Prepare error:', err);
    res.status(500).json({ error: 'Failed to prepare content' });
  }
});

// POST /publish/validate — quick rule-based validation (no AI)
router.post('/validate', requireAuth, async (req: AuthRequest, res: Response) => {
  const { content, cms_connection_id } = req.body;

  if (!content) {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  try {
    let schema = null;
    if (cms_connection_id) {
      const { data: connection } = await supabase
        .from('cms_connections')
        .select('schema_cache')
        .eq('id', cms_connection_id)
        .eq('user_id', req.userId)
        .single();

      schema = connection?.schema_cache || null;
    }

    const missing = validateContent(content, schema);
    const hasRequired = missing.some((m) => m.severity === 'required');

    res.json({ is_ready: !hasRequired, missing });
  } catch (err) {
    console.error('Validate error:', err);
    res.status(500).json({ error: 'Validation failed' });
  }
});

// POST /publish — publish content to one or more CMS platforms
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { cms_connection_ids, content, content_source_id, auto_fill, publish_status } = req.body as PublishRequest;

  if (!cms_connection_ids?.length || !content) {
    res.status(400).json({ error: 'cms_connection_ids and content are required' });
    return;
  }

  try {
    // Fetch all target connections
    const { data: connections, error: connError } = await supabase
      .from('cms_connections')
      .select('*')
      .in('id', cms_connection_ids)
      .eq('user_id', req.userId);

    if (connError || !connections?.length) {
      res.status(404).json({ error: 'No valid CMS connections found' });
      return;
    }

    const results = await Promise.allSettled(
      connections.map((conn) => publishToConnection(
        conn as CMSConnection,
        content as PublishableContent,
        req.userId!,
        content_source_id,
        publish_status || 'draft'
      ))
    );

    const publications = results.map((r, i) => ({
      cms_connection_id: connections[i].id,
      platform: connections[i].platform,
      site_name: connections[i].site_name,
      ...(r.status === 'fulfilled' ? r.value : { success: false, error: (r.reason as Error).message }),
    }));

    res.json({ publications });
  } catch (err) {
    console.error('Publish error:', err);
    res.status(500).json({ error: 'Publishing failed' });
  }
});

// PUT /publish/:id/sync — update an existing publication
router.put('/:id/sync', requireAuth, async (req: AuthRequest, res: Response) => {
  const { content, resolve_missing } = req.body;

  try {
    const { data: publication, error: pubError } = await supabase
      .from('publications')
      .select('*, cms_connections(*)')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (pubError || !publication) {
      res.status(404).json({ error: 'Publication not found' });
      return;
    }

    if (!publication.cms_post_id) {
      res.status(400).json({ error: 'Publication has not been published yet — use POST /publish instead' });
      return;
    }

    const conn = publication.cms_connections as CMSConnection;
    const credentials = JSON.parse(decrypt(conn.credentials_encrypted));
    const adapter = createAdapter(conn.platform);
    await adapter.connect({ site_url: conn.site_url, credentials });

    // Merge existing content with updates
    const updatedContent: PublishableContent = {
      ...publication.content_snapshot,
      ...content,
      ...(resolve_missing || {}),
    };

    const result = await adapter.updatePost(publication.cms_post_id, updatedContent);

    if (result.success) {
      await supabase
        .from('publications')
        .update({
          content_snapshot: updatedContent,
          status: 'published',
          cms_post_url: result.cms_post_url || publication.cms_post_url,
          last_synced_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', publication.id);

      // Log
      await supabase.from('publish_logs').insert({
        publication_id: publication.id,
        action: 'update',
        status: 'success',
        details: { cms_post_url: result.cms_post_url },
      });
    }

    res.json({ result });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// GET /publish/publications — list user's publications
router.get('/publications', requireAuth, async (req: AuthRequest, res: Response) => {
  const { status, cms_connection_id } = req.query;

  try {
    let query = supabase
      .from('publications')
      .select('id, status, cms_post_id, cms_post_url, missing_fields, error_message, last_synced_at, created_at, cms_connections(platform, site_name)')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (cms_connection_id) query = query.eq('cms_connection_id', cms_connection_id);

    const { data: publications, error } = await query;

    if (error) throw error;

    res.json({ publications: publications || [] });
  } catch (err) {
    console.error('List publications error:', err);
    res.status(500).json({ error: 'Failed to fetch publications' });
  }
});

// POST /publish/:id/audit — run SEO audit on published content
router.post('/:id/audit', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { data: publication, error } = await supabase
      .from('publications')
      .select('content_snapshot')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (error || !publication) {
      res.status(404).json({ error: 'Publication not found' });
      return;
    }

    const agent = new PublishingAgent();
    const audit = await agent.audit(publication.content_snapshot);

    // Log audit
    await supabase.from('publish_logs').insert({
      publication_id: req.params.id,
      action: 'audit',
      status: 'success',
      details: audit,
    });

    res.json({ audit });
  } catch (err) {
    console.error('Audit error:', err);
    res.status(500).json({ error: 'Audit failed' });
  }
});

// --- Helper ---

async function publishToConnection(
  conn: CMSConnection,
  content: PublishableContent,
  userId: string,
  contentSourceId?: string,
  publishStatus: string = 'draft'
): Promise<{ success: boolean; publication_id?: string; cms_post_url?: string; error?: string }> {
  const credentials = JSON.parse(decrypt(conn.credentials_encrypted));
  const adapter = createAdapter(conn.platform);
  await adapter.connect({ site_url: conn.site_url, credentials });

  const contentToPublish = { ...content, status: publishStatus as 'draft' | 'publish' };
  const result = await adapter.createPost(contentToPublish);

  // Create publication record
  const { data: publication } = await supabase
    .from('publications')
    .insert({
      user_id: userId,
      content_source_id: contentSourceId || null,
      cms_connection_id: conn.id,
      cms_post_id: result.cms_post_id || null,
      cms_post_url: result.cms_post_url || null,
      status: result.success ? 'published' : 'failed',
      content_snapshot: contentToPublish,
      missing_fields: [],
      error_message: result.error || null,
      last_synced_at: result.success ? new Date().toISOString() : null,
    })
    .select('id')
    .single();

  // Log
  await supabase.from('publish_logs').insert({
    publication_id: publication?.id,
    action: 'create',
    status: result.success ? 'success' : 'failed',
    details: result,
  });

  return {
    success: result.success,
    publication_id: publication?.id,
    cms_post_url: result.cms_post_url,
    error: result.error,
  };
}

export default router;
