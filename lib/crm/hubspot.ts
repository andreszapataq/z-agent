import axios, { AxiosInstance } from "axios";
import {
  CrmAdapter,
  Company,
  CompanyInput,
  CompanySearchResult,
  Contact,
  ContactInput,
  ContactUpdate,
  CreateCompanyResult,
  CreateContactResult,
  Deal,
  DealStage,
  StageInfo,
  TaskItem,
  TaskPriority,
} from "./types";
import {
  ValidationError,
  cleanCompanyName,
  cleanPersonName,
  normalizeCity,
  normalizeDomain,
  normalizeEmail,
  normalizeEspecialidad,
  normalizeForMatch,
  parsePhone,
  phoneSearchKey,
  routePhones,
} from "./contact-rules";
import { companyMatches, stripLegalSuffix } from "./match";

// Fallback al pipeline default de HubSpot. Cada tenant puede sobrescribir
// con su propio mapeo via `tenant.stage_map`.
export const DEFAULT_HUBSPOT_STAGE_MAP: Record<DealStage, string> = {
  saludo: "appointmentscheduled",
  "presentación": "qualifiedtobuy",
  propuesta: "contractsent",
  "negociación": "decisionmakerboughtin",
  cierre: "closedwon",
  perdido: "closedlost",
};

const CONTACT_PROPS = [
  "firstname",
  "lastname",
  "email",
  "company",
  "phone",
  "mobilephone",
  "jobtitle",
  "especialidad",
  "city",
  "associatedcompanyid",
];

// Cache in-memory de pipelines por token. TTL corto porque corre en serverless
// (cada instancia warm reaprovecha; cold start refetchea). Evita pegarle a
// HubSpot en cada mensaje de WhatsApp solo para resolver labels.
const PIPELINE_CACHE_TTL_MS = 10 * 60 * 1000;
type StageMeta = { label: string; displayOrder: number };
const stageMetaCache = new Map<string, { data: Map<string, StageMeta>; expiresAt: number }>();

export class HubSpotAdapter implements CrmAdapter {
  private client: AxiosInstance;
  private stageMap: Record<string, string>;
  private token: string;
  private ownerId: string | null;

  constructor(token: string, stageMap?: Record<string, string> | null, ownerId?: string | null) {
    this.token = token;
    this.client = axios.create({
      baseURL: "https://api.hubapi.com",
      headers: { Authorization: `Bearer ${token}` },
    });
    // El mapeo del tenant tiene prioridad; lo que falte cae al default.
    this.stageMap = { ...DEFAULT_HUBSPOT_STAGE_MAP, ...(stageMap || {}) };
    this.ownerId = ownerId || null;
  }

  private resolveStage(stage: DealStage): string {
    return this.stageMap[stage] || stage;
  }

  private async getStageMeta(): Promise<Map<string, StageMeta>> {
    const cached = stageMetaCache.get(this.token);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const res = await this.client.get("/crm/v3/pipelines/deals");
    const meta = new Map<string, StageMeta>();
    for (const p of res.data.results || []) {
      for (const s of p.stages || []) {
        // Si el mismo stageId aparece en varios pipelines (raro), gana el primero.
        if (!meta.has(s.id)) {
          meta.set(s.id, { label: s.label, displayOrder: s.displayOrder ?? 0 });
        }
      }
    }
    stageMetaCache.set(this.token, { data: meta, expiresAt: Date.now() + PIPELINE_CACHE_TTL_MS });
    return meta;
  }

  async listStages(): Promise<StageInfo[]> {
    const entries = Object.entries(this.stageMap) as Array<[DealStage, string]>;
    try {
      const meta = await this.getStageMeta();
      return entries
        .map(([slug, stageId]) => {
          const m = meta.get(stageId);
          return {
            slug,
            label: m?.label || slug,
            displayOrder: m?.displayOrder,
          };
        })
        .sort((a, b) => (a.displayOrder ?? 999) - (b.displayOrder ?? 999));
    } catch {
      // Si HubSpot no responde, devolvemos los slugs como label — el agente
      // sigue funcionando, simplemente sin los labels reales del pipeline.
      return entries.map(([slug]) => ({ slug, label: slug }));
    }
  }

  async searchContact(query: string): Promise<Contact[]> {
    // Si el texto es un número, buscamos exacto en Móvil y Teléfono (el
    // `query` libre de HubSpot no encuentra "+573101234567" buscando
    // "310 123 4567"). Si no, `query` busca nombre/apellido/correo/empresa.
    const phoneKey = phoneSearchKey(query);
    const body = phoneKey
      ? {
          filterGroups: [
            { filters: [{ propertyName: "mobilephone", operator: "EQ", value: phoneKey }] },
            { filters: [{ propertyName: "phone", operator: "EQ", value: phoneKey }] },
          ],
          properties: CONTACT_PROPS,
          limit: 5,
        }
      : { query, properties: CONTACT_PROPS, limit: 5 };
    let res = await this.searchWithRetry("/crm/v3/objects/contacts/search", body);
    // Fijos con extensión ("+576044446152 ext. 2166") no salen con EQ: segundo
    // intento con la búsqueda libre por los dígitos.
    if (phoneKey && (res.data.results || []).length === 0) {
      res = await this.searchWithRetry("/crm/v3/objects/contacts/search", {
        query: phoneKey.replace("+", ""),
        properties: CONTACT_PROPS,
        limit: 5,
      });
    }
    return this.toContacts(res.data.results || []);
  }

  // Convierte resultados crudos de HubSpot en Contact, resolviendo el nombre de
  // la empresa principal asociada (objeto Empresa, no el texto `company`).
  private async toContacts(raw: any[]): Promise<Contact[]> {
    const companyIds = Array.from(
      new Set(raw.map((c) => c.properties?.associatedcompanyid).filter(Boolean))
    ) as string[];
    const companies = await this.readCompanies(companyIds);
    return raw.map((c) => {
      const p = c.properties || {};
      const comp = p.associatedcompanyid ? companies.get(p.associatedcompanyid) : undefined;
      return {
        id: c.id,
        name: `${p.firstname || ""} ${p.lastname || ""}`.trim() || "(sin nombre)",
        firstname: p.firstname || undefined,
        lastname: p.lastname || undefined,
        company: comp?.name || p.company || undefined,
        companyId: p.associatedcompanyid || undefined,
        email: p.email || undefined,
        mobile: p.mobilephone || undefined,
        phone: p.phone || undefined,
        jobtitle: p.jobtitle || undefined,
        especialidad: p.especialidad || undefined,
        city: p.city || comp?.city || undefined,
      };
    });
  }

  private async readCompanies(ids: string[]): Promise<Map<string, Company>> {
    const out = new Map<string, Company>();
    if (ids.length === 0) return out;
    try {
      const res = await this.client.post("/crm/v3/objects/companies/batch/read", {
        properties: ["name", "city", "domain"],
        inputs: ids.slice(0, 100).map((id) => ({ id })),
      });
      for (const c of res.data.results || []) {
        out.set(c.id, {
          id: c.id,
          name: c.properties?.name || "(sin nombre)",
          city: c.properties?.city || undefined,
          domain: c.properties?.domain || undefined,
        });
      }
    } catch (e: any) {
      console.warn("[hubspot] batch read de empresas falló:", e?.response?.status || e?.message);
    }
    return out;
  }

  // POST a un endpoint de search con reintento ante 429 (límite bajo de HubSpot).
  private async searchWithRetry(path: string, body: any) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.client.post(path, body);
      } catch (err: any) {
        if (err?.response?.status === 429 && attempt < 2) {
          const retryAfter = Number(err?.response?.headers?.["retry-after"]) || attempt + 1;
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        throw err;
      }
    }
    throw new Error("rate limit (429) tras reintentos");
  }

  // Verifica una lista de empresas contra el objeto Company de HubSpot (NO el
  // campo de texto `company` del contacto). Un solo llamado del agente cubre N
  // empresas para no agotar el loop de iteraciones.
  //
  // ⚠️ El endpoint de SEARCH de HubSpot tiene un límite especial y bajo
  // (~4-5 req/seg por cuenta). Disparar N búsquedas con un Promise.all hace que
  // la mayoría rebote con 429 y se reporten como no verificadas. Por eso usamos
  // concurrencia limitada (pool) + reintento con backoff ante 429.
  async searchCompany(names: string[]): Promise<CompanySearchResult[]> {
    const capped = (names || []).map((n) => n.trim()).filter(Boolean).slice(0, 25);

    // Una búsqueda contra companies con reintento ante 429. Devuelve los
    // candidatos crudos (o lanza para que el caller decida el estado).
    const rawSearch = async (query: string): Promise<Company[]> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await this.client.post("/crm/v3/objects/companies/search", {
            query,
            properties: ["name", "domain", "city"],
            limit: 5,
          });
          return (res.data.results || []).map((c: any) => ({
            id: c.id,
            name: c.properties?.name || "(sin nombre)",
            domain: c.properties?.domain,
            city: c.properties?.city || undefined,
          }));
        } catch (err: any) {
          const status = err?.response?.status;
          // Reintentamos solo ante rate limit; respetamos Retry-After si viene.
          if (status === 429 && attempt < 2) {
            const retryAfter = Number(err?.response?.headers?.["retry-after"]) || attempt + 1;
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            continue;
          }
          throw err;
        }
      }
      throw new Error("rate limit (429) tras reintentos");
    };

    const searchOne = async (name: string): Promise<CompanySearchResult> => {
      try {
        // Pase 1: nombre sin sufijo legal (HubSpot exige que todos los tokens
        // existan; "S.A.S." extra da 0 resultados aunque la empresa exista).
        const cleaned = stripLegalSuffix(name) || name;
        let candidates = await rawSearch(cleaned);

        const matched = candidates.filter((c) => companyMatches(name, [c.name]));
        if (matched.length > 0) return { query: name, status: "exists", matches: matched };
        if (candidates.length > 0)
          return { query: name, status: "possible", matches: candidates.slice(0, 3) };

        // Pase 2 (solo si el pase 1 no trajo nada): query más laxo con los
        // primeros 2 tokens. HubSpot hace prefix-match por token, así que
        // "Clínica Porto" alcanza "Clínica Portoazul Auna". Lo devolvemos como
        // "possible" para que el agente lo confirme con el usuario.
        const tokens = cleaned.split(" ").filter(Boolean);
        if (tokens.length > 2) {
          candidates = await rawSearch(tokens.slice(0, 2).join(" "));
          const m2 = candidates.filter((c) => companyMatches(name, [c.name]));
          if (m2.length > 0) return { query: name, status: "exists", matches: m2 };
          if (candidates.length > 0)
            return { query: name, status: "possible", matches: candidates.slice(0, 3) };
        }

        return { query: name, status: "not_found", matches: [] };
      } catch (err: any) {
        const msg = err?.response?.data?.message || err.message;
        return { query: name, status: "error", matches: [], error: msg };
      }
    };

    // Pool de concurrencia: a lo más CONCURRENCY búsquedas en vuelo a la vez,
    // preservando el orden de entrada en los resultados.
    const CONCURRENCY = 3;
    const results: CompanySearchResult[] = new Array(capped.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= capped.length) break;
        results[i] = await searchOne(capped[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, capped.length) }, worker)
    );
    return results;
  }

  // Busca contactos que probablemente sean la misma persona: mismo correo,
  // mismo celular, o mismo nombre completo (con apellido, o sin apellido pero
  // en la misma empresa, como los contactos de área).
  private async findPossibleDuplicates(input: {
    firstname: string;
    lastname?: string;
    email?: string;
    mobilephone?: string;
    companyId?: string;
  }): Promise<Contact[]> {
    const groups: any[] = [];
    if (input.email) groups.push({ filters: [{ propertyName: "email", operator: "EQ", value: input.email }] });
    if (input.mobilephone)
      groups.push({ filters: [{ propertyName: "mobilephone", operator: "EQ", value: input.mobilephone }] });

    const found = new Map<string, any>();
    if (groups.length) {
      const res = await this.searchWithRetry("/crm/v3/objects/contacts/search", {
        filterGroups: groups,
        properties: CONTACT_PROPS,
        limit: 5,
      });
      for (const c of res.data.results || []) found.set(c.id, c);
    }

    const fullName = normalizeForMatch(`${input.firstname} ${input.lastname || ""}`);
    if (fullName) {
      const res = await this.searchWithRetry("/crm/v3/objects/contacts/search", {
        query: `${input.firstname} ${input.lastname || ""}`.trim(),
        properties: CONTACT_PROPS,
        limit: 10,
      });
      for (const c of res.data.results || []) {
        const p = c.properties || {};
        const same = normalizeForMatch(`${p.firstname || ""} ${p.lastname || ""}`) === fullName;
        const sameCompany = !!input.companyId && p.associatedcompanyid === input.companyId;
        if (same && (input.lastname || sameCompany)) found.set(c.id, c);
      }
    }
    return this.toContacts(Array.from(found.values()).slice(0, 5));
  }

  async createContact(input: ContactInput): Promise<CreateContactResult> {
    const firstname = cleanPersonName(input.firstname);
    if (!firstname) throw new ValidationError("Falta el nombre del contacto.");
    const lastname = cleanPersonName(input.lastname);
    const email = normalizeEmail(input.email);
    const phones = routePhones({ mobile: input.mobile, phone: input.phone });
    const especialidad = normalizeEspecialidad(input.especialidad);
    const city = normalizeCity(input.city);
    const jobtitle = input.jobtitle?.replace(/\s+/g, " ").trim() || undefined;

    if (!input.companyId && !input.withoutCompany) {
      throw new ValidationError(
        "Falta company_id. Todo contacto va asociado a su empresa (o a la sede): búscala con search_company y pasa su id. Si no existe, pregúntale al usuario si la creas con create_company. Solo si el usuario confirma que no tiene empresa, usa without_company: true."
      );
    }

    if (!input.allowDuplicate) {
      const matches = await this.findPossibleDuplicates({
        firstname,
        lastname,
        email,
        mobilephone: phones.mobilephone,
        companyId: input.companyId,
      });
      if (matches.length > 0) {
        return {
          status: "possible_duplicate",
          matches,
          message:
            "NO se creó: ya existe(n) contacto(s) con el mismo correo, celular o nombre. Muéstraselos al usuario y pregunta si es la misma persona. Si lo es, actualiza ese contacto con update_contact. Solo si confirma que es otra persona, vuelve a llamar create_contact con allow_duplicate: true.",
        };
      }
    }

    const properties: Record<string, string> = { firstname, lifecyclestage: "lead" };
    if (lastname) properties.lastname = lastname;
    if (email) properties.email = email;
    if (phones.mobilephone) properties.mobilephone = phones.mobilephone;
    if (phones.phone) properties.phone = phones.phone;
    if (jobtitle) properties.jobtitle = jobtitle;
    if (especialidad) properties.especialidad = especialidad;
    if (city) properties.city = city;
    if (this.ownerId) properties.hubspot_owner_id = this.ownerId;

    const associations = input.companyId
      ? [
          {
            to: { id: input.companyId },
            // 1 = contact → company, empresa principal (HUBSPOT_DEFINED)
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }],
          },
        ]
      : [];

    const res = await this.client.post("/crm/v3/objects/contacts", { properties, associations });
    const [contact] = await this.toContacts([{ id: res.data.id, properties: { ...properties, associatedcompanyid: input.companyId } }]);
    return { status: "created", contact };
  }

  async updateContact(contactId: string, input: ContactUpdate): Promise<Contact> {
    // Solo se escriben los campos que vienen con valor: nunca se borra un dato.
    const properties: Record<string, string> = {};
    const firstname = cleanPersonName(input.firstname);
    const lastname = cleanPersonName(input.lastname);
    if (firstname) properties.firstname = firstname;
    if (lastname) properties.lastname = lastname;
    const email = normalizeEmail(input.email);
    if (email) properties.email = email;
    const phones = routePhones({ mobile: input.mobile, phone: input.phone });
    if (phones.mobilephone) properties.mobilephone = phones.mobilephone;
    if (phones.phone) properties.phone = phones.phone;
    const jobtitle = input.jobtitle?.replace(/\s+/g, " ").trim();
    if (jobtitle) properties.jobtitle = jobtitle;
    const especialidad = normalizeEspecialidad(input.especialidad);
    if (especialidad) properties.especialidad = especialidad;
    const city = normalizeCity(input.city);
    if (city) properties.city = city;

    if (Object.keys(properties).length === 0 && !input.companyId) {
      throw new ValidationError("No hay datos para actualizar.");
    }
    if (Object.keys(properties).length > 0) {
      await this.client.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
    }
    if (input.companyId) {
      // Asocia (o cambia) la empresa principal del contacto.
      await this.client.put(
        `/crm/v4/objects/contacts/${contactId}/associations/companies/${input.companyId}`,
        [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }]
      );
    }
    const res = await this.client.get(`/crm/v3/objects/contacts/${contactId}`, {
      params: { properties: CONTACT_PROPS.join(",") },
    });
    const [contact] = await this.toContacts([res.data]);
    return contact;
  }

  async createCompany(input: CompanyInput): Promise<CreateCompanyResult> {
    const name = cleanCompanyName(input.name);
    const city = normalizeCity(input.city);
    const domain = normalizeDomain(input.domain);
    const phone = input.phone ? parsePhone(input.phone).value : undefined;

    if (!input.allowDuplicate) {
      const [check] = await this.searchCompany([name]);
      if (check?.status === "error") {
        throw new Error(`No se pudo verificar si la empresa ya existe (${check.error}). Intenta de nuevo.`);
      }
      if (check && (check.status === "exists" || check.status === "possible")) {
        return {
          status: "possible_duplicate",
          matches: check.matches,
          message:
            "NO se creó: hay empresa(s) con nombre igual o parecido. Muéstraselas al usuario. Si es una de ellas, usa su id. Si es una sede nueva de esa marca, créala con el nombre «Marca Sede» y parent_company_id de la casa matriz. Solo si confirma que es otra empresa, vuelve a llamar create_company con allow_duplicate: true.",
        };
      }
    }

    const properties: Record<string, string> = { name };
    if (city) properties.city = city;
    if (domain) properties.domain = domain;
    if (phone) properties.phone = phone;

    const associations = input.parentCompanyId
      ? [
          {
            to: { id: input.parentCompanyId },
            // 14 = empresa hija (sede) → empresa matriz (HUBSPOT_DEFINED)
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 14 }],
          },
        ]
      : [];

    const res = await this.client.post("/crm/v3/objects/companies", { properties, associations });
    return { status: "created", company: { id: res.data.id, name, city, domain } };
  }

  // Devuelve los contactos y la empresa asociados a un deal en HubSpot. Lo
  // usamos en searchDeal para darle al agente el contexto completo del deal
  // y en createTask para enlazar la tarea a todos los registros relevantes.
  private async getDealAssociations(
    dealId: string
  ): Promise<{ contactIds: string[]; companyId?: string }> {
    try {
      const [contactsRes, companiesRes] = await Promise.all([
        this.client.get(`/crm/v3/objects/deals/${dealId}/associations/contacts`).catch(() => null),
        this.client.get(`/crm/v3/objects/deals/${dealId}/associations/companies`).catch(() => null),
      ]);
      const contactIds: string[] = (contactsRes?.data?.results || []).map((r: any) => r.id);
      const companyId: string | undefined = companiesRes?.data?.results?.[0]?.id;
      return { contactIds, companyId };
    } catch {
      return { contactIds: [] };
    }
  }

  async searchDeal(query: string): Promise<Deal[]> {
    // HubSpot's deals search `query` parameter sólo busca contra propiedades
    // del deal (dealname, description, etc.) — no incluye nombres de contacto
    // ni de empresa asociados. Por eso intentamos primero el match directo,
    // y si vacía, caemos a buscar contactos por el query y traemos sus deals.
    const direct = await this.client.post("/crm/v3/objects/deals/search", {
      query,
      properties: ["dealname", "dealstage", "amount"],
      limit: 5,
    });

    const directRaw = (direct.data.results || []) as any[];
    if (directRaw.length > 0) {
      const enriched = await Promise.all(
        directRaw.map(async (d) => {
          const assoc = await this.getDealAssociations(d.id);
          return {
            id: d.id,
            name: d.properties.dealname,
            stage: d.properties.dealstage,
            amount: d.properties.amount ? parseFloat(d.properties.amount) : undefined,
            contactIds: assoc.contactIds,
            contactId: assoc.contactIds[0],
            companyId: assoc.companyId,
          };
        })
      );
      return enriched;
    }

    // Fallback: buscar contactos cuyo nombre/empresa/email matcheen el query
    // y traer los deals asociados a ellos.
    const contactsRes = await this.client.post("/crm/v3/objects/contacts/search", {
      query,
      properties: ["firstname", "lastname", "company"],
      limit: 5,
    });
    const contactIds: string[] = (contactsRes.data.results || []).map((c: any) => c.id);
    if (contactIds.length === 0) return [];

    // Mapeo deal_id → primer contact_id que lo trajo, para devolverlo al agente
    // (le permite anclar notas tanto al deal como al contacto sin tener que
    // hacer una búsqueda adicional).
    const dealToContact = new Map<string, string>();
    await Promise.all(
      contactIds.map(async (cid) => {
        try {
          const r = await this.client.get(
            `/crm/v3/objects/contacts/${cid}/associations/deals`
          );
          for (const a of r.data?.results || []) {
            if (!dealToContact.has(a.id)) dealToContact.set(a.id, cid);
          }
        } catch {
          // ignoramos errores por contacto — seguimos con los demás
        }
      })
    );

    if (dealToContact.size === 0) return [];

    const batch = await this.client.post("/crm/v3/objects/deals/batch/read", {
      properties: ["dealname", "dealstage", "amount"],
      inputs: Array.from(dealToContact.keys()).slice(0, 10).map((id) => ({ id })),
    });

    const dealsRaw = (batch.data?.results || []) as any[];
    return Promise.all(
      dealsRaw.map(async (d) => {
        const assoc = await this.getDealAssociations(d.id);
        return {
          id: d.id,
          name: d.properties?.dealname,
          stage: d.properties?.dealstage,
          amount: d.properties?.amount ? parseFloat(d.properties.amount) : undefined,
          contactIds: assoc.contactIds.length ? assoc.contactIds : [dealToContact.get(d.id)!],
          contactId: dealToContact.get(d.id),
          companyId: assoc.companyId,
        };
      })
    );
  }

  async createDeal(input: { contactId: string; name: string; amount?: number; stage?: DealStage }): Promise<Deal> {
    const stageId = this.resolveStage(input.stage || "saludo");
    const properties: Record<string, any> = {
      dealname: input.name,
      dealstage: stageId,
    };
    if (input.amount !== undefined) properties.amount = String(input.amount);

    // Asociar la empresa primaria del contacto al deal, para que cualquier
    // actividad futura (tareas, notas) pueda propagarse a la timeline de la
    // empresa sin tener que adivinar la asociación.
    let companyId: string | null = null;
    try {
      const companyAssoc = await this.client.get(
        `/crm/v3/objects/contacts/${input.contactId}/associations/companies`
      );
      companyId = companyAssoc.data?.results?.[0]?.id || null;
    } catch {
      // si falla, seguimos sin company association
    }

    const associations: Array<{ to: { id: string }; types: any[] }> = [
      {
        to: { id: input.contactId },
        // 3 = deal-to-contact (HUBSPOT_DEFINED)
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
      },
    ];
    if (companyId) {
      associations.push({
        to: { id: companyId },
        // 5 = deal-to-company (HUBSPOT_DEFINED)
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }],
      });
    }

    const res = await this.client.post("/crm/v3/objects/deals", {
      properties,
      associations,
    });

    return {
      id: res.data.id,
      name: input.name,
      stage: input.stage || "saludo",
      amount: input.amount,
      contactId: input.contactId,
      companyId: companyId || undefined,
    };
  }

  async moveDeal(dealId: string, stage: DealStage): Promise<string> {
    const stageId = this.resolveStage(stage);
    await this.client.patch(`/crm/v3/objects/deals/${dealId}`, {
      properties: { dealstage: stageId },
    });
    return `Deal movido a "${stage}"`;
  }

  async createNote(input: { contactId?: string; dealId?: string; body: string }): Promise<string> {
    if (!input.contactId && !input.dealId) {
      throw new Error("createNote requiere al menos contactId o dealId");
    }
    // HubSpot associationTypeIds (HUBSPOT_DEFINED): note↔contact = 202, note↔deal = 214.
    const associations: any[] = [];
    if (input.contactId) {
      associations.push({
        to: { id: input.contactId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
      });
    }
    if (input.dealId) {
      associations.push({
        to: { id: input.dealId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }],
      });
    }
    try {
      await this.client.post("/crm/v3/objects/notes", {
        properties: {
          hs_note_body: input.body,
          hs_timestamp: Date.now(),
        },
        associations,
      });
      if (input.dealId && input.contactId) return "Nota registrada en el deal y en el contacto";
      if (input.dealId) return "Nota registrada en el deal";
      return "Nota registrada en el contacto";
    } catch (err: any) {
      // Some HubSpot plans don't expose `crm.objects.notes.write`. The note
      // body is already persisted in `activity_log` by the agent loop, so we
      // return a graceful success to keep the conversation moving.
      if (err?.response?.status === 403) {
        return "Nota registrada (HubSpot no expone el scope de notas en este plan; queda en el log de actividad)";
      }
      throw err;
    }
  }

  async listTasks(input: {
    fromDate: string;
    toDate: string;
    includeCompleted?: boolean;
  }): Promise<TaskItem[]> {
    // Anclamos el rango a horas locales Bogotá para que "tareas de hoy" cubra
    // todo el día completo en zona del comercial, no la ventana UTC equivalente.
    const fromTs = /^\d{4}-\d{2}-\d{2}$/.test(input.fromDate)
      ? new Date(`${input.fromDate}T00:00:00-05:00`).getTime()
      : new Date(input.fromDate).getTime();
    const toTs = /^\d{4}-\d{2}-\d{2}$/.test(input.toDate)
      ? new Date(`${input.toDate}T23:59:59-05:00`).getTime()
      : new Date(input.toDate).getTime();

    const filters: any[] = [
      { propertyName: "hs_timestamp", operator: "GTE", value: String(fromTs) },
      { propertyName: "hs_timestamp", operator: "LTE", value: String(toTs) },
    ];
    if (!input.includeCompleted) {
      filters.push({ propertyName: "hs_task_status", operator: "NEQ", value: "COMPLETED" });
    }
    if (this.ownerId) {
      filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: this.ownerId });
    }

    const searchRes = await this.client.post("/crm/v3/objects/tasks/search", {
      filterGroups: [{ filters }],
      properties: ["hs_task_subject", "hs_timestamp", "hs_task_status", "hubspot_owner_id"],
      sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
      limit: 50,
    });

    const tasksRaw = (searchRes.data.results || []) as any[];
    if (tasksRaw.length === 0) return [];

    // Traer asociaciones (deal/contact/company) por tarea en paralelo. Cada
    // batch read solo soporta un tipo de target, así que disparamos 3 batches.
    const buildBatch = (objectType: string) =>
      this.client
        .post(`/crm/v3/associations/tasks/${objectType}/batch/read`, {
          inputs: tasksRaw.map((t) => ({ id: t.id })),
        })
        .catch(() => null);

    const [dealAssoc, contactAssoc, companyAssoc] = await Promise.all([
      buildBatch("deals"),
      buildBatch("contacts"),
      buildBatch("companies"),
    ]);

    const firstIdByTask = (res: any): Map<string, string> => {
      const map = new Map<string, string>();
      for (const r of res?.data?.results || []) {
        const taskId = r.from?.id;
        const targetId = r.to?.[0]?.id;
        if (taskId && targetId) map.set(taskId, targetId);
      }
      return map;
    };

    const taskToDeal = firstIdByTask(dealAssoc);
    const taskToContact = firstIdByTask(contactAssoc);
    const taskToCompany = firstIdByTask(companyAssoc);

    // Resolver nombres en batch: una llamada por tipo con los IDs únicos.
    const uniq = (m: Map<string, string>) => Array.from(new Set(m.values()));
    const dealIds = uniq(taskToDeal);
    const contactIds = uniq(taskToContact);
    const companyIds = uniq(taskToCompany);

    const dealNames = new Map<string, string>();
    const contactNames = new Map<string, string>();
    const companyNames = new Map<string, string>();

    await Promise.all([
      dealIds.length > 0
        ? this.client
            .post("/crm/v3/objects/deals/batch/read", {
              properties: ["dealname"],
              inputs: dealIds.map((id) => ({ id })),
            })
            .then((r) => {
              for (const d of r.data?.results || []) dealNames.set(d.id, d.properties?.dealname);
            })
            .catch(() => undefined)
        : Promise.resolve(),
      contactIds.length > 0
        ? this.client
            .post("/crm/v3/objects/contacts/batch/read", {
              properties: ["firstname", "lastname"],
              inputs: contactIds.map((id) => ({ id })),
            })
            .then((r) => {
              for (const c of r.data?.results || []) {
                const name = `${c.properties?.firstname || ""} ${c.properties?.lastname || ""}`.trim();
                contactNames.set(c.id, name || "(sin nombre)");
              }
            })
            .catch(() => undefined)
        : Promise.resolve(),
      companyIds.length > 0
        ? this.client
            .post("/crm/v3/objects/companies/batch/read", {
              properties: ["name"],
              inputs: companyIds.map((id) => ({ id })),
            })
            .then((r) => {
              for (const c of r.data?.results || []) companyNames.set(c.id, c.properties?.name);
            })
            .catch(() => undefined)
        : Promise.resolve(),
    ]);

    return tasksRaw.map((t) => {
      // HubSpot devuelve hs_timestamp como ISO string ("2026-05-08T00:00:00Z")
      // en endpoints nuevos, pero como ms numérico en otros. Manejamos ambos.
      const raw = t.properties?.hs_timestamp;
      const ts = raw != null && /^\d+$/.test(String(raw))
        ? Number(raw)
        : new Date(raw as any).getTime();
      // Formateamos la fecha/hora en Bogotá para que el agente la presente al
      // comercial en su zona horaria operativa.
      const dueDate = new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
      const dueTime = new Date(ts).toLocaleTimeString("en-GB", {
        timeZone: "America/Bogota",
        hour: "2-digit",
        minute: "2-digit",
      });
      const dealId = taskToDeal.get(t.id);
      const contactId = taskToContact.get(t.id);
      const companyId = taskToCompany.get(t.id);
      return {
        id: t.id,
        title: t.properties?.hs_task_subject || "(sin título)",
        dueDate,
        dueTime,
        status: t.properties?.hs_task_status || "NOT_STARTED",
        dealName: dealId ? dealNames.get(dealId) : undefined,
        contactName: contactId ? contactNames.get(contactId) : undefined,
        companyName: companyId ? companyNames.get(companyId) : undefined,
      };
    });
  }

  async completeTask(taskId: string): Promise<string> {
    try {
      await this.client.patch(`/crm/v3/objects/tasks/${taskId}`, {
        properties: { hs_task_status: "COMPLETED" },
      });
      return "Tarea marcada como completada";
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return "No encontré esa tarea en HubSpot";
      }
      if (err?.response?.status === 403) {
        return "Tarea marcada como completada (HubSpot no expone el scope de tareas en este plan; queda en el log de actividad)";
      }
      throw err;
    }
  }

  async createTask(input: {
    contactId?: string;
    dealId?: string;
    title: string;
    dueDate: string;
    dueTime?: string;
    priority?: TaskPriority;
    isAppointment?: boolean;
  }): Promise<string> {
    const { contactId, dealId, title, dueDate, dueTime } = input;
    // Default MEDIUM: la mayoría de seguimientos comerciales lo son, y mantener
    // un default fijo da predecibilidad. El agente solo manda priority si el
    // usuario la pidió explícitamente.
    const hsPriority =
      input.priority === "alta" ? "HIGH" : input.priority === "baja" ? "LOW" : "MEDIUM";
    // YYYY-MM-DD without a time parses as midnight UTC, which is the prior day in Bogotá; anchor a la hora indicada (default 9am Bogotá).
    const time = dueTime && /^\d{2}:\d{2}$/.test(dueTime) ? dueTime : "09:00";
    const dueTs = /^\d{4}-\d{2}-\d{2}$/.test(dueDate)
      ? new Date(`${dueDate}T${time}:00-05:00`).getTime()
      : new Date(dueDate).getTime();

    // Si la tarea viene asociada a un deal, traemos sus contactos + empresa y
    // también el owner del deal para que la tarea quede a nombre del comercial
    // que maneja la oportunidad (no del owner default del tenant).
    let dealContactIds: string[] = [];
    let dealCompanyId: string | undefined;
    let dealOwnerId: string | undefined;
    if (dealId) {
      const assoc = await this.getDealAssociations(dealId);
      dealContactIds = assoc.contactIds;
      dealCompanyId = assoc.companyId;
      try {
        const dealRes = await this.client.get(`/crm/v3/objects/deals/${dealId}`, {
          params: { properties: "hubspot_owner_id" },
        });
        dealOwnerId = dealRes.data?.properties?.hubspot_owner_id || undefined;
      } catch {
        // si falla, caemos al owner default
      }
    }

    // Construimos la lista de asociaciones: deal + empresa + todos los
    // contactos relevantes (los del deal y/o el contact_id explícito).
    const contactIdSet = new Set<string>();
    if (contactId) contactIdSet.add(contactId);
    for (const cid of dealContactIds) contactIdSet.add(cid);

    const associations: Array<{ to: { id: string }; types: any[] }> = [];
    for (const cid of contactIdSet) {
      associations.push({
        to: { id: cid },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
      });
    }
    if (dealId) {
      associations.push({
        to: { id: dealId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 216 }],
      });
    }
    if (dealCompanyId) {
      associations.push({
        to: { id: dealCompanyId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 192 }],
      });
    }

    const ownerId = dealOwnerId || this.ownerId;
    if (!ownerId) {
      console.warn(
        `[hubspot] createTask sin owner — el tenant no tiene hubspot_owner_id ` +
          `y el deal ${dealId || "(ninguno)"} tampoco. HubSpot no disparará recordatorio.`
      );
    }

    // hs_task_reminders es una propiedad enumeration MULTIVALOR ("The dates when
    // reminders will be sent"). Se serializa como string de epochs ms separados
    // por ";" (p.ej. "1780322400000;1780405200000"). La forma de array JSON
    // (`[ts]`) HubSpot la rechaza con INVALID_DATE ("Expected to be an epoch
    // timestamp"); un epoch suelto se castea bien al ser un único valor.
    // - Tarea/seguimiento normal: un solo recordatorio EN el due time.
    // - Cita/reunión (isAppointment): dos recordatorios ANTES del due time:
    //     1) la VÍSPERA a las 19:00 Bogotá (no "24h antes" fijo: anclar a una
    //        hora útil del día calendario anterior asegura que una cita agendada
    //        el día previo igual reciba un aviso la noche anterior, en vez de uno
    //        a la misma hora del día anterior que casi siempre ya pasó).
    //     2) 1 hora antes.
    //   Descartamos los que ya quedaron en el pasado; si ambos quedaran en el
    //   pasado caemos al due time para no dejar la cita sin ningún aviso.
    //   Requiere owner para que dispare (igual que el recordatorio único).
    // Bogotá es UTC-5 sin horario de verano, así que -05:00 es constante y la
    // aritmética de epochs desde la medianoche del día de la cita es exacta.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const HOUR_MS = 60 * 60 * 1000;
    let reminderTimes: number[];
    if (input.isAppointment) {
      const eveBefore = /^\d{4}-\d{2}-\d{2}$/.test(dueDate)
        ? new Date(`${dueDate}T00:00:00-05:00`).getTime() - DAY_MS + 19 * HOUR_MS
        : dueTs - DAY_MS; // fallback si la fecha no viene como YYYY-MM-DD
      const oneHourBefore = dueTs - HOUR_MS;
      const before = [eveBefore, oneHourBefore].filter((ts) => ts > Date.now());
      reminderTimes = before.length ? before : [dueTs];
    } else {
      reminderTimes = [dueTs];
    }
    const remindersValue = reminderTimes.join(";");
    try {
      await this.client.post("/crm/v3/objects/tasks", {
        properties: {
          hs_task_subject: title,
          hs_task_status: "NOT_STARTED",
          hs_task_priority: hsPriority,
          // Las citas se tipan como MEETING (se leen/filtran como "Reunión" en
          // HubSpot) sin dejar de ser un Task: así conservan los recordatorios
          // (hs_task_reminders es propiedad del Task; el objeto Meeting no tiene
          // recordatorio por API) y la cola de tareas del comercial.
          hs_task_type: input.isAppointment ? "MEETING" : "TODO",
          hs_timestamp: dueTs,
          hs_task_reminders: remindersValue,
          // HubSpot solo dispara la notificación del recordatorio si la tarea tiene owner.
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
        },
        associations,
      });
      const targets: string[] = [];
      if (dealId) targets.push("deal");
      if (contactIdSet.size > 0) targets.push(contactIdSet.size > 1 ? `${contactIdSet.size} contactos` : "contacto");
      if (dealCompanyId) targets.push("empresa");
      const where = targets.length ? ` (asociada al ${targets.join(", ")})` : "";
      return `Tarea "${title}" creada en HubSpot${where}`;
    } catch (err: any) {
      if (err?.response?.status === 403) {
        return `Tarea "${title}" registrada (HubSpot no expone el scope de tareas en este plan; queda en el log de actividad)`;
      }
      // Exponemos el motivo de validación de HubSpot; si no, queda un opaco
      // "Request failed with status code 400" en el activity_log.
      const hsMsg = err?.response?.data?.message;
      if (hsMsg) {
        throw new Error(`HubSpot ${err.response.status}: ${hsMsg}`);
      }
      throw err;
    }
  }
}
