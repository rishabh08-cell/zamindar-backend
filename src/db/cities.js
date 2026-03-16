const { supabase } = require('./client');

async function getAllCities() {
    const { data, error } = await supabase.from('cities').select('*').order('name');
    if (error) throw error;
    return data;
}

async function getCityById(id) {
    const { data, error } = await supabase.from('cities').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
}

async function findCityByLocation(lat, lng) {
    const { data, error } = await supabase.rpc('find_nearest_city', { lat, lng });
    if (error) throw error;
    return data;
}

module.exports = { getAllCities, getCityById, findCityByLocation };
