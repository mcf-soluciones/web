import turso from './_lib/turso.js';

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
  'Content-Type': 'application/json',
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).json({});
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    if (!body) {
      return res.status(400).json({ error: 'No request body received' });
    }

    const now = new Date();
    const dateStr = formatDate(now);

    if (body.type === 'gasto') {
      return await handleGasto(body, dateStr, now, res);
    }
    if (body.type === 'deposito') {
      return await handleDepositoSimple(body, dateStr, res);
    }
    if (body.type === 'incidencia') {
      return await handleIncidencia(body, dateStr, res);
    }
    if (body.type === 'encuesta') {
      return await handleEncuesta(body, now, res);
    }

    // Default: deposito, transito, fondo_caja (with cash denomination breakdown)
    return await handleDenominationMovement(body, dateStr, res);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'mcf-movimientosForm - Internal server error',
      message: error.message,
    });
  }
}

async function handleGasto(body, dateStr, now, res) {
  const title = `Gasto ${body.propiedad} - ${body.concepto_mcf} - ${dateStr}`;
  const description = `Concepto: ${body.concepto_proveedor}\nImporte: ${body.importe_total} ${body.currency}\nFiscal: ${body.is_fiscal ? 'Si' : 'No'}\nInversion: ${body.es_inversion ? 'Si' : 'No'}`;

  const result = await turso.execute({
    sql: `INSERT INTO movements (movement, type, account, euros, propiedad, mcf_user, date_real, description, icon)
          VALUES (?, 'gasto', 'cash', ?, ?, ?, ?, ?, '💸')`,
    args: [
      title,
      body.importe_total || 0,
      body.propiedad || null,
      body.mcf_user || 'unknown',
      dateStr,
      description,
    ],
  });

  return res.status(200).json({
    success: true,
    type: 'gasto',
    id: Number(result.lastInsertRowid),
    message: 'Gasto created successfully',
  });
}

async function handleDepositoSimple(body, dateStr, res) {
  const title = `Deposito a Cuenta - ${dateStr}`;
  const description = `Deposito de ${body.euros} EUR a cuenta bancaria`;

  const result = await turso.execute({
    sql: `INSERT INTO movements (movement, type, account, euros, propiedad, mcf_user, date_real, description, icon)
          VALUES (?, 'deposito', ?, ?, ?, ?, ?, ?, '🏦')`,
    args: [
      title,
      body.account || 'cash',
      body.euros || 0,
      body.propiedad || null,
      body.mcf_user || 'unknown',
      dateStr,
      description,
    ],
  });

  return res.status(200).json({
    success: true,
    type: 'deposito',
    id: Number(result.lastInsertRowid),
    message: 'Deposito created successfully',
  });
}

async function handleIncidencia(body, dateStr, res) {
  const title = body.description || `Incidencia ${body.propiedad} - ${dateStr}`;

  const result = await turso.execute({
    sql: `INSERT INTO incidents (summary, severity, propiedad, cost, resolution, found, machine, incident_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      title,
      body.severity || 'media',
      body.propiedad || 'unknown',
      body.cost || 0,
      body.resolution || 'pendiente',
      body.found || 'otro',
      body.machine || null,
      dateStr,
    ],
  });

  return res.status(200).json({
    success: true,
    type: 'incidencia',
    id: Number(result.lastInsertRowid),
    message: 'Incidencia created successfully',
  });
}

async function handleEncuesta(body, now, res) {
  const surveyId = body.survey_id || 'no-id';
  const title = `Encuesta ${body.location} - ${surveyId}`;

  const result = await turso.execute({
    sql: `INSERT INTO surveys (name, survey_id, propiedad, experience, cleanliness, availability, recommend, comments, survey_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      title,
      surveyId,
      body.location || 'unknown',
      body.experience || 'unknown',
      body.cleanliness || 'unknown',
      body.availability || 'unknown',
      body.recommend || 'unknown',
      body.comments || null,
      now.toISOString(),
    ],
  });

  return res.status(200).json({
    success: true,
    type: 'encuesta',
    id: Number(result.lastInsertRowid),
    message: 'Encuesta submitted successfully',
  });
}

async function handleDenominationMovement(body, dateStr, res) {
  const type = (() => {
    switch (body.type) {
      case 'transito': return 'transito';
      case 'gasto': return 'gasto';
      default: return 'fondo caja';
    }
  })();

  const title = `Movimiento ${body.type} - ${dateStr}`;

  const euros =
    (body.b20e * 20) + (body.b10e * 10) + (body.b5e * 5) +
    (body.m2e * 2) + (body.m1e * 1) +
    (body.m50e * 0.50) + (body.m20e * 0.20) + (body.m10e * 0.10) + (body.m5e * 0.05);

  const description = `Count de billetes: 20e = ${body.b20e}, 10e = ${body.b10e}, 5e = ${body.b5e} - Count de Monedas: 2e = ${body.m2e}, 1e = ${body.m1e}, 0.50e = ${body.m50e}, 0.20e = ${body.m20e}, 0.10e = ${body.m10e}, 0.05e = ${body.m5e}`;

  const result = await turso.execute({
    sql: `INSERT INTO movements (movement, type, account, euros, propiedad, mcf_user, date_real, description, icon)
          VALUES (?, ?, 'cash', ?, ?, ?, ?, ?, '🟡')`,
    args: [
      title,
      type,
      euros,
      body.propiedad || null,
      body.user || 'unknown',
      dateStr,
      description,
    ],
  });

  return res.status(200).json({
    success: true,
    type: body.type,
    id: Number(result.lastInsertRowid),
    message: 'Movement created successfully',
  });
}
