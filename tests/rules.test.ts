import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  parsePhone, routePhones, phoneSearchKey, cleanPersonName, normalizeCity,
  normalizeEspecialidad, normalizeEmail, cleanCompanyName, normalizeDomain, ValidationError,
} from "../lib/crm/contact-rules";
import { formatSharedContacts } from "../lib/inbound";
import { apiBase, authHeaders, credsFromTenant, isKapsoHost, verifyKapsoSignature, verifyMetaSignature } from "../lib/whatsapp";

test("celulares y fijos", () => {
  assert.deepEqual(parsePhone("310 123 4567"), { value: "+573101234567", kind: "mobile" });
  assert.deepEqual(parsePhone("+57 310 123 4567"), { value: "+573101234567", kind: "mobile" });
  assert.deepEqual(parsePhone("573101234567"), { value: "+573101234567", kind: "mobile" });
  assert.deepEqual(parsePhone("604 4446152 ext 2166"), { value: "+576044446152 ext. 2166", kind: "landline" });
  assert.deepEqual(parsePhone("(602) 308-7784 extensión 12"), { value: "+576023087784 ext. 12", kind: "landline" });
  assert.deepEqual(parsePhone("+1 305 555 0100"), { value: "+13055550100", kind: "foreign" });
  assert.throws(() => parsePhone("4446152"), ValidationError);
  assert.throws(() => parsePhone("310 123 456"), ValidationError);
  assert.throws(() => parsePhone("3101234567 ext 4"), ValidationError);
});

test("reparto Móvil / Teléfono sin importar el campo", () => {
  assert.deepEqual(routePhones({ phone: "3101234567" }), { mobilephone: "+573101234567" });
  assert.deepEqual(routePhones({ mobile: "6044446152" }), { phone: "+576044446152" });
  assert.deepEqual(routePhones({ mobile: "3101234567", phone: "604 4446152 ext. 5" }), {
    mobilephone: "+573101234567", phone: "+576044446152 ext. 5",
  });
  assert.deepEqual(routePhones({}), {});
});

test("búsqueda por número", () => {
  assert.equal(phoneSearchKey("310 123 4567"), "+573101234567");
  assert.equal(phoneSearchKey("Juan Pérez"), null);
  assert.equal(phoneSearchKey("1234"), null);
});

test("nombres", () => {
  assert.equal(cleanPersonName("dr. juan carlos"), "Juan Carlos");
  assert.equal(cleanPersonName("PÉREZ DE LA CRUZ"), "Pérez de la Cruz");
  assert.equal(cleanPersonName("Asistente del Dr. Julian Escobar"), "Asistente del Dr. Julian Escobar");
  assert.equal(cleanPersonName("  María   José "), "María José");
  assert.equal(cleanPersonName(""), undefined);
});

test("ciudades, especialidad, correo", () => {
  assert.equal(normalizeCity("bogota"), "Bogotá");
  assert.equal(normalizeCity("MEDELLIN"), "Medellín");
  assert.equal(normalizeCity("Neiva"), "Neiva");
  assert.equal(normalizeCity("santa rosa de cabal"), "Santa Rosa de Cabal");
  assert.equal(normalizeEspecialidad("neurocirugia"), "Neurocirugía");
  assert.equal(normalizeEspecialidad("cirugía plástica"), "Cirugía plástica");
  assert.throws(() => normalizeEspecialidad("Odontología"), /fuera del alcance/);
  assert.throws(() => normalizeEspecialidad("Ortopedista"), /no es una especialidad válida/);
  assert.equal(normalizeEmail(" Juan@Clinica.COM "), "juan@clinica.com");
  assert.throws(() => normalizeEmail("juan@"), ValidationError);
});

test("empresas", () => {
  assert.equal(cleanCompanyName("Clínica Medilaser S.A.S."), "Clínica Medilaser");
  assert.equal(cleanCompanyName("clinica medilaser - neiva"), "Clinica Medilaser Neiva");
  assert.equal(cleanCompanyName("Hospital San Rafael E.S.E."), "Hospital San Rafael E.S.E.");
  assert.equal(cleanCompanyName("Sportmeds Ltda"), "Sportmeds");
  assert.equal(normalizeDomain("https://www.clinica.com.co/contacto"), "clinica.com.co");
});

test("contacto compartido de WhatsApp", () => {
  const text = formatSharedContacts([
    {
      name: { formatted_name: "Juan Pérez", first_name: "Juan", last_name: "Pérez" },
      org: { company: "Clínica Medilaser", title: "Ortopedista" },
      phones: [{ phone: "+57 310 1234567", type: "CELL", wa_id: "573101234567" }],
      emails: [{ email: "juan@medilaser.co" }],
    },
  ]);
  assert.match(text, /^📇 Contacto compartido:/);
  assert.match(text, /Nombre: Juan Pérez/);
  assert.match(text, /Cargo: Ortopedista/);
  assert.match(text, /Teléfono \(CELL\): \+57 310 1234567 \[tiene WhatsApp\]/);
  assert.equal(formatSharedContacts([]), "");
});

test("canal Meta / Kapso", () => {
  const k = credsFromTenant({ whatsapp_phone_id: "123", whatsapp_token: "key", whatsapp_provider: "kapso" })!;
  assert.equal(apiBase(k.provider), "https://app.kapso.ai/api/meta/v22.0");
  assert.deepEqual(authHeaders(k), { "X-API-Key": "key" });
  const m = credsFromTenant({ whatsapp_phone_id: "123", whatsapp_token: "tok", whatsapp_provider: null })!;
  assert.equal(apiBase(m.provider), "https://graph.facebook.com/v22.0");
  assert.deepEqual(authHeaders(m), { Authorization: "Bearer tok" });
  assert.equal(credsFromTenant({ whatsapp_phone_id: null, whatsapp_token: "x" }), null);
  assert.equal(isKapsoHost("https://api.kapso.ai/storage/media/a.jpg"), true);
  assert.equal(isKapsoHost("https://lookaside.fbsbx.com/x"), false);
});

test("firmas del webhook", () => {
  const body = '{"entry":[]}';
  process.env.KAPSO_WEBHOOK_SECRET = "s3cret";
  const hex = crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifyKapsoSignature(body, hex), true);
  assert.equal(verifyKapsoSignature(body, "deadbeef"), false);
  assert.equal(verifyKapsoSignature(body, null), false);
  process.env.META_APP_SECRET = "app";
  const meta = "sha256=" + crypto.createHmac("sha256", "app").update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, meta), true);
  assert.equal(verifyMetaSignature(body + " ", meta), false);
});

import { isAuthorizedSender, parseNumberList } from "../lib/authorized";

test("números autorizados", () => {
  const t = { owner_number: "573001112233", authorized_numbers: ["573104445566"] };
  assert.equal(isAuthorizedSender(t, "573001112233"), true);
  assert.equal(isAuthorizedSender(t, "573104445566"), true);
  assert.equal(isAuthorizedSender(t, "573109999999"), false);
  assert.equal(isAuthorizedSender(t, null), false);
  assert.equal(isAuthorizedSender({ owner_number: "573001112233" }, "573001112233"), true);
  assert.equal(isAuthorizedSender({ owner_number: null, authorized_numbers: [] }, "573001112233"), false);
  assert.deepEqual(parseNumberList("+57 300 1112233, 573104445566;573104445566"), ["573001112233", "573104445566"]);
  assert.deepEqual(parseNumberList(""), []);
});
