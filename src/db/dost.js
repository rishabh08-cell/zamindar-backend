const { supabase } = require('./client');

// ─── Dost (Friends) DB Module ───────────────────────────────────────────────

async function sendFriendRequest(requesterId, recipientId) {
    // Check for existing request in either direction
    const { data: existing } = await supabase
        .from('friendships')
        .select('id, status, requester_id')
        .or(`and(requester_id.eq.${requesterId},recipient_id.eq.${recipientId}),and(requester_id.eq.${recipientId},recipient_id.eq.${requesterId})`)
        .limit(1);

    if (existing && existing.length > 0) {
        const row = existing[0];
        if (row.status === 'accepted') throw new Error('Already friends');
        if (row.status === 'blocked') throw new Error('Cannot send request');
        if (row.status === 'pending' && row.requester_id === recipientId) {
            // They already sent us a request — auto-accept
            return acceptFriendRequest(row.id, requesterId);
        }
        throw new Error('Friend request already pending');
    }

    const { data, error } = await supabase
        .from('friendships')
        .insert({ requester_id: requesterId, recipient_id: recipientId })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function acceptFriendRequest(friendshipId, userId) {
    const { data, error } = await supabase
        .from('friendships')
        .update({ status: 'accepted', updated_at: new Date().toISOString() })
        .eq('id', friendshipId)
        .eq('recipient_id', userId)
        .eq('status', 'pending')
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function declineFriendRequest(friendshipId, userId) {
    const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendshipId)
        .eq('recipient_id', userId)
        .eq('status', 'pending');

    if (error) throw error;
}

async function removeFriend(friendshipId, userId) {
    // Either party can unfriend
    const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendshipId)
        .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);

    if (error) throw error;
}

async function getFriends(userId) {
    const { data, error } = await supabase
        .from('friendships')
        .select('id, requester_id, recipient_id, created_at, requester:users!friendships_requester_id_fkey(id, display_name, avatar_url), recipient:users!friendships_recipient_id_fkey(id, display_name, avatar_url)')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);

    if (error) throw error;

    // Normalize so caller always gets the "other" user
    return (data || []).map(f => {
        const friend = f.requester_id === userId ? f.recipient : f.requester;
        return { friendshipId: f.id, ...friend, since: f.created_at };
    });
}

async function getPendingRequests(userId) {
    const { data, error } = await supabase
        .from('friendships')
        .select('id, requester_id, created_at, requester:users!friendships_requester_id_fkey(id, display_name, avatar_url)')
        .eq('recipient_id', userId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function areFriends(userA, userB) {
    const { data } = await supabase
        .from('friendships')
        .select('id')
        .eq('status', 'accepted')
        .or(`and(requester_id.eq.${userA},recipient_id.eq.${userB}),and(requester_id.eq.${userB},recipient_id.eq.${userA})`)
        .limit(1);

    return data && data.length > 0;
}

async function getFriendIds(userId) {
    const { data, error } = await supabase
        .from('friendships')
        .select('requester_id, recipient_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);

    if (error) throw error;
    return (data || []).map(f => f.requester_id === userId ? f.recipient_id : f.requester_id);
}

async function getFriendCount(userId) {
    const { data, error } = await supabase
        .from('friendships')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'accepted')
        .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);

    if (error) throw error;
    return data ? data.length : 0;
}

module.exports = {
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    removeFriend,
    getFriends,
    getPendingRequests,
    areFriends,
    getFriendIds,
    getFriendCount,
};
