import { inTeam, type TransactionalSqlDatabase } from "./db/sql-database.js";
import type { Directory } from "./directory/index.js";
import type { Work } from "./work.js";

/**
 * A deleted account (requirement 0003, *Deleted accounts*), told by the
 * sign-in service at `POST /users/deleted`: the user's directory row is
 * marked (`deleted_at`, kept from the first time; the email cleared), then
 * everything of the server's in their personal space goes (agents,
 * profiles, connections, sessions, runs, questions, triggers, usage and
 * the space's key), their personal agents in teams are removed (their
 * open sessions closed, their credentials deleted), and they leave every session's and agent's owners.
 *
 * Every step is safe to repeat, so a failure part-way is finished by the
 * sign-in service's next call. The directory's rows (the user, the
 * personal space and memberships) stay: a product sharing the directory
 * removes its own records first and the space last.
 */

/** The personal space's tables, children first (foreign keys). */
const SPACE_TABLES = ["questions", "steps", "triggers", "runs", "agent_credentials", "oauth_pending", "sessions", "agents", "profiles", "connections", "usage", "team_keys"];

export type DeleteUser = (identity: { issuer: string; subject: string }) => Promise<void>;

export function createAccountDeletion({
  db,
  directory,
  work,
  now = () => new Date(),
}: {
  db: TransactionalSqlDatabase;
  directory: Pick<Directory, "markDeleted" | "allTeams">;
  work: Pick<Work, "closeSession">;
  now?: () => Date;
}): DeleteUser {
  return async (identity) => {
    const { userId, personalSpaceId } = await directory.markDeleted(identity);
    if (personalSpaceId !== null)
      await inTeam(db, personalSpaceId, async (tx) => {
        for (const table of SPACE_TABLES) await tx.query(`DELETE FROM ${table} WHERE team_id = $1`, [personalSpaceId]);
      });
    // ponytail: every team is visited, as the scheduler's hourly pass does; a per-user index of teams if deletions become frequent at scale.
    for (const { id: teamId } of await directory.allTeams()) {
      if (teamId === personalSpaceId) continue;
      const stamp = now().toISOString();
      const open = await inTeam(db, teamId, async (tx) => {
        const owned = "SELECT id FROM agents WHERE team_id = $1 AND owner_user_id = $2";
        await tx.query(`UPDATE agents SET removed_at = $3, profile_id = NULL, updated_at = $3, version = version + 1 WHERE team_id = $1 AND owner_user_id = $2 AND removed_at IS NULL`, [teamId, userId, stamp]);
        await tx.query(`UPDATE agents SET profile_id = NULL WHERE team_id = $1 AND owner_user_id = $2 AND profile_id IS NOT NULL`, [teamId, userId]);
        await tx.query(`DELETE FROM agent_credentials WHERE team_id = $1 AND agent_id IN (${owned})`, [teamId, userId]);
        await tx.query(`DELETE FROM oauth_pending WHERE team_id = $1 AND (user_id = $2 OR agent_id IN (${owned}))`, [teamId, userId]);
        await tx.query(
          `UPDATE sessions SET owner_user_ids = array_remove(owner_user_ids, $2), updated_at = $3, version = version + 1 WHERE team_id = $1 AND $2 = ANY (owner_user_ids)`,
          [teamId, userId, stamp],
        );
        await tx.query(
          `UPDATE agents SET default_owner_user_ids = array_remove(default_owner_user_ids, $2), updated_at = $3, version = version + 1 WHERE team_id = $1 AND $2 = ANY (default_owner_user_ids)`,
          [teamId, userId, stamp],
        );
        const { rows } = await tx.query<{ id: string }>(`SELECT id FROM sessions WHERE team_id = $1 AND state = 'open' AND agent_id IN (${owned})`, [teamId, userId]);
        return rows.map((row) => row.id);
      });
      for (const sessionId of open) await work.closeSession(teamId, sessionId, "agent-removed");
    }
  };
}
