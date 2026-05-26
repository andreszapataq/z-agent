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
  contactIds?: string[];
  companyId?: string;
};

export type DealStage =
  | "saludo"
  | "presentación"
  | "propuesta"
  | "negociación"
  | "cierre"
  | "perdido";

export type StageInfo = {
  slug: DealStage;
  label: string;
  displayOrder?: number;
};

export type TaskItem = {
  id: string;
  title: string;
  dueDate: string;
  dueTime?: string;
  status: string;
  dealName?: string;
  contactName?: string;
  companyName?: string;
};

export interface CrmAdapter {
  searchContact(query: string): Promise<Contact[]>;
  createContact(input: { name: string; company?: string; email?: string; phone?: string }): Promise<Contact>;
  searchDeal(query: string): Promise<Deal[]>;
  createDeal(input: { contactId: string; name: string; amount?: number; stage?: DealStage }): Promise<Deal>;
  moveDeal(dealId: string, stage: DealStage): Promise<string>;
  createNote(input: { contactId?: string; dealId?: string; body: string }): Promise<string>;
  createTask(input: {
    contactId?: string;
    dealId?: string;
    title: string;
    dueDate: string;
    dueTime?: string;
  }): Promise<string>;
  listTasks(input: {
    fromDate: string;
    toDate: string;
    includeCompleted?: boolean;
  }): Promise<TaskItem[]>;
  listStages(): Promise<StageInfo[]>;
}
