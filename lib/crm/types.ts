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
  jobtitle?: string;
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

export type Company = {
  id: string;
  name: string;
  domain?: string;
};

// Resultado por cada nombre buscado en searchCompany.
// - "exists": match confiable (sufijo legal ignorado, nombre normalizado).
// - "possible": la búsqueda trajo candidato(s) parecidos pero NO idénticos
//   (p.ej. "Clínica Porto Azul" → "Clínica Portoazul Auna"). El agente debe
//   mostrarlos y pedir confirmación al usuario, no afirmar la equivalencia.
// - "not_found": ni con búsqueda laxa apareció nada.
// - "error": fallo de la consulta (p.ej. 429/403); nunca asumir existencia.
export type CompanySearchResult = {
  query: string;
  status: "exists" | "possible" | "not_found" | "error";
  matches: Company[];
  error?: string;
};

export type DealStage =
  | "saludo"
  | "presentación"
  | "propuesta"
  | "negociación"
  | "cierre"
  | "perdido";

export type TaskPriority = "baja" | "media" | "alta";

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
  searchCompany(names: string[]): Promise<CompanySearchResult[]>;
  createContact(input: { name: string; company?: string; email?: string; phone?: string; jobtitle?: string }): Promise<Contact>;
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
    priority?: TaskPriority;
  }): Promise<string>;
  listTasks(input: {
    fromDate: string;
    toDate: string;
    includeCompleted?: boolean;
  }): Promise<TaskItem[]>;
  completeTask(taskId: string): Promise<string>;
  listStages(): Promise<StageInfo[]>;
}
