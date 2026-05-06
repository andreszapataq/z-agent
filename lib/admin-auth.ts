import crypto from "crypto";
import { NextRequest } from "next/server";

export const ADMIN_COOKIE = "z-admin-session";

function timingSafeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Hash determinístico del secret. Lo guardamos en la cookie en lugar del secret
// crudo para que un XSS o leak de cookie no exponga directamente la contraseña.
export function sessionTokenFor(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function isValidSecret(input: string | null | undefined): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected || !input) return false;
  return timingSafeEq(input, expected);
}

export function isAuthenticated(req: NextRequest): boolean {
  const cookie = req.cookies.get(ADMIN_COOKIE)?.value;
  if (!cookie) return false;
  const expected = process.env.ADMIN_SECRET;
  if (!expected) return false;
  return timingSafeEq(cookie, sessionTokenFor(expected));
}

// Cookie de 12h, HttpOnly, SameSite=Lax, Secure en producción
export function buildSessionCookie(secret: string) {
  return {
    name: ADMIN_COOKIE,
    value: sessionTokenFor(secret),
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  };
}

export function clearedSessionCookie() {
  return {
    name: ADMIN_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  };
}
