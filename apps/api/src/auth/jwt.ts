import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface SessionToken {
  sub: string; // userId
  sid: string; // sessionId
}

/**
 * Pinned so verification can never be talked into a different scheme by
 * the token's own `alg` header. Not exploitable today (a string secret
 * means jsonwebtoken only ever does HMAC), but algorithm confusion is
 * the classic JWT failure and pinning costs one line.
 */
const ALGORITHM = "HS256" as const;

export function signSession(payload: SessionToken): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: `${config.SESSION_TTL_HOURS}h`,
    issuer: "cofemine-panel",
  });
}

export function verifySession(token: string): SessionToken {
  const decoded = jwt.verify(token, config.JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: "cofemine-panel",
  }) as SessionToken;
  return { sub: decoded.sub, sid: decoded.sid };
}
