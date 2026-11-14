import { test } from "node:test";
import assert from "node:assert/strict";
import { formatForWhatsApp } from "../lib/whatsapp-format";
import { summarizeTool, annotateWithTrace } from "../lib/tool-trace";

test("Markdown → formato de WhatsApp", () => {
  assert.equal(formatForWhatsApp("**Nombre:** Prueba"), "*Nombre:* Prueba");
  assert.equal(formatForWhatsApp("*Dr. Luis* · Ortopedia"), "*Dr. Luis* · Ortopedia");
  assert.equal(formatForWhatsApp("## Resumen\nTexto"), "*Resumen*\nTexto");
  assert.equal(formatForWhatsApp("Ver [HubSpot](https://app.hubspot.com/x)"), "Ver HubSpot (https://app.hubspot.com/x)");
  assert.equal(formatForWhatsApp("a\n---\nb"), "a\n\nb");
  assert.equal(formatForWhatsApp("~~viejo~~ nuevo"), "~viejo~ nuevo");
  assert.equal(formatForWhatsApp("• uno\n- dos"), "• uno\n- dos");
});

test("resumen de herramientas", () => {
  assert.equal(
    summarizeTool("search_contact", { query: "Prueba Zapata" }, "[]", false),
    'search_contact("Prueba Zapata") → 0 resultado(s)'
  );
  assert.equal(
    summarizeTool("create_contact", {}, JSON.stringify({ status: "created", contact: { id: "77", name: "Prueba Zapata" } }), false),
    "create_contact → creado: Prueba Zapata #77"
  );
  assert.match(
    summarizeTool("create_contact", {}, JSON.stringify({ status: "possible_duplicate", matches: [{ id: "77", name: "Prueba Zapata" }] }), false),
    /NO creado, posible duplicado: Prueba Zapata #77/
  );
  assert.equal(
    summarizeTool("search_company", { names: ["Rodilla"] }, JSON.stringify([{ query: "Rodilla", status: "exists", matches: [{ id: "9", name: "Clínica de la Rodilla" }] }]), false),
    "search_company → Rodilla: exists (Clínica de la Rodilla #9)"
  );
  assert.equal(summarizeTool("move_deal", {}, "Error: 404", true), "move_deal: Error: 404");
});

test("historial anotado", () => {
  assert.equal(annotateWithTrace("Hola", undefined), "Hola");
  const out = annotateWithTrace("Listo", ["create_contact → creado: X #1"]);
  assert.match(out, /^Listo\n\n\[Registro interno/);
  assert.match(out, /- create_contact → creado: X #1\]$/);
});
