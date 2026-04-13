// src/db/index.js
// Raw PostgreSQL pool for PostGIS queries (territory zones, attacks, patrols)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    /**
     * Convenience wrapper – same signature as pool.query()
      * so routes can do: const { rows } = await query('SELECT ...', [params])
       */
       async function query(text, params) {
         return pool.query(text, params);
         }

         module.exports = { pool, query };
         
