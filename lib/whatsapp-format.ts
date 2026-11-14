// ============================================================
// Formato de WhatsApp
// ============================================================
// El modelo escribe en Markdown por costumbre (**negrita**, # títulos,
// [texto](url)). WhatsApp tiene su propio formato: *negrita*, _cursiva_,
// ~tachado~. Con Markdown, el usuario ve los asteriscos sueltos. Esta
// conversión se aplica a toda respuesta del agente antes de enviarla.

export function formatForWhatsApp(text: string): string {
  return (
    text
      // **negrita** y __negrita__ → *negrita*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      // ~~tachado~~ → ~tachado~
      .replace(/~~(.+?)~~/g, "~$1~")
      // Títulos Markdown → línea en negrita
      .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "*$1*")
      // [texto](url) → texto (url)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
      // Separadores horizontales de Markdown
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
      // Negrita vacía o doble que quedó de casos raros: ** → nada
      .replace(/\*{2,}/g, "*")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
