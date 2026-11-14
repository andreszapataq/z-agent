// ============================================================
// Quién puede hablar con el agente
// ============================================================
// Cada tenant tiene un número principal (`owner_number`, el que además
// recibe el resumen diario) y una lista de números adicionales autorizados
// (`authorized_numbers`), p.ej. quien administra el agente para hacer pruebas
// o un asistente comercial. Todos los números van en formato E.164 sin "+".
// Cada número tiene su propia memoria de conversación (se guarda por teléfono).

export function digitsOnly(n: string | null | undefined): string {
  return String(n || "").replace(/\D/g, "");
}

export function isAuthorizedSender(
  tenant: { owner_number: string | null; authorized_numbers?: string[] | null },
  from: string | null | undefined
): boolean {
  const sender = digitsOnly(from);
  if (!sender) return false;
  const allowed = [tenant.owner_number, ...(tenant.authorized_numbers || [])]
    .map(digitsOnly)
    .filter(Boolean);
  return allowed.includes(sender);
}

// Convierte el texto del panel ("57300…, 57311…") en una lista limpia.
export function parseNumberList(text: string): string[] {
  return Array.from(
    new Set(
      String(text || "")
        .split(/[,;\n]+/)
        .map(digitsOnly)
        .filter(Boolean)
    )
  );
}
