import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de privacidad — Z-Agent",
  description:
    "Política de privacidad y tratamiento de datos personales de Z-Agent, asistente comercial para WhatsApp Business operado para clientes de Methodic LLC.",
};

const LAST_UPDATED = "6 de mayo de 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-zinc-800 leading-relaxed">
      <h1 className="text-3xl font-semibold mb-2">Política de privacidad</h1>
      <p className="text-sm text-zinc-500 mb-10">
        Última actualización: {LAST_UPDATED}
      </p>

      <section className="space-y-4 mb-10">
        <p>
          Z-Agent (<em>la &ldquo;Plataforma&rdquo;</em>) es un asistente
          comercial automatizado que conecta la API de WhatsApp Business de
          Meta con sistemas de gestión de relaciones con clientes (CRM) por
          cuenta de empresas comerciales (<em>los &ldquo;Clientes&rdquo;</em>).
          La Plataforma es operada por Methodic LLC. Esta política describe qué
          datos personales tratamos, con qué finalidad, durante cuánto tiempo y
          a quién se transfieren.
        </p>
        <p>
          La Plataforma actúa como <strong>encargado del tratamiento</strong>
          {" "}por cuenta de cada Cliente, quien actúa como{" "}
          <strong>responsable del tratamiento</strong> frente a sus propios
          contactos y prospectos. Para asuntos relacionados con datos
          específicos de un Cliente, dirígete a ese Cliente directamente.
        </p>
      </section>

      <h2 className="text-xl font-semibold mb-3">1. Datos que tratamos</h2>
      <ul className="list-disc pl-6 mb-8 space-y-2">
        <li>
          <strong>Datos de identificación de contactos comerciales</strong>:
          nombre, empresa o institución, cargo, correo electrónico, número de
          teléfono.
        </li>
        <li>
          <strong>Contenido de los mensajes intercambiados por WhatsApp</strong>{" "}
          entre el comercial autorizado del Cliente y la Plataforma.
        </li>
        <li>
          <strong>Metadatos técnicos</strong> de la conversación: identificador
          de número de teléfono de WhatsApp Business, marca temporal, estado de
          entrega.
        </li>
        <li>
          <strong>Registros de actividad</strong>: acciones ejecutadas por el
          asistente (creación de contacto, creación de oportunidad, cambio de
          etapa, nota, tarea) sobre el CRM del Cliente.
        </li>
      </ul>

      <h2 className="text-xl font-semibold mb-3">2. Finalidades</h2>
      <ul className="list-disc pl-6 mb-8 space-y-2">
        <li>
          Procesar el mensaje recibido y generar una respuesta automatizada
          dirigida al comercial autorizado del Cliente.
        </li>
        <li>
          Sincronizar la información comercial con el CRM del Cliente
          (HubSpot, Salesforce u otro sistema configurado).
        </li>
        <li>
          Ejecutar tareas y notificaciones asociadas al pipeline de ventas
          del Cliente, incluyendo recordatorios automáticos de seguimiento.
        </li>
        <li>
          Mantener un registro de auditoría operativa para depuración y
          diagnóstico de incidencias.
        </li>
      </ul>

      <h2 className="text-xl font-semibold mb-3">
        3. Base legal del tratamiento
      </h2>
      <p className="mb-8">
        El tratamiento se ampara en la ejecución del contrato comercial entre
        la Plataforma y el Cliente, y en el interés legítimo del Cliente de
        mantener una operación de ventas eficiente. Cuando el ordenamiento
        jurídico aplicable lo requiera (Ley 1581 de 2012 en Colombia, RGPD en
        la UE u otras), el Cliente es responsable de obtener el consentimiento
        previo de los titulares de los datos.
      </p>

      <h2 className="text-xl font-semibold mb-3">4. Terceros con quienes compartimos datos</h2>
      <p className="mb-3">
        La Plataforma transmite datos a los siguientes proveedores de servicios
        bajo acuerdos de procesamiento de datos:
      </p>
      <ul className="list-disc pl-6 mb-8 space-y-2">
        <li>
          <strong>Meta Platforms, Inc.</strong> — entrega de mensajes
          mediante WhatsApp Business API.
        </li>
        <li>
          <strong>Kapso</strong> — cuando el Cliente lo elige como canal,
          entrega de mensajes de WhatsApp Business API.
        </li>
        <li>
          <strong>Anthropic, PBC</strong> — generación de las respuestas del
          asistente (modelos Claude) vía la API de Anthropic. Los datos
          enviados por la API no se utilizan para entrenar modelos.
        </li>
        <li>
          <strong>Supabase, Inc.</strong> — almacenamiento de configuración
          del Cliente y del registro de actividad.
        </li>
        <li>
          <strong>Vercel Inc.</strong> — hospedaje de la Plataforma.
        </li>
        <li>
          <strong>HubSpot, Inc.</strong> u otro CRM configurado por el Cliente
          — destino final de los registros comerciales.
        </li>
      </ul>

      <h2 className="text-xl font-semibold mb-3">5. Retención</h2>
      <p className="mb-8">
        Los registros de actividad operativa se conservan por hasta doce (12)
        meses con fines de diagnóstico, salvo que el Cliente solicite por
        escrito un período distinto. Los datos comerciales replicados al CRM
        del Cliente se rigen por la política de retención de ese CRM.
      </p>

      <h2 className="text-xl font-semibold mb-3">6. Derechos de los titulares</h2>
      <p className="mb-8">
        Los titulares de los datos pueden ejercer los derechos de acceso,
        rectificación, supresión, oposición y portabilidad ante el Cliente
        responsable del tratamiento. Para solicitudes que requieran
        intervención técnica de la Plataforma, escribe a{" "}
        <a
          href="mailto:privacidad@methodic.dev"
          className="text-blue-600 underline"
        >
          privacidad@methodic.dev
        </a>{" "}
        y daremos curso a la solicitud junto con el Cliente correspondiente.
      </p>

      <h2 className="text-xl font-semibold mb-3">7. Seguridad</h2>
      <p className="mb-8">
        Los tokens de acceso a WhatsApp Business y a CRMs se almacenan cifrados
        en reposo y se transmiten exclusivamente sobre TLS. El acceso al panel
        administrativo está protegido por autenticación con secreto compartido
        y limitación de tasa. Las firmas HMAC-SHA256 verifican la autenticidad
        de cada mensaje entrante de Meta.
      </p>

      <h2 className="text-xl font-semibold mb-3">8. Cambios a esta política</h2>
      <p className="mb-8">
        Esta política puede actualizarse para reflejar cambios operativos,
        legales o técnicos. La fecha de última actualización aparece al inicio
        del documento. Las modificaciones sustanciales se comunican por escrito
        al Cliente.
      </p>

      <h2 className="text-xl font-semibold mb-3">9. Contacto</h2>
      <p>
        Methodic LLC —{" "}
        <a
          href="mailto:privacidad@methodic.dev"
          className="text-blue-600 underline"
        >
          privacidad@methodic.dev
        </a>
        .
      </p>
    </main>
  );
}
