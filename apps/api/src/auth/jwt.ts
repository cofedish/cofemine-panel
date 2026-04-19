import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface SessionToken {
  sub: string; // userId
  sid: string; // sessionId
}

export function signSession(payload: SessionToken): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: `${config.SESSION_TTL_HOURS}h`,
    issuer: "cofemine-panel",
  });
}

export function verifySession(token: string): SessionToken {
  const decoded = jwt.verify(token, config.JWT_SECRET, {
    issuer: "cofemine-panel",
  }) as SessionToken;
  return { sub: decoded.sub, sid: decoded.sid };
}
