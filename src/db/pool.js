
require("dotenv").config({ path: ".env.local" });

const { Pool } = require("pg");

// Create a shared PostgreSQL connection pool for the backend.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
});

// Handle unexpected connection-pool errors.
pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

module.exports = pool;
