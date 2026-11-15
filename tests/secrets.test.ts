import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { safeError, toSafeError, type SafeHttpError } from "../lib/safe-error";
import { maskToken, maskTenantTokens, keepsCurrentToken, dropUnchangedTokens } from "../lib/tenant-secrets";

// Valores falsos, armados en tiempo de ejecución para que no parezcan secretos.
const FAKE_TOKEN = "tok" + "_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const OTHER_TOKEN = "tok" + "_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210";

function fakeAxiosError(status: number, data: unknown) {
  const config = { headers: new AxiosHeaders({ Authorization: "Bearer " + FAKE_TOKEN, "X-API-Key": FAKE_TOKEN }) } as InternalAxiosRequestConfig;
  const request = { _header: "POST /x HTTP/1.1\r\nAuthorization: Bearer " + FAKE_TOKEN };
  const response: AxiosResponse = { status, statusText: "", data, headers: {}, config };
  return new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", config, request, response);
}

test("maskToken: 6 primeros + … + 4 últimos; vacío → null", () => {
  assert.equal(maskToken(FAKE_TOKEN), "tok_AB…6789");
  assert.equal(maskToken(""), null);
  assert.equal(maskToken(null), null);
  assert.equal(maskToken(undefined), null);
  // Valor corto: no revela casi todo el token
  assert.equal(maskToken("abcdefghij"), "…ij");
});

test("maskTenantTokens enmascara ambos tokens y no toca lo demás", () => {
  const t = { id: "x", name: "X", whatsapp_token: FAKE_TOKEN, hubspot_token: null, owner_number: "573000000000" };
  const masked = maskTenantTokens(t);
  assert.equal(masked.whatsapp_token, "tok_AB…6789");
  assert.equal(masked.hubspot_token, null);
  assert.equal(masked.owner_number, "573000000000");
  assert.equal(t.whatsapp_token, FAKE_TOKEN, "no muta el original");
  assert.ok(!JSON.stringify(masked).includes(FAKE_TOKEN));
});

test("keepsCurrentToken: vacío, null o enmascarado conservan el token actual", () => {
  assert.equal(keepsCurrentToken(undefined, FAKE_TOKEN), true);
  assert.equal(keepsCurrentToken(null, FAKE_TOKEN), true);
  assert.equal(keepsCurrentToken("", FAKE_TOKEN), true);
  assert.equal(keepsCurrentToken("   ", FAKE_TOKEN), true);
  assert.equal(keepsCurrentToken(maskToken(FAKE_TOKEN), FAKE_TOKEN), true);
  assert.equal(keepsCurrentToken("tok_AB…0000", FAKE_TOKEN), true, "cualquier texto con … es una máscara");
  assert.equal(keepsCurrentToken(OTHER_TOKEN, FAKE_TOKEN), false);
});

test("dropUnchangedTokens: guardar el formulario sin tocar tokens no los envía", () => {
  const current = { whatsapp_token: FAKE_TOKEN, hubspot_token: OTHER_TOKEN };
  const out = dropUnchangedTokens(
    { name: "X", whatsapp_token: null, hubspot_token: maskToken(OTHER_TOKEN) },
    current
  );
  assert.deepEqual(out, { name: "X" }, "las columnas de token no viajan en el upsert");

  const changed = dropUnchangedTokens({ whatsapp_token: `  ${OTHER_TOKEN}  `, hubspot_token: "" }, current);
  assert.deepEqual(changed, { whatsapp_token: OTHER_TOKEN }, "solo viaja el token nuevo, sin espacios");
});

test("safeError: solo message, status y data; nunca cabeceras ni request", () => {
  const err = fakeAxiosError(400, { message: "Property values were not valid", errors: [{ name: "phone" }] });
  const safe = safeError(err);
  assert.equal(safe.message, "Request failed with status code 400");
  assert.equal(safe.status, 400);
  assert.deepEqual(safe.data, { message: "Property values were not valid", errors: [{ name: "phone" }] });
  assert.deepEqual(Object.keys(safe).sort(), ["data", "message", "status"]);
  for (const out of [JSON.stringify(safe), inspect(safe, { depth: 10 })]) {
    assert.ok(!out.includes(FAKE_TOKEN));
    assert.ok(!out.includes("Bearer"));
  }
});

test("safeError recorta data larga y resume binarios", () => {
  const long = fakeAxiosError(500, { blob: "x".repeat(5000) });
  const d = safeError(long, 1000).data as string;
  assert.equal(typeof d, "string");
  assert.ok(d.length <= 1001);

  const bin = fakeAxiosError(404, Buffer.from("abc"));
  assert.equal(safeError(bin).data, "[binario, 3 bytes]");

  assert.deepEqual(safeError(new Error("boom")), { message: "boom" });
  assert.deepEqual(safeError("texto"), { message: "texto" });
  assert.deepEqual(safeError({ status: 429 }), { message: "Error desconocido", status: 429 });
});

test("toSafeError conserva response.status/data y suelta config y request", () => {
  const err = fakeAxiosError(401, { error: { message: "Invalid OAuth access token" } });
  const safe = toSafeError(err) as SafeHttpError & { config?: unknown; request?: unknown; cause?: unknown };
  assert.equal(safe instanceof Error, true);
  assert.equal(safe.message, "Request failed with status code 401");
  assert.equal(safe.response?.status, 401);
  assert.deepEqual(safe.response?.data, { error: { message: "Invalid OAuth access token" } });
  assert.equal(safe.config, undefined);
  assert.equal(safe.request, undefined);
  assert.equal(safe.cause, undefined);
  assert.ok(!inspect(safe, { depth: 10 }).includes(FAKE_TOKEN));

  const plain = new Error("sin http");
  assert.equal(toSafeError(plain), plain, "un error que no es HTTP se devuelve igual");
});

test("control: un AxiosError sin sanear sí expone el token al imprimirse", () => {
  // Documenta por qué existe safeError: si este test deja de cumplirse, axios
  // cambió su forma, pero la regla de no registrar errores crudos se mantiene.
  const err = fakeAxiosError(400, {});
  assert.ok(inspect(err, { depth: 10 }).includes(FAKE_TOKEN));
});
