import { NextRequest, NextResponse } from "next/server";
import { getTenantByPhone } from "@/lib/tenants";
import { processMessage } from "@/lib/agent";
import { sendWhatsAppMessage, verifyMetaSignature } from "@/lib/whatsapp";

// Meta requiere verificación inicial del webhook (GET)
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

// Mensajes entrantes (POST)
export async function POST(req: NextRequest) {
  // Leer el body como texto para poder verificar la firma sobre el cuerpo crudo
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  if (!verifyMetaSignature(rawBody, signature)) {
    console.warn("[webhook] firma inválida o ausente");
    return new NextResponse("Forbidden", { status: 403 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  // Procesar de forma asíncrona — Meta debe recibir 200 rápido
  processIncomingMessage(body).catch((err) =>
    console.error("[webhook error]", err)
  );

  return NextResponse.json({ ok: true });
}

async function processIncomingMessage(body: any) {
  const change = body?.entry?.[0]?.changes?.[0];
  const message = change?.value?.messages?.[0];
  const phoneNumberId = change?.value?.metadata?.phone_number_id;

  if (!message || message.type !== "text") return;
  if (!phoneNumberId) return;

  const tenant = await getTenantByPhone(phoneNumberId);
  if (!tenant) return;

  // Solo el owner del tenant puede activar el agente
  if (message.from !== tenant.owner_number) return;

  const reply = await processMessage(message.text.body, tenant);

  if (tenant.whatsapp_phone_id && tenant.whatsapp_token) {
    await sendWhatsAppMessage(
      tenant.whatsapp_phone_id,
      tenant.whatsapp_token,
      message.from,
      reply
    );
  }
}

// Configuración para el endpoint
export const maxDuration = 60;
export const dynamic = "force-dynamic";
