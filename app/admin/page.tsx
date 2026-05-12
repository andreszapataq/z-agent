"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./admin.module.css";

type CrmType = "hubspot" | "native" | "salesforce";

type Tenant = {
  id: string;
  name: string;
  crm_type: CrmType;
  status: string;
  whatsapp_phone_id: string | null;
  whatsapp_token: string | null;
  owner_number: string | null;
  hubspot_token: string | null;
  system_prompt: string | null;
  proposal_stage_id: string | null;
  proposal_email_template_id: string | null;
  stage_map: Record<string, string> | null;
  created_at: string;
};

type StageOption = { id: string; label: string };
type PipelineOption = { id: string; label: string; stages: StageOption[] };

const STAGE_KEYS = ["saludo", "presentación", "propuesta", "cierre", "perdido"] as const;

const COLOR_CLASSES = [styles.avTeal, styles.avAmber, styles.avPurple];

export default function AdminPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [msgsToday, setMsgsToday] = useState<Record<string, number>>({});
  const [authed, setAuthed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);

  // Form state
  const [form, setForm] = useState({
    id: "",
    name: "",
    crm_type: "native" as CrmType,
    whatsapp_phone_id: "",
    owner_number: "",
    whatsapp_token: "",
    hubspot_token: "",
    system_prompt: "",
    proposal_stage_id: "",
    proposal_email_template_id: "",
    stage_map: {} as Record<string, string>,
  });

  const [pipelines, setPipelines] = useState<PipelineOption[] | null>(null);
  const [loadingPipelines, setLoadingPipelines] = useState(false);

  useEffect(() => {
    loadTenants();
  }, []);

  async function loadTenants() {
    try {
      const res = await fetch("/api/admin/tenants");
      if (res.status === 401) {
        router.push("/admin/login");
        return;
      }
      if (!res.ok) {
        showToast("Error cargando clientes", "error");
        return;
      }
      const data = await res.json();
      setTenants(data);
      setAuthed(true);
      loadMsgsToday();
    } catch (e) {
      showToast("Error cargando clientes", "error");
    }
  }

  async function loadMsgsToday() {
    try {
      const res = await fetch("/api/admin/stats/messages-today");
      if (!res.ok) return;
      const data = await res.json();
      setMsgsToday(data.counts || {});
    } catch {
      // silencioso: el dashboard funciona sin esta métrica
    }
  }

  function showToast(msg: string, type: "success" | "error" = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  }

  function openModal(tenant?: Tenant) {
    setPipelines(null);
    if (tenant) {
      setEditing(tenant.id);
      setForm({
        id: tenant.id,
        name: tenant.name,
        crm_type: tenant.crm_type,
        whatsapp_phone_id: tenant.whatsapp_phone_id || "",
        owner_number: tenant.owner_number || "",
        whatsapp_token: tenant.whatsapp_token || "",
        hubspot_token: tenant.hubspot_token || "",
        system_prompt: tenant.system_prompt || "",
        proposal_stage_id: tenant.proposal_stage_id || "",
        proposal_email_template_id: tenant.proposal_email_template_id || "",
        stage_map: tenant.stage_map || {},
      });
    } else {
      setEditing(null);
      setForm({
        id: "",
        name: "",
        crm_type: "native",
        whatsapp_phone_id: "",
        owner_number: "",
        whatsapp_token: "",
        hubspot_token: "",
        system_prompt: "",
        proposal_stage_id: "",
        proposal_email_template_id: "",
        stage_map: {},
      });
    }
    setModalOpen(true);
  }

  async function loadHubspotStages() {
    if (!editing) {
      showToast("Guarda primero el tenant para poder consultar HubSpot", "error");
      return;
    }
    setLoadingPipelines(true);
    try {
      const res = await fetch(`/api/admin/hubspot-stages/${editing}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || "No se pudo consultar HubSpot", "error");
        return;
      }
      const data = await res.json();
      setPipelines(data.pipelines || []);
    } catch {
      showToast("Error de red consultando HubSpot", "error");
    } finally {
      setLoadingPipelines(false);
    }
  }

  async function saveTenant() {
    if (!form.id || !form.name) {
      showToast("ID y nombre son requeridos", "error");
      return;
    }
    if (form.crm_type === "hubspot" && !form.hubspot_token) {
      showToast("Si el CRM es HubSpot, el token es requerido", "error");
      return;
    }

    const url = editing
      ? `/api/admin/tenants/${editing}`
      : "/api/admin/tenants";
    const method = editing ? "PUT" : "POST";

    // Normalizar: strings vacíos → null, stage_map vacío → null
    const payload: any = { ...form };
    for (const k of [
      "whatsapp_phone_id",
      "owner_number",
      "whatsapp_token",
      "hubspot_token",
      "system_prompt",
      "proposal_stage_id",
      "proposal_email_template_id",
    ]) {
      if (!payload[k]) payload[k] = null;
    }
    if (!Object.keys(payload.stage_map || {}).length) payload.stage_map = null;

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      showToast(editing ? "Cliente actualizado" : "Cliente agregado");
      setModalOpen(false);
      loadTenants();
    } catch (e: any) {
      showToast(`Error: ${e.message}`, "error");
    }
  }

  async function deleteTenant(id: string, name: string) {
    if (!confirm(`¿Eliminar el cliente "${name}"?\nEsta acción no se puede deshacer.`)) return;
    try {
      const res = await fetch(`/api/admin/tenants/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      showToast("Cliente eliminado");
      loadTenants();
    } catch {
      showToast("Error al eliminar", "error");
    }
  }

  async function logout() {
    try {
      await fetch("/api/admin/logout", { method: "POST" });
    } catch {}
    router.push("/admin/login");
  }

  if (!authed) return null;

  const total = tenants?.length || 0;
  const withWA = tenants?.filter((t) => t.whatsapp_token).length || 0;
  const withHS = tenants?.filter((t) => t.crm_type === "hubspot").length || 0;
  const withNative = tenants?.filter((t) => t.crm_type === "native").length || 0;

  return (
    <div className={styles.shell}>
      {/* Sidebar */}
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <div className={styles.logoMark}>
            <div className={styles.logoIcon}>
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M3 8L7 12L13 4" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <div className={styles.logoName}>Z-Agent</div>
              <div className={styles.logoSub}>ADMIN PANEL</div>
            </div>
          </div>
        </div>
        <nav className={styles.nav}>
          <div className={styles.navLabel}>SISTEMA</div>
          <button className={`${styles.navItem} ${styles.navItemActive}`}>
            <svg viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
            Clientes
            <div className={styles.navDot}></div>
          </button>
          <button className={styles.navItem} onClick={() => openModal()}>
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Agregar cliente
          </button>
        </nav>
        <div className={styles.sidebarFooter}>
          <button onClick={logout} className={styles.versionPill} style={{ cursor: "pointer", border: "1px solid var(--border2)" }}>
            cerrar sesión
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <h1>Clientes registrados</h1>
            <p>Gestiona tenants, credenciales y agentes de IA</p>
          </div>
          <div className={styles.headerRight}>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => openModal()}>
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              Nuevo cliente
            </button>
          </div>
        </header>

        <div className={styles.content}>
          {/* Stats */}
          <div className={styles.stats}>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Total clientes</div>
              <div className={`${styles.statValue} ${styles.statAccent}`}>{total}</div>
              <div className={`${styles.statChange} ${styles.neutral}`}>tenants registrados</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>WhatsApp activo</div>
              <div className={styles.statValue}>{withWA}</div>
              <div className={`${styles.statChange} up`} style={{ color: "var(--teal)" }}>conectados a Meta</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Con HubSpot</div>
              <div className={styles.statValue}>{withHS}</div>
              <div className={`${styles.statChange} ${styles.neutral}`}>integrados</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>CRM nativo</div>
              <div className={styles.statValue}>{withNative}</div>
              <div className={`${styles.statChange} ${styles.neutral}`}>en supabase</div>
            </div>
          </div>

          {/* Tenants */}
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Tenants</span>
            <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text3)" }}>
              {total} registrados
            </span>
          </div>

          {tenants === null ? (
            <div className={styles.tenantGrid}>
              <div className={styles.loading}>Cargando clientes...</div>
            </div>
          ) : (
            <div className={styles.tenantGrid}>
              {tenants.map((t, i) => {
                const colorClass = COLOR_CLASSES[i % COLOR_CLASSES.length];
                const initial = t.name.charAt(0).toUpperCase();
                const hasWA = !!t.whatsapp_token;
                const crmLabel =
                  t.crm_type === "hubspot" ? "HubSpot" :
                  t.crm_type === "native" ? "CRM nativo" :
                  "Salesforce";

                return (
                  <div key={t.id} className={styles.tenantCard}>
                    <div className={styles.tcTop}>
                      <div className={`${styles.tcAvatar} ${colorClass}`}>{initial}</div>
                      <div className={styles.tcStatus}>
                        <div className={`${styles.statusDot} ${hasWA ? styles.dotGreen : styles.dotAmber}`}></div>
                        <span className={hasWA ? styles.statusGreen : styles.statusAmber}>
                          {hasWA ? "activo" : "configurando"}
                        </span>
                      </div>
                    </div>
                    <div className={styles.tcName}>{t.name}</div>
                    <div className={styles.tcId}>{t.id}</div>
                    <div className={styles.tcMeta}>
                      <span className={`${styles.tag} ${styles.tagAccent}`}>{crmLabel}</span>
                      {t.owner_number && <span className={styles.tag}>{t.owner_number}</span>}
                      {hasWA ? (
                        <span className={styles.tag}>WhatsApp</span>
                      ) : (
                        <span className={styles.tag}>pendiente WA</span>
                      )}
                    </div>
                    <div className={styles.tcFooter}>
                      <div className={styles.tcMsgs}>
                        <strong>{msgsToday[t.id] ?? 0}</strong> msgs hoy
                      </div>
                      <div className={styles.tcActions}>
                        <button className={styles.iconBtn} title="Editar" onClick={() => openModal(t)}>
                          <svg viewBox="0 0 16 16" fill="none">
                            <path d="M11 2l3 3-9 9H2v-3L11 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        <button
                          className={`${styles.iconBtn} ${styles.iconBtnDel}`}
                          title="Eliminar"
                          onClick={() => deleteTenant(t.id, t.name)}
                        >
                          <svg viewBox="0 0 16 16" fill="none">
                            <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              <button className={`${styles.tenantCard} ${styles.addCard}`} onClick={() => openModal()}>
                <div className={styles.addIcon}>
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <path d="M8 1v14M1 8h14" stroke="var(--text3)" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <span style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                  Agregar cliente
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      <div
        className={`${styles.modalOverlay} ${modalOpen ? styles.open : ""}`}
        onClick={(e) => e.target === e.currentTarget && setModalOpen(false)}
      >
        <div className={styles.modal}>
          <div className={styles.modalHeader}>
            <h2>{editing ? "Editar cliente" : "Nuevo cliente"}</h2>
            <button className={styles.modalClose} onClick={() => setModalOpen(false)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          <div className={styles.modalBody}>
            {/* CRM selector */}
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Tipo de CRM</label>
              <div className={styles.crmSelector}>
                <button
                  type="button"
                  className={`${styles.crmOption} ${form.crm_type === "native" ? styles.crmOptionActive : ""}`}
                  onClick={() => setForm({ ...form, crm_type: "native" })}
                >
                  <div className={styles.crmOptionTitle}>CRM nativo</div>
                  <div className={styles.crmOptionDesc}>Datos en Supabase · sin CRM externo</div>
                </button>
                <button
                  type="button"
                  className={`${styles.crmOption} ${form.crm_type === "hubspot" ? styles.crmOptionActive : ""}`}
                  onClick={() => setForm({ ...form, crm_type: "hubspot" })}
                >
                  <div className={styles.crmOptionTitle}>HubSpot</div>
                  <div className={styles.crmOptionDesc}>Lee y escribe en su HubSpot</div>
                </button>
              </div>
            </div>

            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>ID único</label>
                <input
                  className={styles.formInput}
                  placeholder="qna-medical"
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  disabled={!!editing}
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Nombre</label>
                <input
                  className={styles.formInput}
                  placeholder="QNA Medical SAS"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
            </div>

            <div className={styles.formRow}>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Phone Number ID (Meta)</label>
                <input
                  className={styles.formInput}
                  placeholder="1234567890"
                  value={form.whatsapp_phone_id}
                  onChange={(e) => setForm({ ...form, whatsapp_phone_id: e.target.value })}
                />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Número owner</label>
                <input
                  className={styles.formInput}
                  placeholder="573001234567"
                  value={form.owner_number}
                  onChange={(e) => setForm({ ...form, owner_number: e.target.value })}
                />
              </div>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Token WhatsApp (Meta)</label>
              <input
                className={styles.formInput}
                placeholder="EAAxxxxxxx"
                type="password"
                value={form.whatsapp_token}
                onChange={(e) => setForm({ ...form, whatsapp_token: e.target.value })}
              />
            </div>

            {form.crm_type === "hubspot" && (
              <div className={styles.formGroup}>
                <label className={styles.formLabel}>Token HubSpot</label>
                <input
                  className={styles.formInput}
                  placeholder="pat-na-xxxxxxx"
                  type="password"
                  value={form.hubspot_token}
                  onChange={(e) => setForm({ ...form, hubspot_token: e.target.value })}
                />
              </div>
            )}

            {form.crm_type === "hubspot" && (
              <>
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border2)" }}>
                  <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                    Sync de propuestas · cron diario
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text3)", margin: "0 0 12px" }}>
                    El cron de las 14:00 UTC detecta correos enviados con el template configurado
                    y mueve/crea el deal en la etapa de propuesta. Luego el comercial recibe un
                    recordatorio (tarea HubSpot + WhatsApp libre) — sin costos de Meta.
                  </p>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
                    onClick={loadHubspotStages}
                    disabled={loadingPipelines || !editing}
                    style={{ flex: 1 }}
                  >
                    {loadingPipelines ? "Consultando…" : "Cargar pipelines de HubSpot"}
                  </button>
                </div>

                {!editing && (
                  <p style={{ fontSize: 11, color: "var(--text3)", marginTop: -8, marginBottom: 12 }}>
                    Guarda primero el tenant con el token de HubSpot, luego edítalo para ver los pipelines.
                  </p>
                )}

                {pipelines && pipelines.length === 0 && (
                  <p style={{ fontSize: 12, color: "var(--text3)" }}>
                    Este tenant no tiene pipelines de deals en HubSpot.
                  </p>
                )}

                {pipelines && pipelines.length > 0 && (
                  <div style={{ background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 8, padding: 12, marginBottom: 12, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                    {pipelines.map((p) => (
                      <div key={p.id} style={{ marginBottom: 10 }}>
                        <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--text2)" }}>
                          {p.label} <span style={{ color: "var(--text3)" }}>(pipeline)</span>
                        </div>
                        {p.stages.map((s) => (
                          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", color: "var(--text2)" }}>
                            <span style={{ flex: 1 }}>{s.label}</span>
                            <code style={{ color: "var(--text3)", fontSize: 10 }}>{s.id}</code>
                            <button
                              type="button"
                              onClick={() => setForm({ ...form, proposal_stage_id: s.id })}
                              style={{ fontSize: 10, padding: "2px 6px", border: "1px solid var(--border2)", borderRadius: 4, background: "transparent", color: "var(--text2)", cursor: "pointer" }}
                              title="Usar como etapa de propuesta"
                            >
                              propuesta
                            </button>
                            <select
                              onChange={(e) => {
                                const key = e.target.value;
                                if (!key) return;
                                setForm({ ...form, stage_map: { ...form.stage_map, [key]: s.id } });
                                e.target.value = "";
                              }}
                              defaultValue=""
                              style={{ fontSize: 10, padding: "2px 4px", border: "1px solid var(--border2)", borderRadius: 4, background: "transparent", color: "var(--text2)" }}
                              title="Asignar a stage map"
                            >
                              <option value="">→map</option>
                              {STAGE_KEYS.map((k) => (
                                <option key={k} value={k}>{k}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                <div className={styles.formRow}>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Stage ID de propuesta</label>
                    <input
                      className={styles.formInput}
                      placeholder="presentationscheduled"
                      value={form.proposal_stage_id}
                      onChange={(e) => setForm({ ...form, proposal_stage_id: e.target.value })}
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Template ID del correo</label>
                    <input
                      className={styles.formInput}
                      placeholder="122339146"
                      value={form.proposal_email_template_id}
                      onChange={(e) => setForm({ ...form, proposal_email_template_id: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border2)" }}>
                  <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                    Mapeo de etapas (Stage Map)
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text3)", margin: "0 0 12px" }}>
                    Asigna el stageId real del pipeline del cliente a cada etapa que entiende
                    el agente. Si dejas vacío, se usa el pipeline default de HubSpot.
                  </p>
                </div>

                {STAGE_KEYS.map((key) => (
                  <div className={styles.formGroup} key={key}>
                    <label className={styles.formLabel}>{key}</label>
                    <input
                      className={styles.formInput}
                      placeholder={`stageId para "${key}"`}
                      value={form.stage_map[key] || ""}
                      onChange={(e) => {
                        const next = { ...form.stage_map };
                        if (e.target.value) next[key] = e.target.value;
                        else delete next[key];
                        setForm({ ...form, stage_map: next });
                      }}
                    />
                  </div>
                ))}
              </>
            )}

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                Prompt del agente (opcional · se genera uno por defecto)
              </label>
              <textarea
                className={`${styles.formInput} ${styles.formTextarea}`}
                placeholder="Eres el asistente de ventas de [Empresa]..."
                value={form.system_prompt}
                onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
              />
            </div>
          </div>

          <div className={styles.modalFooter}>
            <button
              className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
              onClick={() => setModalOpen(false)}
            >
              Cancelar
            </button>
            <button
              className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`}
              onClick={saveTenant}
            >
              Guardar cliente
            </button>
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`${styles.toast} ${toast.type === "error" ? styles.toastError : styles.toastSuccess}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
