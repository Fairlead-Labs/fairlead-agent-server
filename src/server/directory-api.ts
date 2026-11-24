import { Hono, type Context } from "hono";
import { DirectoryError, type Directory, type DirectoryUser, type TeamRole } from "../directory/index.js";
import { SignInUnavailableError, type Caller } from "./oidc.js";

export interface DirectoryAppDependencies {
  directory: Directory;
  /** The caller a bearer token names, or undefined; throws `SignInUnavailableError` when the provider cannot be asked. */
  verify: (token: string) => Promise<Caller | undefined>;
  /** Who may create teams: every signed-in user, or installation admins only. */
  teamCreation: "users" | "admins";
}

type Env = { Variables: { caller: Caller; user: DirectoryUser } };

const INVITATION_HOURS = 7 * 24;
const CODE_HOURS = { default: 24, max: 30 * 24 };
const role = (value: unknown): TeamRole | undefined => (value === "admin" || value === "member" ? value : undefined);
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000);

/**
 * The directory's API (requirement 0003, D10–D12): every call is a signed-in
 * user's, judged by that user's own role in the team it names. A team the
 * caller is not in is 404, whoever asks; a write by a member who is no
 * admin is 403. An installation admin may list and remove teams and is not
 * thereby a member of any.
 */
export function createDirectoryApp({ directory, verify, teamCreation }: DirectoryAppDependencies): Hono<Env> {
  const app = new Hono<Env>();

  app.use(async (c, next) => {
    // Mounted after the server's API, whose sign-in already named the caller.
    if (c.get("caller")) return next();
    const [scheme, token] = (c.req.header("Authorization") ?? "").split(" ");
    let caller: Caller | undefined;
    try {
      caller = scheme === "Bearer" && token ? await verify(token) : undefined;
    } catch (error) {
      if (error instanceof SignInUnavailableError) return c.json({ error: "Sign-in unavailable" }, 503);
      throw error;
    }
    if (!caller) return c.json({ error: "Invalid token" }, 401);
    const user = await directory.signIn(caller);
    // A deleted account is never let in again (requirement 0003, *Deleted accounts*).
    if (user.deleted) return c.json({ error: "Invalid token" }, 401);
    c.set("caller", caller);
    c.set("user", user);
    return next();
  });

  app.onError((error, c) => {
    if (!(error instanceof DirectoryError)) throw error;
    if (error.code === "invalid") return c.json({ error: "Invalid request" }, 400);
    if (error.code === "last-admin") return c.json({ error: "A team keeps an admin" }, 409);
    return c.json({ error: "Not found" }, 404);
  });

  const body = async (c: Context<Env>) => ((await c.req.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
  const mayCreate = (caller: Caller) => teamCreation === "users" || caller.admin;
  /** The caller's place in the team: a response when they have none (404) or lack the admin role a write needs (403). */
  const refuse = async (c: Context<Env>, needs: "member" | "admin") => {
    const held = await directory.roleOf(c.req.param("teamId")!, c.get("user").id);
    if (!held) return c.json({ error: "Team not found" }, 404);
    if (needs === "admin" && held !== "admin") return c.json({ error: "Team admin required" }, 403);
    return undefined;
  };

  app.get("/me", async (c) => {
    const [caller, user] = [c.get("caller"), c.get("user")];
    return c.json({
      user: { id: user.id, email: user.email },
      admin: caller.admin,
      mayCreateTeams: mayCreate(caller),
      teams: await directory.teamsOf(user.id),
      invitations: user.email ? (await directory.invitationsFor(user.email)).map(({ email: _email, ...invitation }) => invitation) : [],
    });
  });

  app.get("/teams", async (c) => (c.get("caller").admin ? c.json({ teams: await directory.allTeams() }) : c.json({ error: "Installation admin required" }, 403)));
  app.post("/teams", async (c) => {
    const { name } = await body(c);
    if (typeof name !== "string") return c.json({ error: "Invalid request" }, 400);
    if (!mayCreate(c.get("caller"))) return c.json({ error: "Team creation is closed" }, 403);
    return c.json(await directory.createTeam(c.get("user").id, name), 201);
  });
  app.patch("/teams/:teamId", async (c) => {
    const refused = await refuse(c, "admin");
    if (refused) return refused;
    const { name } = await body(c);
    if (typeof name !== "string") return c.json({ error: "Invalid request" }, 400);
    await directory.renameTeam(c.req.param("teamId"), name);
    return c.body(null, 204);
  });
  app.delete("/teams/:teamId", async (c) => {
    const refused = c.get("caller").admin ? undefined : await refuse(c, "admin");
    if (refused) return refused;
    await directory.removeTeam(c.req.param("teamId")).catch((error: unknown) => {
      if (error instanceof DirectoryError && error.code === "not-found") return;
      throw error;
    });
    return c.body(null, 204);
  });

  app.get("/teams/:teamId/members", async (c) => (await refuse(c, "member")) ?? c.json({ members: await directory.members(c.req.param("teamId")) }));
  app.post("/teams/:teamId/members", async (c) => {
    const refused = await refuse(c, "admin");
    if (refused) return refused;
    const { userId, role: asked } = await body(c);
    const as = role(asked);
    if (typeof userId !== "string" || !as) return c.json({ error: "Invalid request" }, 400);
    await directory.addMember(c.req.param("teamId"), userId, as);
    return c.body(null, 204);
  });
  app.patch("/teams/:teamId/members/:userId", async (c) => {
    const refused = await refuse(c, "admin");
    if (refused) return refused;
    const as = role((await body(c))["role"]);
    if (!as) return c.json({ error: "Invalid request" }, 400);
    await directory.setRole(c.req.param("teamId"), c.req.param("userId"), as);
    return c.body(null, 204);
  });
  app.delete("/teams/:teamId/members/:userId", async (c) => {
    // Anyone may leave; removing someone else is an admin's.
    const refused = await refuse(c, c.req.param("userId") === c.get("user").id ? "member" : "admin");
    if (refused) return refused;
    await directory.removeMember(c.req.param("teamId"), c.req.param("userId"));
    return c.body(null, 204);
  });

  app.get("/teams/:teamId/invitations", async (c) => (await refuse(c, "admin")) ?? c.json({ invitations: await directory.invitations(c.req.param("teamId")) }));
  app.post("/teams/:teamId/invitations", async (c) => {
    const refused = await refuse(c, "admin");
    if (refused) return refused;
    const { email, role: asked } = await body(c);
    const as = role(asked);
    if (typeof email !== "string" || !as) return c.json({ error: "Invalid request" }, 400);
    return c.json(await directory.invite(c.req.param("teamId"), { email, role: as, expiresAt: inHours(INVITATION_HOURS) }), 201);
  });
  app.delete("/teams/:teamId/invitations/:id", async (c) => {
    const refused = await refuse(c, "admin");
    if (refused) return refused;
    await directory.revokeInvitation(c.req.param("teamId"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/invitations/:id/accept", async (c) => {
    try {
      await directory.acceptInvitation(c.req.param("id"), c.get("user").id);
    } catch (error) {
      if (error instanceof DirectoryError && error.code === "not-found") return c.json({ error: "Invitation not found" }, 404);
      throw error;
    }
    return c.body(null, 204);
  });

  app.get("/teams/:teamId/join-codes", async (c) => (await refuse(c, "admin")) ?? c.json({ joinCodes: await directory.joinCodes(c.req.param("teamId")) }));
  app.post("/teams/:teamId/join-codes", async (c) => {
    const refused = await refuse(c, "admin");
    if (refused) return refused;
    const { role: asked, uses = 1, expiresInHours = CODE_HOURS.default } = await body(c);
    const as = role(asked);
    if (!as || typeof uses !== "number" || typeof expiresInHours !== "number" || !(expiresInHours > 0 && expiresInHours <= CODE_HOURS.max)) return c.json({ error: "Invalid request" }, 400);
    const { code, record } = await directory.createJoinCode(c.req.param("teamId"), { role: as, uses, expiresAt: inHours(expiresInHours) });
    return c.json({ ...record, code }, 201);
  });
  app.delete("/teams/:teamId/join-codes/:id", async (c) => {
    const refused = await refuse(c, "admin");
    if (refused) return refused;
    await directory.revokeJoinCode(c.req.param("teamId"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/join", async (c) => {
    const { code } = await body(c);
    if (typeof code !== "string" || code.length > 200) return c.json({ error: "Invalid request" }, 400);
    try {
      await directory.join(code, c.get("user").id);
    } catch (error) {
      if (error instanceof DirectoryError && error.code === "not-found") return c.json({ error: "Code not found" }, 404);
      throw error;
    }
    return c.body(null, 204);
  });

  return app;
}
