/**
 * ARCHIBOT — Meta Leads Webhook
 * Cloudflare Worker
 * 
 * Recibe leads de Meta Ads (formularios + WhatsApp)
 * y los guarda en Firestore para que ArchiBot los muestre en el CRM
 * 
 * Deploy: https://workers.cloudflare.com
 * Tiempo estimado de setup: 10 minutos
 */

// ── CONFIGURACIÓN ─────────────────────────────────────────────────
// Estos valores los defines en Cloudflare Workers → Settings → Variables
// META_VERIFY_TOKEN   → token que tú inventas (ej: "archibot_janeiro_2026")
// FIREBASE_PROJECT_ID → "archibot-janeiro"
// FIREBASE_API_KEY    → "AIzaSyABWcCprZq1071FVPXjpYlaw1IzO3O_bUY"

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS headers para todas las respuestas ──
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // ── GET /webhook — verificación de Meta ──────────────────────
    // Meta llama esto para verificar que el webhook es tuyo
    if (request.method === 'GET' && url.pathname === '/webhook') {
      const mode      = url.searchParams.get('hub.mode');
      const token     = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');

      if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
        console.log('✅ Webhook verificado por Meta');
        return new Response(challenge, { status: 200 });
      }
      return new Response('Token inválido', { status: 403 });
    }

    // ── POST /webhook — recibe leads de Meta ─────────────────────
    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        const body = await request.json();
        console.log('Webhook recibido:', JSON.stringify(body));

        // Procesar cada entrada del webhook
        const leads = [];
        for (const entry of (body.entry || [])) {
          for (const change of (entry.changes || [])) {
            if (change.field === 'leadgen') {
              // Lead de formulario
              const lead = await procesarLeadFormulario(change.value, env);
              if (lead) leads.push(lead);
            } else if (change.field === 'messages') {
              // Mensaje de WhatsApp Business
              const lead = await procesarLeadWhatsApp(change.value, env);
              if (lead) leads.push(lead);
            }
          }
        }

        // Guardar todos los leads en Firestore
        for (const lead of leads) {
          await guardarEnFirestore(lead, env);
        }

        return new Response(JSON.stringify({ ok: true, leads: leads.length }), { headers });
      } catch (err) {
        console.error('Error webhook:', err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
      }
    }

    // ── GET /leads — consulta leads (para debugging) ──────────────
    if (request.method === 'GET' && url.pathname === '/leads') {
      const leads = await leerLeadsDeFirestore(env);
      return new Response(JSON.stringify(leads), { headers });
    }

    // ── GET /health — status del worker ──────────────────────────
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        worker: 'archibot-meta-webhook',
        time: new Date().toISOString(),
      }), { headers });
    }

    return new Response('Not found', { status: 404 });
  }
};

// ── PROCESAR LEAD DE FORMULARIO META ─────────────────────────────
async function procesarLeadFormulario(data, env) {
  try {
    // Obtener datos completos del lead desde Graph API
    const leadId = data.leadgen_id;
    const formId = data.form_id;
    const pageId = data.page_id;
    const adId   = data.ad_id;
    const campa  = data.campaign_name || data.ad_name || 'Meta Formulario';

    // Llamar a Graph API para obtener datos del lead
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${leadId}?access_token=${env.META_PAGE_TOKEN}`
    );
    const leadData = await res.json();

    if (leadData.error) {
      console.error('Error obteniendo lead:', leadData.error.message);
      return null;
    }

    // Extraer campos del formulario
    const campos = {};
    for (const field of (leadData.field_data || [])) {
      campos[field.name] = field.values ? field.values[0] : '';
    }

    const lead = {
      id:           `meta_${leadId}`,
      fuente:       'Meta Formulario',
      plataforma:   'FB',
      campana:      campa,
      adId:         adId || '',
      formId:       formId || '',
      nombre:       campos.full_name || campos.first_name + ' ' + (campos.last_name || '') || 'Sin nombre',
      email:        campos.email || '',
      telefono:     campos.phone_number || campos.mobile_number || '',
      ciudad:       campos.city || campos.location || '',
      presupuesto:  campos.budget || campos.presupuesto || '',
      interes:      campos.interest || campos.tipo_inmueble || 'Apartamento Janeiro',
      mensaje:      campos.message || campos.comentario || '',
      tipologia:    campos.tipologia || '',
      fecha:        new Date().toISOString(),
      estado:       'nuevo',
      etapa:        'nuevo',
      stars:        calcularStars(campos),
      score:        calcularScore(campos),
      tipo:         'formulario',
    };

    console.log('Lead formulario procesado:', lead.nombre);
    return lead;

  } catch (err) {
    console.error('Error procesando lead formulario:', err);
    return null;
  }
}

// ── PROCESAR LEAD DE WHATSAPP ─────────────────────────────────────
async function procesarLeadWhatsApp(data, env) {
  try {
    const messages = data.messages || [];
    if (!messages.length) return null;

    const msg     = messages[0];
    const contact = (data.contacts || [])[0] || {};

    const lead = {
      id:          `wa_${msg.id}`,
      fuente:      'WhatsApp Business',
      plataforma:  'WA',
      campana:     'WhatsApp Directo',
      nombre:      contact.profile?.name || 'Contacto WhatsApp',
      telefono:    msg.from || contact.wa_id || '',
      email:       '',
      mensaje:     msg.text?.body || msg.button?.text || '',
      fecha:       new Date().toISOString(),
      estado:      'nuevo',
      etapa:       'nuevo',
      stars:       3,
      score:       3.0,
      tipo:        'whatsapp',
      waId:        msg.from || '',
    };

    console.log('Lead WhatsApp procesado:', lead.nombre, lead.telefono);
    return lead;

  } catch (err) {
    console.error('Error procesando lead WhatsApp:', err);
    return null;
  }
}

// ── GUARDAR EN FIRESTORE ──────────────────────────────────────────
async function guardarEnFirestore(lead, env) {
  const projectId = env.FIREBASE_PROJECT_ID || 'archibot-janeiro';
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/crm_leads/${lead.id}?key=${env.FIREBASE_API_KEY}`;

  const doc = {
    fields: {}
  };

  // Convertir lead a formato Firestore
  for (const [key, val] of Object.entries(lead)) {
    if (typeof val === 'string') {
      doc.fields[key] = { stringValue: val };
    } else if (typeof val === 'number') {
      doc.fields[key] = { doubleValue: val };
    } else if (typeof val === 'boolean') {
      doc.fields[key] = { booleanValue: val };
    }
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Error Firestore:', err);
  } else {
    console.log('✅ Lead guardado en Firestore:', lead.id);
  }
}

// ── LEER LEADS DE FIRESTORE (para debug) ─────────────────────────
async function leerLeadsDeFirestore(env) {
  const projectId = env.FIREBASE_PROJECT_ID || 'archibot-janeiro';
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/crm_leads?key=${env.FIREBASE_API_KEY}&pageSize=50`;

  const res = await res.json();
  return res.documents || [];
}

// ── CALCULAR SCORING DEL LEAD ─────────────────────────────────────
function calcularScore(campos) {
  let score = 2.0;
  const presupuesto = (campos.budget || campos.presupuesto || '').toLowerCase();
  const interes     = (campos.interest || '').toLowerCase();

  if (presupuesto.includes('399') || presupuesto.includes('415') || presupuesto.includes('400')) score += 1.5;
  else if (presupuesto.includes('300') || presupuesto.includes('350')) score += 0.8;

  if (interes.includes('invert') || interes.includes('compra')) score += 1.0;
  else if (interes.includes('vivir') || interes.includes('vivienda')) score += 0.5;

  if (campos.phone_number || campos.mobile_number) score += 0.3;
  if (campos.email) score += 0.2;

  return Math.min(5.0, parseFloat(score.toFixed(1)));
}

function calcularStars(campos) {
  const score = calcularScore(campos);
  if (score >= 4.0) return 5;
  if (score >= 3.0) return 4;
  if (score >= 2.0) return 3;
  return 2;
}
