import crypto from "node:crypto";
import type { Db } from "mongodb";
import { GraphQLError } from "graphql";

export type Staff = {
  id: string;
  name: string;
  role: "ADMIN" | "RESTAURANT" | "RIDER";
  restaurantId?: string | null;
};
export type AuthContext = { user?: Staff; sessionId?: string };
const SCRYPT_N = 16384;
const MAX_PASSWORD = 256;
const ROLE_SET = new Set(["ADMIN", "RESTAURANT", "RIDER"]);
function hashPassword(value: string, salt: string) {
  return crypto.scryptSync(value, salt, 32, { N: SCRYPT_N }).toString("hex");
}
export function passwordHash(
  password: string,
  salt = crypto.randomBytes(16).toString("hex"),
) {
  return `${salt}:${hashPassword(password, salt)}`;
}
function verify(password: unknown, encoded: unknown) {
  if (
    typeof password !== "string" ||
    password.length > MAX_PASSWORD ||
    typeof encoded !== "string"
  )
    return false;
  const parts = encoded.split(":");
  if (
    parts.length !== 2 ||
    !/^[0-9a-f]{16,128}$/i.test(parts[0]) ||
    !/^[0-9a-f]{64}$/i.test(parts[1])
  )
    return false;
  try {
    const actual = Buffer.from(hashPassword(password, parts[0]), "hex");
    const expected = Buffer.from(parts[1], "hex");
    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
export function publicStaff(u: any): Staff {
  const role = u?.role;
  if (
    typeof u?.id !== "string" ||
    typeof u?.name !== "string" ||
    !ROLE_SET.has(role) ||
    (role === "RESTAURANT" && typeof u.restaurantId !== "string")
  )
    throw new GraphQLError("Utilisateur invalide", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  return { id: u.id, name: u.name, role, restaurantId: u.restaurantId ?? null };
}
export async function login(db: Db, email: string, password: string) {
  if (
    typeof email !== "string" ||
    email.length > 320 ||
    typeof password !== "string" ||
    password.length > MAX_PASSWORD
  )
    throw new GraphQLError("Identifiants invalides", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  const u = await db
    .collection("staff_users")
    .findOne({ email: email.trim().toLowerCase(), active: true });
  let valid = false;
  if (u) {
    try {
      valid = verify(password, u.passwordHash);
      if (valid) publicStaff(u);
    } catch {
      valid = false;
    }
  }
  if (!valid)
    throw new GraphQLError("Identifiants invalides", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  const raw = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  await db
    .collection("staff_sessions")
    .insertOne({
      id: crypto.randomUUID(),
      tokenHash,
      userId: u!.id,
      createdAt: new Date(),
      expiresAt: expires,
    });
  return { token: raw, user: publicStaff(u) };
}
export async function authenticate(
  db: Db,
  authorization?: string,
): Promise<AuthContext> {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
    return {};
  const raw = authorization.slice(7).trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(raw)) return {};
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const session = await db
    .collection("staff_sessions")
    .findOne({
      tokenHash,
      expiresAt: { $gt: new Date() },
      revokedAt: { $exists: false },
    });
  if (!session) return {};
  const u = await db
    .collection("staff_users")
    .findOne({ id: session.userId, active: true });
  if (!u) return {};
  try {
    return { user: publicStaff(u), sessionId: session.id };
  } catch {
    return {};
  }
}
export function requireUser(ctx: AuthContext): Staff {
  if (!ctx.user)
    throw new GraphQLError("Authentification requise", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  return ctx.user;
}
export function requireRole(ctx: AuthContext, roles: Staff["role"][]) {
  const user = requireUser(ctx);
  if (!roles.includes(user.role))
    throw new GraphQLError("Droits insuffisants", {
      extensions: { code: "FORBIDDEN" },
    });
  return user;
}
export async function logout(db: Db, ctx: AuthContext) {
  if (!ctx.sessionId) return false;
  await db
    .collection("staff_sessions")
    .updateOne(
      { id: ctx.sessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  // GraphQL mutation fields execute serially with the same context. Later
  // fields must not retain permissions after this logout has completed.
  delete ctx.user;
  delete ctx.sessionId;
  return true;
}
