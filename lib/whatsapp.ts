import axios from "axios";

export async function sendWhatsAppMessage(
  phoneId: string,
  token: string,
  to: string,
  text: string
): Promise<void> {
  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
}
