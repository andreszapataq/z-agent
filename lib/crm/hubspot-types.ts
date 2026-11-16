// ============================================================
// Tipos de las respuestas de la API de HubSpot que leemos
// ============================================================
// Describen solo los campos que usa el código (no toda la API). HubSpot
// devuelve las propiedades como string, o null cuando están vacías.

export type HubSpotProps = Record<string, string | null | undefined>;

export type HubSpotObject<P extends HubSpotProps = HubSpotProps> = {
  id: string;
  properties: P;
};

// Respuesta de search, batch/read y listados: { results: [...] }.
export type HubSpotResults<T> = {
  results?: T[];
};

// Propiedades de un deal que siempre pedimos (dealname y dealstage existen en
// todo deal de HubSpot).
export type DealProps = HubSpotProps & { dealname: string; dealstage: string };

// GET /crm/v3/objects/{tipo}/{id}/associations/{tipo}
export type HubSpotAssociationRef = { id: string; type?: string };

// POST /crm/v3/associations/{de}/{a}/batch/read
export type HubSpotAssociationBatchRow = {
  from?: { id?: string };
  to?: Array<{ id?: string }>;
};

// GET /crm/v3/pipelines/deals
export type HubSpotPipelineStage = { id: string; label: string; displayOrder: number };
export type HubSpotPipeline = { id: string; label: string; stages?: HubSpotPipelineStage[] };

// GET /crm/v3/owners
export type HubSpotOwner = {
  id: string;
  userId?: number;
  email?: string;
  firstName?: string;
  lastName?: string;
  archived?: boolean;
};

// Filtros de los endpoints de search.
export type HubSpotFilter = { propertyName: string; operator: string; value?: string };
export type HubSpotFilterGroup = { filters: HubSpotFilter[] };

// Asociación al crear un objeto ({ to, types }).
export type HubSpotAssociationType = {
  associationCategory: "HUBSPOT_DEFINED" | "USER_DEFINED" | "INTEGRATOR_DEFINED";
  associationTypeId: number;
};
export type HubSpotAssociationInput = { to: { id: string }; types: HubSpotAssociationType[] };
