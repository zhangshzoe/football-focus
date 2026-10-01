import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

export function sqliteD1(sql) {
  sql.exec("PRAGMA busy_timeout = 5000");
  return {
    prepare(query) { return { bind(...values) {
      const statement = sql.prepare(query);
      const execute = () => ({ meta: statement.run(...values) });
      return { execute, async first() { return statement.get(...values) || null; },
        async all() { return { results: statement.all(...values) }; }, async run() { return execute(); } };
    } }; },
    async batch(statements) {
      sql.exec("BEGIN IMMEDIATE");
      try { const results = statements.map(statement => statement.execute()); sql.exec("COMMIT"); return results; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
}

export async function researchDatabase(path = ":memory:") {
  const sql = new DatabaseSync(path);
  for (const name of ["0001_broken_shard.sql", "0002_magenta_magdalene.sql", "0003_thin_shiver_man.sql"])
    sql.exec(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), "utf8"));
  return sql;
}
