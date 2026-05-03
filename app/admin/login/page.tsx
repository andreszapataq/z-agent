"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./login.module.css";

export default function LoginPage() {
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleLogin() {
    if (!secret) return;
    setLoading(true);
    setError("");

    // Verifica el secret pidiendo /api/admin/tenants
    const res = await fetch("/api/admin/tenants", {
      headers: { "x-admin-secret": secret },
    });

    if (res.ok) {
      // Guarda el secret en sessionStorage (solo este tab)
      sessionStorage.setItem("z-admin-secret", secret);
      router.push("/admin");
    } else {
      setError("Contraseña incorrecta");
      setLoading(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <div className={styles.logoIcon}>
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M3 8L7 12L13 4" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
        <h1 className={styles.title}>Z-Agent</h1>
        <p className={styles.subtitle}>Panel de administración</p>

        <div className={styles.formGroup}>
          <label className={styles.label}>Contraseña</label>
          <input
            type="password"
            className={styles.input}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="••••••••"
            autoFocus
          />
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <button
          className={styles.button}
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? "Verificando..." : "Entrar"}
        </button>
      </div>
    </div>
  );
}
