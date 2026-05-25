-- Habilita la etapa `negociación` para el agente del tenant QNA Medical.
-- Antes el stage `decisionmakerboughtin` lo gestionaba solo el comercial humano;
-- ahora el agente también puede mover deals ahí (p.ej. cuando un cliente pide
-- documentos técnicos después de la propuesta).
update tenants
set stage_map = coalesce(stage_map, '{}'::jsonb)
  || jsonb_build_object('negociación', 'decisionmakerboughtin')
where id = 'qna-medical';
