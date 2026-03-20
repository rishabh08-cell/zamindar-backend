const { supabase } = require('./client');

// ─── Strava Connections DB Module ────────────────────────────────────────────
// Separated from users — Strava is just one data source.

async function upsertStravaConnection({ userId, stravaId, accessToken, refreshToken, expiresAt, scopes }) {
  const { data, error } = await supabase
      .from('strava_connections')
          .upsert({
                user_id: userId,
                      strava_id: stravaId,
                            access_token: accessToken,
                                  refresh_token: refreshToken,
                                        token_expires_at: expiresAt,
                                              scopes: scopes || 'activity:read_all',
                                                    updated_at: new Date().toISOString(),
                                                        }, { onConflict: 'strava_id' })
                                                            .select()
                                                                .single();

                                                                  if (error) throw error;
                                                                    return data;
                                                                    }

                                                                    async function getConnectionByStravaId(stravaId) {
                                                                      const { data, error } = await supabase
                                                                          .from('strava_connections')
                                                                              .select('*, users(id, display_name, avatar_url, email)')
                                                                                  .eq('strava_id', stravaId)
                                                                                      .single();

                                                                                        if (error && error.code !== 'PGRST116') throw error;
                                                                                          return data;
                                                                                          }

                                                                                          async function getConnectionByUserId(userId) {
                                                                                            const { data, error } = await supabase
                                                                                                .from('strava_connections')
                                                                                                    .select('*')
                                                                                                        .eq('user_id', userId)
                                                                                                            .single();
                                                                                                            
                                                                                                              if (error && error.code !== 'PGRST116') throw error;
                                                                                                                return data;
                                                                                                                }
                                                                                                                
                                                                                                                async function updateTokens({ stravaId, accessToken, refreshToken, expiresAt }) {
                                                                                                                  const { data, error } = await supabase
                                                                                                                      .from('strava_connections')
                                                                                                                          .update({
                                                                                                                                access_token: accessToken,
                                                                                                                                      refresh_token: refreshToken,
                                                                                                                                            token_expires_at: expiresAt,
                                                                                                                                                  updated_at: new Date().toISOString(),
                                                                                                                                                      })
                                                                                                                                                          .eq('strava_id', stravaId)
                                                                                                                                                              .select()
                                                                                                                                                                  .single();
                                                                                                                                                                  
                                                                                                                                                                    if (error) throw error;
                                                                                                                                                                      return data;
                                                                                                                                                                      }
                                                                                                                                                                      
                                                                                                                                                                      async function deleteConnectionByUserId(userId) {
                                                                                                                                                                        const { error } = await supabase
                                                                                                                                                                            .from('strava_connections')
                                                                                                                                                                                .delete()
                                                                                                                                                                                    .eq('user_id', userId);
                                                                                                                                                                                    
                                                                                                                                                                                      if (error) throw error;
                                                                                                                                                                                      }
                                                                                                                                                                                      
                                                                                                                                                                                      module.exports = {
                                                                                                                                                                                        upsertStravaConnection,
                                                                                                                                                                                          getConnectionByStravaId,
                                                                                                                                                                                            getConnectionByUserId,
                                                                                                                                                                                              updateTokens,
                                                                                                                                                                                                deleteConnectionByUserId,
                                                                                                                                                                                                };
