/**
 * Team scoping: a store of team-owned records
 * hands out one repository per team, and every call of that repository
 * reads and writes that team's records only. The Postgres adapters bind
 * the team to each statement (`WHERE team_id`, and row-level security on
 * `app.team_id`); the in-memory ones keep one repository per team.
 */
export interface TeamScoped<T> {
  forTeam(teamId: string): T;
}
