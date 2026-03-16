const { supabase } = require('./client');

async function getConflictsByZone(zoneId) {
    const { data, error } = await supabase.from('zone_conflicts').select('*').eq('zone_id', zoneId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
}

async function insertConflict({ zoneId, challengerId, defenderId, challengerKm, defenderKm }) {
    const { data, error } = await supabase.from('zone_conflicts').insert({ zone_id: zoneId, challenger_id: challengerId, defender_id: defenderId, challenger_km: challengerKm, defender_km: defenderKm, status: 'active' }).select().single();
    if (error) throw error;
    return data;
}

async function resolveConflict(conflictId, winnerId) {
    const { data, error } = await supabase.from('zone_conflicts').update({ status: 'resolved', winner_id: winnerId }).eq('id', conflictId).select().single();
    if (error) throw error;
    return data;
}

module.exports = { getConflictsByZone, insertConflict, resolveConflict };
