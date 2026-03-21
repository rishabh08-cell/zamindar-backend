const { supabase } = require('./client');

const DUEL_DURATION_HOURS = 48;

async function createDuel(challengerId, opponentId, faujId) {
    // Check no active duel between these two
    const { data: existing } = await supabase
        .from('duels')
        .select('id')
        .or(`and(challenger_id.eq.${challengerId},opponent_id.eq.${opponentId}),and(challenger_id.eq.${opponentId},opponent_id.eq.${challengerId})`)
        .in('status', ['pending', 'accepted'])
        .limit(1);

    if (existing && existing.length > 0) {
        throw new Error('A duel is already active between you two');
    }

    const { data, error } = await supabase
        .from('duels')
        .insert({
            challenger_id: challengerId,
            opponent_id: opponentId,
            fauj_id: faujId,
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function acceptDuel(duelId, userId) {
    const expiresAt = new Date(Date.now() + DUEL_DURATION_HOURS * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from('duels')
        .update({
            status: 'accepted',
            expires_at: expiresAt,
            updated_at: new Date().toISOString(),
        })
        .eq('id', duelId)
        .eq('opponent_id', userId)
        .eq('status', 'pending')
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function cancelDuel(duelId, userId) {
    // Either party can cancel
    const { data, error } = await supabase
        .from('duels')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', duelId)
        .or(`challenger_id.eq.${userId},opponent_id.eq.${userId}`)
        .in('status', ['pending', 'accepted'])
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getActiveDuel(userA, userB) {
    const now = new Date().toISOString();
    const { data } = await supabase
        .from('duels')
        .select('*')
        .or(`and(challenger_id.eq.${userA},opponent_id.eq.${userB}),and(challenger_id.eq.${userB},opponent_id.eq.${userA})`)
        .eq('status', 'accepted')
        .gt('expires_at', now)
        .limit(1);

    return data && data.length > 0 ? data[0] : null;
}

async function getActiveDuelPartnerIds(userId) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('duels')
        .select('challenger_id, opponent_id')
        .or(`challenger_id.eq.${userId},opponent_id.eq.${userId}`)
        .eq('status', 'accepted')
        .gt('expires_at', now);

    if (error) throw error;
    return (data || []).map(d =>
        d.challenger_id === userId ? d.opponent_id : d.challenger_id
    );
}

async function getUserDuels(userId) {
    const { data, error } = await supabase
        .from('duels')
        .select('*, challenger:users!duels_challenger_id_fkey(id, display_name, avatar_url), opponent:users!duels_opponent_id_fkey(id, display_name, avatar_url)')
        .or(`challenger_id.eq.${userId},opponent_id.eq.${userId}`)
        .in('status', ['pending', 'accepted'])
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function completeDuel(duelId, winnerId) {
    const { data, error } = await supabase
        .from('duels')
        .update({
            status: 'completed',
            winner_id: winnerId || null,
            updated_at: new Date().toISOString(),
        })
        .eq('id', duelId)
        .eq('status', 'accepted')
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function expireOldDuels() {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('duels')
        .update({ status: 'completed', updated_at: now })
        .eq('status', 'accepted')
        .lt('expires_at', now)
        .select();

    if (error) throw error;
    return data || [];
}

module.exports = {
    createDuel,
    acceptDuel,
    cancelDuel,
    getActiveDuel,
    getActiveDuelPartnerIds,
    getUserDuels,
    completeDuel,
    expireOldDuels,
    DUEL_DURATION_HOURS,
};
