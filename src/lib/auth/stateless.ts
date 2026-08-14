import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SignedPayload {
  v: 1;
  typ: "access" | "refresh" | "code" | "state";
  sub?: number;
  login?: string;
  cid?: string;
  ruri?: string;
  cstate?: string;
  scp?: string[];
  res?: string;
  cc?: string;
  ccm?: string;
  nonce?: string;
  iat: number;
  exp: number;
}

const PREFIX: Record<SignedPayload["typ"], string> = {
  access: "ifa_",
  refresh: "ifr_",
  code: "ifc_",
  state: "ifs_",
};

function base64url(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

function unbase64url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueSignedPayload(
  secret: string,
  payload: SignedPayload,
): string {
  const withNonce = { ...payload, nonce: randomBytes(12).toString("base64url") };
  const body = base64url(JSON.stringify(withNonce));
  return `${PREFIX[payload.typ]}${body}.${sign(secret, body)}`;
}

export function verifySignedPayload<T extends SignedPayload["typ"]>(
  secret: string,
  token: string,
  expectedType: T,
): (SignedPayload & { typ: T }) | null {
  const prefix = PREFIX[expectedType];
  if (!token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: SignedPayload;
  try {
    payload = JSON.parse(unbase64url(body)) as SignedPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || payload.typ !== expectedType) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    return null;
  }
  return payload as SignedPayload & { typ: T };
}

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60 * 5;
export const UPSTREAM_STATE_TTL_SECONDS = 60 * 10;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
