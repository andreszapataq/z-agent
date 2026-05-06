import { Tenant } from "../tenants";
import { CrmAdapter } from "./types";
import { HubSpotAdapter } from "./hubspot";
import { NativeAdapter } from "./native";

export function getCrmAdapter(tenant: Tenant): CrmAdapter {
  switch (tenant.crm_type) {
    case "hubspot":
      if (!tenant.hubspot_token) {
        throw new Error(`Tenant ${tenant.id}: crm_type es 'hubspot' pero falta el token`);
      }
      return new HubSpotAdapter(tenant.hubspot_token, tenant.stage_map);

    case "native":
      return new NativeAdapter(tenant.id);

    case "salesforce":
      throw new Error("Salesforce adapter aún no implementado");

    default:
      throw new Error(`crm_type desconocido: ${tenant.crm_type}`);
  }
}
