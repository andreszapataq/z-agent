// ============================================================
// Tokens de tenant: enmascarado para el panel de administración
// ============================================================
// El panel nunca recibe un token completo. Las rutas de /api/admin devuelven
// los tokens enmascarados ("pat-na…1234") y, al guardar, un token solo se
// sobrescribe si llega con un valor nuevo. El código interno (agente, crons,
// envío de WhatsApp) sigue leyendo los tokens completos con getTenant /
// getTenantByPhone, que no pasan por aquí.

export const TOKEN_FIELDS = ["whatsapp_token", "hubspot_token"] as const;
export type TokenField = (typeof TOKEN_FIELDS)[number];

const MASK = "…";

// Primeros 6 caracteres, "…" y últimos 4. Vacío → null. Para un valor
// demasiado corto (que no debería existir) solo se muestran 2 caracteres,
// para no revelar casi todo el token.
export function maskToken(token: string | null | undefined): string | null {
  if (!token) return null;
  if (token.length < 20) return `${MASK}${token.slice(-2)}`;
  return `${token.slice(0, 6)}${MASK}${token.slice(-4)}`;
}

export function maskTenantTokens<T extends Partial<Record<TokenField, string | null>>>(tenant: T): T {
  const out = { ...tenant };
  for (const field of TOKEN_FIELDS) {
    if (field in out) out[field] = maskToken(out[field]) as T[TokenField];
  }
  return out;
}

// ¿El valor recibido del panel significa "no cambies el token"? Sí si llega
// vacío, null, ausente, igual al texto enmascarado del token actual, o con
// el carácter de máscara (ningún token real lo contiene).
export function keepsCurrentToken(incoming: unknown, current: string | null | undefined): boolean {
  if (incoming === undefined || incoming === null) return true;
  if (typeof incoming !== "string") return true;
  const value = incoming.trim();
  if (!value) return true;
  if (value.includes(MASK)) return true;
  return value === maskToken(current);
}

// Quita del payload los tokens que no cambian, para que el upsert conserve
// el valor guardado (PostgREST solo actualiza las columnas que recibe).
export function dropUnchangedTokens<T extends Partial<Record<TokenField, unknown>>>(
  input: T,
  current: Partial<Record<TokenField, string | null>> | null
): T {
  const out = { ...input };
  for (const field of TOKEN_FIELDS) {
    if (keepsCurrentToken(out[field], current?.[field])) delete out[field];
    else out[field] = (out[field] as string).trim() as T[TokenField];
  }
  return out;
}
