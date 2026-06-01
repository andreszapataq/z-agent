// ============================================================
// Phone normalization
// ============================================================
// El agente recibe teléfonos dictados por WhatsApp ("311 2282908",
// "Cel: 311 2282908"), casi siempre sin código de país. Los CRMs
// (HubSpot) validan y formatean mejor cuando el número llega en
// formato E.164 (+57...). Normalizamos en código para no depender
// de cómo lo pida el usuario ni de que HubSpot lo reformatee al
// editarlo manualmente.
//
// Asunción actual: el producto opera con clientes en Colombia
// (+57). Si onboarding de un tenant en otro país lo requiere, el
// código de país debería volverse configurable por tenant. Por eso
// la lógica es conservadora: solo agrega +57 cuando el patrón es
// inequívocamente colombiano; en cualquier otro caso deja el número
// tal cual (nunca lo corrompe).

const CO_COUNTRY_CODE = "57";

export function normalizePhone(raw?: string): string | undefined {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Ya viene en formato internacional → respetarlo.
  if (trimmed.startsWith("+")) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;

  // 57 + 10 dígitos: tiene el indicativo pero sin el "+".
  if (digits.length === 12 && digits.startsWith(CO_COUNTRY_CODE)) {
    return `+${digits}`;
  }

  // Número colombiano de 10 dígitos: celular (3XX...) o fijo
  // nacional unificado (60X...). Solo estos dos casos son
  // inequívocamente CO; el resto se deja sin tocar.
  if (digits.length === 10 && (digits.startsWith("3") || digits.startsWith("6"))) {
    return `+${CO_COUNTRY_CODE}${digits}`;
  }

  // Formato desconocido (extranjero, fijo viejo de 7 dígitos, etc.):
  // no adivinamos, devolvemos lo dictado.
  return trimmed;
}
