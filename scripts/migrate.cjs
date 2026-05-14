'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('Задайте DATABASE_URL (postgresql://user:pass@host:5432/dbname)');
    process.exit(1);
  }
  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
    // eslint-disable-next-line no-console
    console.log('OK: применён', schemaPath);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
