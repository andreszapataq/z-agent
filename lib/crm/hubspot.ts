import axios, { AxiosInstance } from "axios";
import { CrmAdapter, Contact, Deal, DealStage } from "./types";

const HUBSPOT_STAGE_MAP: Record<DealStage, string> = {
  saludo: "appointmentscheduled",
  "presentación": "qualifiedtobuy",
  propuesta: "presentationscheduled",
  cierre: "closedwon",
  perdido: "closedlost",
};

export class HubSpotAdapter implements CrmAdapter {
  private client: AxiosInstance;

  constructor(token: string) {
    this.client = axios.create({
      baseURL: "https://api.hubapi.com",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async searchContact(query: string): Promise<Contact[]> {
    const res = await this.client.post("/crm/v3/objects/contacts/search", {
      filterGroups: [
        {
          filters: [
            { propertyName: "company", operator: "CONTAINS_TOKEN", value: query },
          ],
        },
      ],
      properties: ["firstname", "lastname", "email", "company", "phone"],
      limit: 5,
    });

    return (res.data.results || []).map((c: any) => ({
      id: c.id,
      name: `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim() || "(sin nombre)",
      company: c.properties.company,
      email: c.properties.email,
      phone: c.properties.phone,
    }));
  }

  async createContact(input: { name: string; company?: string; email?: string; phone?: string }): Promise<Contact> {
    const [firstname, ...rest] = input.name.split(" ");
    const lastname = rest.join(" ");

    const res = await this.client.post("/crm/v3/objects/contacts", {
      properties: {
        firstname,
        lastname,
        company: input.company,
        email: input.email,
        phone: input.phone,
      },
    });

    return {
      id: res.data.id,
      name: input.name,
      company: input.company,
      email: input.email,
      phone: input.phone,
    };
  }

  async searchDeal(query: string): Promise<Deal[]> {
    const res = await this.client.post("/crm/v3/objects/deals/search", {
      filterGroups: [
        {
          filters: [
            { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: query },
          ],
        },
      ],
      properties: ["dealname", "dealstage", "amount"],
      limit: 5,
    });

    return (res.data.results || []).map((d: any) => ({
      id: d.id,
      name: d.properties.dealname,
      stage: d.properties.dealstage,
      amount: d.properties.amount ? parseFloat(d.properties.amount) : undefined,
    }));
  }

  async moveDeal(dealId: string, stage: DealStage): Promise<string> {
    const stageId = HUBSPOT_STAGE_MAP[stage] || stage;
    await this.client.patch(`/crm/v3/objects/deals/${dealId}`, {
      properties: { dealstage: stageId },
    });
    return `Deal movido a "${stage}"`;
  }

  async createNote(contactId: string, body: string): Promise<string> {
    await this.client.post("/crm/v3/objects/notes", {
      properties: {
        hs_note_body: body,
        hs_timestamp: Date.now(),
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
        },
      ],
    });
    return "Nota registrada en HubSpot";
  }

  async createTask(contactId: string, title: string, dueDate: string): Promise<string> {
    await this.client.post("/crm/v3/objects/tasks", {
      properties: {
        hs_task_subject: title,
        hs_task_status: "NOT_STARTED",
        hs_timestamp: new Date(dueDate).getTime(),
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
        },
      ],
    });
    return `Tarea "${title}" creada en HubSpot`;
  }
}
