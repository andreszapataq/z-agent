// ============================================================
// CRM Adapter Interface
// ============================================================
// Cada CRM (HubSpot, nativo, Salesforce, etc.) implementa esta
// misma interfaz. El agente nunca sabe qué CRM hay debajo.
// ============================================================

export type Contact = {
  id: string;
  name: string;
  firstname?: string;
  lastname?: string;
  company?: string;
  companyId?: string;
  email?: string;
  // Teléfono fijo (o el único teléfono en CRMs sin campo de celular)
  phone?: string;
  // Celular
  mobile?: string;
  jobtitle?: string;
  especialidad?: string;
  city?: string;
};

// Datos para crear un contacto. Las reglas de formato (teléfonos, nombres,
// ciudad, especialidad) se validan en código: ver `contact-rules.ts`.
export type ContactInput = {
  firstname: string;
  lastname?: string;
  // ID de la empresa en el CRM (de search_company / create_company).
  companyId?: string;
  // Nombre de la empresa como texto (solo CRM nativo, que no tiene objeto Empresa).
  company?: string;
  email?: string;
  mobile?: string;
  phone?: string;
  jobtitle?: string;
  especialidad?: string;
  city?: string;
  // El usuario confirmó que es una persona distinta del posible duplicado.
  allowDuplicate?: boolean;
  // El usuario confirmó que el contacto no tiene empresa.
  withoutCompany?: boolean;
};

export type ContactUpdate = Partial<Omit<ContactInput, "allowDuplicate" | "withoutCompany">>;

export type CreateContactResult =
  | { status: "created"; contact: Contact }
  | { status: "possible_duplicate"; matches: Contact[]; message: string };

export type CompanyInput = {
  name: string;
  city?: string;
  phone?: string;
  domain?: string;
  // Casa matriz, cuando la empresa es una sede.
  parentCompanyId?: string;
  allowDuplicate?: boolean;
};

export type CreateCompanyResult =
  | { status: "created"; company: Company }
  | { status: "possible_duplicate"; matches: Company[]; message: string };

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
  city?: string;
  parentName?: string;
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
  createContact(input: ContactInput): Promise<CreateContactResult>;
  updateContact(contactId: string, input: ContactUpdate): Promise<Contact>;
  createCompany(input: CompanyInput): Promise<CreateCompanyResult>;
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
    isAppointment?: boolean;
  }): Promise<string>;
  listTasks(input: {
    fromDate: string;
    toDate: string;
    includeCompleted?: boolean;
  }): Promise<TaskItem[]>;
  completeTask(taskId: string): Promise<string>;
  listStages(): Promise<StageInfo[]>;
}
