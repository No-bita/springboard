/**
 * Cloudflare D1 Database Client Helper
 * Collectrr v2
 */

export function getDbClient(env) {
  const db = env?.DB || env;
  if (db && typeof db.execute === "function" && typeof db.prepare !== "function") {
    if (typeof db.batch !== "function") {
      db.batch = async (queries) => {
        const results = [];
        for (const q of queries) {
          results.push(await db.execute(q));
        }
        return results;
      };
    }
    return db;
  }

  const executeQuery = async (query) => {
    let sql, args;
    if (typeof query === "string") {
      sql = query;
      args = [];
    } else {
      sql = query.sql;
      args = query.args || [];
    }

    let stmt = db.prepare(sql);
    if (args && args.length > 0) {
      stmt = stmt.bind(...args);
    }
    const res = await stmt.all();
    const rows = res.results || res.rows || [];
    return {
      rows,
      results: rows,
      meta: res.meta,
      changes: res.meta?.changes ?? (res.changes ?? (rows ? rows.length : 0)),
    };
  };

  const executeBatch = async (queries) => {
    if (db && typeof db.batch === "function") {
      const prepared = queries.map((q) => {
        const sql = typeof q === "string" ? q : q.sql;
        const args = typeof q === "string" ? [] : q.args || [];
        let stmt = db.prepare(sql);
        if (args && args.length > 0) stmt = stmt.bind(...args);
        return stmt;
      });
      return await db.batch(prepared);
    }
    const results = [];
    for (const q of queries) {
      results.push(await executeQuery(q));
    }
    return results;
  };

  return {
    execute: executeQuery,
    batch: executeBatch,
  };
}
