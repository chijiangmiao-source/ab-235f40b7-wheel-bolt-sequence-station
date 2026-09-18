'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function createPool() {
  return new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'wheel_station',
    max: Number(process.env.PGPOOLSIZE || 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

// 容器启动时数据库可能尚未就绪：循环等待后再执行幂等建表脚本。
async function waitForDatabase(pool, attempts = 60, delayMs = 1000) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function initDatabase(pool) {
  await waitForDatabase(pool);
  await pool.query(schemaSql);
}

module.exports = { createPool, initDatabase };
