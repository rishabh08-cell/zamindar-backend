const { supabase } = require('./client');

// ─── Fauj (Army) DB Module ──────────────────────────────────────────────────

const MAX_MEMBERS = 8;
const COOLDOWN_HOURS = 24;
const MAX_NAME_LENGTH = 30;

async function createFauj(userId, name, color) {
    if (!name || name.length > MAX_NAME_LENGTH) {
        throw new Error(`Fauj name must be 1-${MAX_NAME_LENGTH} characters`);
    }

    // Check cooldown
    await checkCooldown(userId);

    // Check user not already in a fauj
    const existing = await getUserFauj(userId);
    if (existing) throw new Error('You are already in a Fauj. Leave first.');

    // Create the fauj
    const { data: fauj, error } = await supabase
        .from('faujs')
        .insert({ name: name.trim(), leader_id: userId, color: color || '#ff6b00' })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') throw new Error('A Fauj with that name already exists');
        throw error;
    }

    // Add creator as senapati (leader)
    const { error: memberErr } = await supabase
        .from('fauj_members')
        .insert({ fauj_id: fauj.id, user_id: userId, role: 'senapati' });

    if (memberErr) throw memberErr;

    return fauj;
}

async function getFaujById(faujId) {
    const { data, error } = await supabase
        .from('faujs')
        .select('*, members:fauj_members(id, user_id, role, joined_at, user:users(id, display_name, avatar_url, zones_owned, total_distance_km))')
        .eq('id', faujId)
        .single();

    if (error) throw error;
    return data;
}

async function getUserFauj(userId) {
    const { data, error } = await supabase
        .from('fauj_members')
        .select('fauj_id, role, fauj:faujs(id, name, color, leader_id, created_at)')
        .eq('user_id', userId)
        .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
    return data;
}

async function getFaujMemberIds(faujId) {
    const { data, error } = await supabase
        .from('fauj_members')
        .select('user_id')
        .eq('fauj_id', faujId);

    if (error) throw error;
    return (data || []).map(m => m.user_id);
}

async function inviteToFauj(faujId, invitedBy, invitedUserId) {
    // Verify inviter is in this fauj
    const { data: membership } = await supabase
        .from('fauj_members')
        .select('id')
        .eq('fauj_id', faujId)
        .eq('user_id', invitedBy)
        .single();

    if (!membership) throw new Error('You are not a member of this Fauj');

    // Check target not already in a fauj
    const existing = await getUserFauj(invitedUserId);
    if (existing) throw new Error('That user is already in a Fauj');

    // Check member count
    const memberIds = await getFaujMemberIds(faujId);
    if (memberIds.length >= MAX_MEMBERS) throw new Error('Fauj is full (max 8 members)');

    const { data, error } = await supabase
        .from('fauj_invites')
        .upsert(
            { fauj_id: faujId, invited_by: invitedBy, invited_user_id: invitedUserId, status: 'pending', updated_at: new Date().toISOString() },
            { onConflict: 'fauj_id,invited_user_id' }
        )
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getPendingInvites(userId) {
    const { data, error } = await supabase
        .from('fauj_invites')
        .select('id, fauj_id, invited_by, created_at, fauj:faujs(id, name, color), inviter:users!fauj_invites_invited_by_fkey(id, display_name, avatar_url)')
        .eq('invited_user_id', userId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function respondToInvite(inviteId, userId, accept) {
    const { data: invite, error: fetchErr } = await supabase
        .from('fauj_invites')
        .select('id, fauj_id')
        .eq('id', inviteId)
        .eq('invited_user_id', userId)
        .eq('status', 'pending')
        .single();

    if (fetchErr || !invite) throw new Error('Invite not found or already responded');

    if (accept) {
        // Check cooldown
        await checkCooldown(userId);

        // Check not already in a fauj
        const existing = await getUserFauj(userId);
        if (existing) throw new Error('You are already in a Fauj. Leave first.');

        // Check member count
        const memberIds = await getFaujMemberIds(invite.fauj_id);
        if (memberIds.length >= MAX_MEMBERS) throw new Error('Fauj is full');

        // Join
        const { error: joinErr } = await supabase
            .from('fauj_members')
            .insert({ fauj_id: invite.fauj_id, user_id: userId, role: 'sipahi' });

        if (joinErr) throw joinErr;
    }

    // Update invite status
    await supabase
        .from('fauj_invites')
        .update({ status: accept ? 'accepted' : 'declined', updated_at: new Date().toISOString() })
        .eq('id', inviteId);

    return { accepted: accept, faujId: invite.fauj_id };
}

async function leaveFauj(userId) {
    const membership = await getUserFauj(userId);
    if (!membership) throw new Error('You are not in a Fauj');

    if (membership.role === 'senapati') {
        // Leader leaving — check if there are other members to transfer to
        const memberIds = await getFaujMemberIds(membership.fauj_id);
        const others = memberIds.filter(id => id !== userId);

        if (others.length > 0) {
            // Transfer leadership to longest-serving member
            const { data: nextLeader } = await supabase
                .from('fauj_members')
                .select('user_id')
                .eq('fauj_id', membership.fauj_id)
                .neq('user_id', userId)
                .order('joined_at', { ascending: true })
                .limit(1)
                .single();

            await supabase.from('fauj_members').update({ role: 'senapati' }).eq('fauj_id', membership.fauj_id).eq('user_id', nextLeader.user_id);
            await supabase.from('faujs').update({ leader_id: nextLeader.user_id, updated_at: new Date().toISOString() }).eq('id', membership.fauj_id);
        } else {
            // Last member — delete the fauj
            await supabase.from('faujs').delete().eq('id', membership.fauj_id);
            // CASCADE will clean up fauj_members and fauj_invites
        }
    }

    // Remove membership
    await supabase.from('fauj_members').delete().eq('user_id', userId);

    // Set 24hr cooldown
    const cooldownUntil = new Date(Date.now() + COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
    await supabase.from('users').update({ fauj_cooldown_until: cooldownUntil }).eq('id', userId);
}

async function disbandFauj(faujId, userId) {
    const { data: fauj } = await supabase
        .from('faujs')
        .select('id, leader_id')
        .eq('id', faujId)
        .single();

    if (!fauj) throw new Error('Fauj not found');
    if (fauj.leader_id !== userId) throw new Error('Only the Senapati can disband the Fauj');

    await supabase.from('faujs').delete().eq('id', faujId);
    // CASCADE handles members and invites
}

async function checkCooldown(userId) {
    const { data } = await supabase
        .from('users')
        .select('fauj_cooldown_until')
        .eq('id', userId)
        .single();

    if (data && data.fauj_cooldown_until && new Date(data.fauj_cooldown_until) > new Date()) {
        const remaining = Math.ceil((new Date(data.fauj_cooldown_until) - new Date()) / (60 * 60 * 1000));
        throw new Error(`You must wait ${remaining}h before joining or creating a Fauj`);
    }
}

async function areInSameFauj(userA, userB) {
    const memA = await getUserFauj(userA);
    const memB = await getUserFauj(userB);
    if (!memA || !memB) return false;
    return memA.fauj_id === memB.fauj_id;
}

async function listFaujs(limit = 20) {
    const { data, error } = await supabase
        .from('faujs')
        .select('id, name, color, leader_id, created_at, members:fauj_members(user_id)')
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return (data || []).map(f => ({
        ...f,
        member_count: f.members ? f.members.length : 0,
        members: undefined,
    }));
}

module.exports = {
    createFauj,
    getFaujById,
    getUserFauj,
    getFaujMemberIds,
    inviteToFauj,
    getPendingInvites,
    respondToInvite,
    leaveFauj,
    disbandFauj,
    areInSameFauj,
    listFaujs,
};
