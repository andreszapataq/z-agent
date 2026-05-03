// ============================================================
// CRM Adapter Interface
// ============================================================
// Cada CRM (HubSpot, nativo, Salesforce, etc.) implementa esta
// misma interfaz. El agente nunca sabe qué CRM hay debajo.
// ============================================================

export type Contact = {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
};

export type Deal = {
  id: string;
  name: string;
  stage: string;
  amount?: number;
  contactId?: string;
};

export type DealStage = "saludo" | "presentación" | "propuesta" | "cierre" | "perdido";

export interface CrmAdapter {
  searchContact(query: string): Promise<Contact[]>;
  createContact(input: { name: string; company?: string; email?: string; phone?: string }): Promise<Contact>;
  searchDeal(query: string): Promise<Deal[]>;
  moveDeal(dealId: string, stage: DealStage): Promise<string>;
  createNote(contactId: string, body: string): Promise<string>;
  createTask(contactId: string, title: string, dueDate: string): Promise<string>;
}
