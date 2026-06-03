// Normaliza un nombre de empresa para comparar de forma robusta entre lo que
// dicta el usuario y lo que devuelve el CRM: minúsculas, sin acentos, sin
// sufijos legales (S.A.S., S.A., Ltda., Inc., LLC) y sin puntuación. Así
// "Vittal Medica S.A.S." y "Vittal Médica SAS" matchean igual.
export function normalizeCompanyName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/\b(s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?|ltda\.?|inc\.?|llc\.?)\b/g, "") // sufijos legales
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Decide si alguno de los nombres candidatos del CRM corresponde al nombre
// buscado. Igualdad exacta normalizada, o contención en cualquier dirección
// (para tolerar nombres parciales), exigiendo un mínimo de longitud para
// evitar falsos positivos por tokens muy cortos.
export function companyMatches(query: string, candidateNames: string[]): boolean {
  const target = normalizeCompanyName(query);
  if (!target) return false;
  return candidateNames.some((c) => {
    const cand = normalizeCompanyName(c);
    if (!cand) return false;
    if (cand === target) return true;
    return target.length > 3 && (cand.includes(target) || target.includes(cand));
  });
}
