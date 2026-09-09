import type { Pool, PoolClient } from "pg";

/**
 * Runs `fn` inside a single transaction. Commits on success, rolls back on any
 * throw, always releases the client. READ COMMITTED by default; the per-document
 * row lock in the obsolete engine makes that safe there, so we don't pay the
 * serializable-retry cost globally.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  isolation: "READ COMMITTED" | "SERIALIZABLE" = "READ COMMITTED",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
