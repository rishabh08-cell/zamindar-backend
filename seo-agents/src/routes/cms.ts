import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { supabase } from '../config/supabase';
import { createAdapter, getSupportedPlatforms } from '../lib/cms';
import { encrypt, decrypt } from '../lib/encryption';
import type { ConnectCMSRequest } from '../types';

const router = Router();

// GET /cms/platforms — list supported platforms
router.get('/platforms', (_req, res: Response) => {
  res.json({ platforms: getSupportedPlatforms() });
});

// POST /cms/connect — connect a new CMS instance
router.post('/connect', requireAuth, async (req: AuthRequest, res: Response) => {
  const { platform, site_url, credentials } = req.body as ConnectCMSRequest;

  if (!platform || !site_url || !credentials) {
    res.status(400).json({ error: 'platform, site_url, and credentials are required' });
    return;
  }

  try {
    const adapter = createAdapter(platform);
    const result = await adapter.connect({ site_url, credentials });

    if (!result.success) {
      res.status(400).json({ error: `Connection failed: ${result.error}` });
      return;
    }

    // Fetch CMS schema
    const schema = await adapter.fetchSchema().catch(() => null);

    // Encrypt credentials before storing
    const credentialsEncrypted = encrypt(JSON.stringify(credentials));

    const { data: connection, error } = await supabase
      .from('cms_connections')
      .upsert(
        {
          user_id: req.userId,
          platform,
          site_url: site_url.replace(/\/+$/, ''),
          site_name: result.site_name,
          credentials_encrypted: credentialsEncrypted,
          schema_cache: schema,
          is_active: true,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform,site_url' }
      )
      .select('id, platform, site_url, site_name, is_active, schema_cache, created_at')
      .single();

    if (error) throw error;

    res.status(201).json({ connection });
  } catch (err) {
    console.error('CMS connect error:', err);
    res.status(500).json({ error: 'Failed to connect CMS' });
  }
});

// GET /cms/connections — list user's CMS connections
router.get('/connections', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { data: connections, error } = await supabase
      .from('cms_connections')
      .select('id, platform, site_url, site_name, is_active, schema_cache, last_synced_at, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ connections: connections || [] });
  } catch (err) {
    console.error('List connections error:', err);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

// POST /cms/:id/test — test a connection is still valid
router.post('/:id/test', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { data: connection, error } = await supabase
      .from('cms_connections')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (error || !connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    const credentials = JSON.parse(decrypt(connection.credentials_encrypted));
    const adapter = createAdapter(connection.platform);
    await adapter.connect({ site_url: connection.site_url, credentials });
    const isValid = await adapter.testConnection();

    res.json({ valid: isValid });
  } catch (err) {
    console.error('Test connection error:', err);
    res.status(500).json({ error: 'Connection test failed' });
  }
});

// POST /cms/:id/sync-schema — refresh the CMS schema cache
router.post('/:id/sync-schema', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { data: connection, error } = await supabase
      .from('cms_connections')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (error || !connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    const credentials = JSON.parse(decrypt(connection.credentials_encrypted));
    const adapter = createAdapter(connection.platform);
    await adapter.connect({ site_url: connection.site_url, credentials });
    const schema = await adapter.fetchSchema();

    await supabase
      .from('cms_connections')
      .update({ schema_cache: schema, last_synced_at: new Date().toISOString() })
      .eq('id', connection.id);

    res.json({ schema });
  } catch (err) {
    console.error('Sync schema error:', err);
    res.status(500).json({ error: 'Failed to sync schema' });
  }
});

// DELETE /cms/:id — disconnect a CMS
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { error } = await supabase
      .from('cms_connections')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete connection error:', err);
    res.status(500).json({ error: 'Failed to disconnect CMS' });
  }
});

export default router;
