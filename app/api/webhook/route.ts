import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getTenantByPhone } from "@/lib/tenants";
import { processMessage } from "@/lib/agent";
import {
  credsFromTenant,
  markReadWithTyping,
  sendWhatsAppMessage,
  verifyKapsoSignature,
  verifyMetaSignature,
} from "@/lib/whatsapp";
import { toAgentInput } from "@/lib/inbound";
import { firstTimeSeen } from "@/lib/dedupe";
import { checkLimit, webhookLimiter } from "@/lib/ratelimit";

// Meta requiere verificación inicial del webhook (GET). Con Kapso no aplica:
// Kapso recibe el webhook de Meta y nos reenvía el payload por POST.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

// Mensajes entrantes (POST). Llegan con el formato de la Cloud API de Meta,
// ya sea directo de Meta (firma `x-hub-signature-256`) o reenviados por un
// webhook tipo "meta" de Kapso (firma `x-webhook-signature`).
export async function POST(req: NextRequest) {
  // Leer el body como texto para poder verificar la firma sobre el cuerpo crudo
  const rawBody = await req.text();
  const kapsoSig = req.headers.get("x-webhook-signature");
  const valid = kapsoSig
    ? verifyKapsoSignature(rawBody, kapsoSig)
    : verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"));

  if (!valid) {
    console.warn(`[webhook] firma inválida o ausente (${kapsoSig ? "kapso" : "meta"})`);
    return new NextResponse("Forbidden", { status: 403 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  // Meta espera un 200 en < 20 s y Kapso en < 10 s, pero el loop del agente
  // (modelo + CRM + respuesta) puede tardar más. `waitUntil` mantiene viva la
  // función mientras la respuesta ya viajó.
  waitUntil(
    processIncomingMessage(body).catch((err) => console.error("[webhook error]", err))
  );

  return NextResponse.json({ ok: true });
}

async function processIncomingMessage(body: any) {
  const change = body?.entry?.[0]?.changes?.[0];
  const message = change?.value?.messages?.[0];
  const phoneNumberId = change?.value?.metadata?.phone_number_id;

  // Eventos sin mensaje (estados de entrega, etc.) se ignoran.
  if (!message || !phoneNumberId) return;

  // Reintentos de Meta/Kapso: cada message.id se procesa una sola vez.
  if (message.id && !(await firstTimeSeen(message.id))) return;

  // Rate limit por phone_number_id (tenant). Si excede, no procesamos.
  const limit = await checkLimit(webhookLimiter, phoneNumberId);
  if (!limit.ok) {
    console.warn("[webhook] rate limit excedido para", phoneNumberId);
    return;
  }

  const tenant = await getTenantByPhone(phoneNumberId);
  if (!tenant) return;

  // Solo el owner del tenant puede activar el agente
  if (!message.from || message.from !== tenant.owner_number) return;

  const creds = credsFromTenant(tenant);
  if (!creds) return;

  if (message.id) await markReadWithTyping(creds, message.id);

  const inbound = await toAgentInput(message, creds);
  const reply = inbound.ok
    ? await processMessage(inbound.input, tenant, message.from)
    : inbound.reply;

  await sendWhatsAppMessage(creds, message.from, reply);
}

// Configuración para el endpoint
export const maxDuration = 60;
export const dynamic = "force-dynamic";
