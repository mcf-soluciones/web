import turso from './_lib/turso.js';

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
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

    if (body.type === 'inventario') {
      return await handleInventario(body, res);
    }

    if (body.type === 'insumos') {
      return await handleInsumos(body, res);
    }

    // Default: visit submission
    return await handleVisit(body, res);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'mcf-visits - Internal server error',
      message: error.message,
    });
  }
}

async function handleVisit(body, res) {
  const now = new Date();
  const dateStr = formatDate(now);
  const title = `Visita ${body.propiedad} - ${dateStr}`;

  // Calculate time_clean from task timestamps
  const timestamps = Object.values(body.taskCompletionTimestamps || {})
    .filter(ts => ts !== null)
    .map(ts => new Date(ts));

  let timeClean = 0;
  if (timestamps.length > 0) {
    const firstTaskTime = new Date(Math.min(...timestamps));
    const submissionTime = new Date(body.submissionTimestamp);
    timeClean = Math.round((submissionTime - firstTaskTime) / (1000 * 60));
  }

  const propiedad = (() => {
    switch (body.propiedad) {
      case 'usera': return 'usera';
      case 'hortaleza': return 'hortaleza';
      default: return 'otra';
    }
  })();

  const mcfUser = (() => {
    switch (body.user) {
      case 'lalo': return 'lalo';
      case 'adrian': return 'adrian';
      case 'oscar': return 'oscar';
      case 'kenia': return 'kenia';
      default: return 'otro';
    }
  })();

  // Build condensed payload for audit
  const rawPayload = JSON.stringify(body);

  // INSERT visit
  const result = await turso.execute({
    sql: `INSERT INTO visits (
      visita, visit_id, propiedad, mcf_user, fecha, time_clean,
      superficies_secadoras, superficies_secadoras_atras,
      superficies_lavadoras, superficies_lavadoras_atras,
      tirar_botes, barrer, trapear,
      descarga_billetes, carga_monedas, carga_papel,
      carga_tarjetas_cliente, superficie_billetes, superficie_tarjetas,
      jabon_bodega, suavizante_bodega, oxigeno_bodega,
      jabon_bombas, suavizante_bombas, oxigeno_bombas,
      limpieza_general, limpieza_maquinas, limpieza_basura,
      raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      title,
      body.visitId || 'no-id',
      propiedad,
      mcfUser,
      dateStr,
      timeClean,
      body.L99001 ? 1 : 0,
      body.L99002 ? 1 : 0,
      body.L99003 ? 1 : 0,
      body.L99004 ? 1 : 0,
      body.L99006 ? 1 : 0,
      body.L99007 ? 1 : 0,
      body.L99008 ? 1 : 0,
      body.L99014 ? 1 : 0,
      body.L99015 ? 1 : 0,
      body.L99012 ? 1 : 0,
      body.L99013 ? 1 : 0,
      body.L99009 ? 1 : 0,
      body.L99010 ? 1 : 0,
      (Number(body.L01020_1) + Number(body.L02020_1)) || 0,
      (Number(body.L01020_2) + Number(body.L02020_2)) || 0,
      (Number(body.L01020_3) + Number(body.L02020_3)) || 0,
      (Number(body.L01021_1) + Number(body.L02021_1) + Number(body.L01022_1) + Number(body.L02022_1)) || 0,
      (Number(body.L01021_2) + Number(body.L02021_2) + Number(body.L01022_2) + Number(body.L02022_2)) || 0,
      (Number(body.L01021_3) + Number(body.L02021_3) + Number(body.L01022_3) + Number(body.L02022_3)) || 0,
      Number(body.L99016) || 0,
      Number(body.L99017) || 0,
      Number(body.L99018) || 0,
      rawPayload,
    ],
  });

  const visitDbId = Number(result.lastInsertRowid);

  // Create task rows for completed tasks
  const tasksToCreate = {
    'Usera - Reinicio Lavadora 4': { shouldCreate: body.L01001, comment: `Completed: ${body.taskCompletionTimestamps?.L01001}` },
    'Usera - Reinicio Lavadora 5': { shouldCreate: body.L01002, comment: `Completed: ${body.taskCompletionTimestamps?.L01002}` },
    'Usera - Reinicio Lavadora 6': { shouldCreate: body.L01003, comment: `Completed: ${body.taskCompletionTimestamps?.L01003}` },
    'Usera - Reinicio Lavadora 7': { shouldCreate: body.L01004, comment: `Completed: ${body.taskCompletionTimestamps?.L01004}` },
    'Usera - Limpieza Filtro Secadora 1': { shouldCreate: body.L01009, comment: `Completed: ${body.taskCompletionTimestamps?.L01009}` },
    'Usera - Limpieza Filtro Secadora 2': { shouldCreate: body.L01010, comment: `Completed: ${body.taskCompletionTimestamps?.L01010}` },
    'Usera - Limpieza Filtro Secadora 3': { shouldCreate: body.L01011, comment: `Completed: ${body.taskCompletionTimestamps?.L01011}` },
    'Usera - Revision Bombas 1': { shouldCreate: body.L01007, comment: `Completed: ${body.taskCompletionTimestamps?.L01007}` },
    'Usera - Revision Bombas 2': { shouldCreate: body.L01008, comment: `Completed: ${body.taskCompletionTimestamps?.L01008}` },
    'Hortaleza - Reinicio Lavadora 1': { shouldCreate: body.L02001, comment: `Completed: ${body.taskCompletionTimestamps?.L02001}` },
    'Hortaleza - Reinicio Lavadora 2': { shouldCreate: body.L02002, comment: `Completed: ${body.taskCompletionTimestamps?.L02002}` },
    'Hortaleza - Reinicio Lavadora 3': { shouldCreate: body.L02003, comment: `Completed: ${body.taskCompletionTimestamps?.L02003}` },
    'Hortaleza - Reinicio Lavadora 4': { shouldCreate: body.L02004, comment: `Completed: ${body.taskCompletionTimestamps?.L02004}` },
    'Hortaleza - Limpieza Filtro Secadora 5': { shouldCreate: body.L02011, comment: `Completed: ${body.taskCompletionTimestamps?.L02011}` },
    'Hortaleza - Limpieza Filtro Secadora 6': { shouldCreate: body.L02009, comment: `Completed: ${body.taskCompletionTimestamps?.L02009}` },
    'Hortaleza - Limpieza Filtro Secadora 7': { shouldCreate: body.L02010, comment: `Completed: ${body.taskCompletionTimestamps?.L02010}` },
    'Hortaleza - Revision Bombas 1': { shouldCreate: body.L02007, comment: `Completed: ${body.taskCompletionTimestamps?.L02007}` },
    'Hortaleza - Revision Bombas 2': { shouldCreate: body.L02008, comment: `Completed: ${body.taskCompletionTimestamps?.L02008}` },
  };

  // Batch insert completed tasks
  const taskInserts = Object.entries(tasksToCreate)
    .filter(([, { shouldCreate }]) => shouldCreate)
    .map(([taskName, { comment }]) => ({
      sql: `INSERT INTO visit_tasks (visit_id, task_name, status, comments) VALUES (?, ?, 'Complete', ?)`,
      args: [visitDbId, taskName, comment],
    }));

  if (taskInserts.length > 0) {
    await turso.batch(taskInserts);
  }

  return res.status(200).json({
    success: true,
    id: visitDbId,
    message: 'Visit created successfully',
  });
}

async function handleInventario(body, res) {
  const now = new Date();
  const dateStr = formatDate(now);
  const propiedad = body.propiedad.charAt(0).toUpperCase() + body.propiedad.slice(1);
  const visitId = body.visitId;

  const locations = ['bodega', 'bomba1', 'bomba2'];
  const createdRows = [];

  const inserts = locations.map(location => {
    const locationDisplay = location === 'bodega' ? 'Bodega' :
                            location === 'bomba1' ? 'Bomba 1' : 'Bomba 2';

    const jabon = Number(body[`${location}_jabon`]) || 0;
    const suavizante = Number(body[`${location}_suavizante`]) || 0;
    const oxigeno = Number(body[`${location}_oxigeno`]) || 0;
    const title = `${propiedad} - ${dateStr} (${visitId}) - ${locationDisplay}`;

    createdRows.push({ location: locationDisplay, title });

    return {
      sql: `INSERT INTO inventory (name, date, propiedad, location, jabon, suavizante, oxigeno, visit_id_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [title, dateStr, body.propiedad, locationDisplay, jabon, suavizante, oxigeno, visitId],
    };
  });

  await turso.batch(inserts);

  return res.status(200).json({
    success: true,
    type: 'inventario',
    pages: createdRows,
    message: 'Inventory pages created successfully',
  });
}

async function handleInsumos(body, res) {
  const taskName = `[Compra de Insumos] ${body.insumoText}`;

  const result = await turso.execute({
    sql: `INSERT INTO insumos (task_name) VALUES (?)`,
    args: [taskName],
  });

  return res.status(200).json({
    success: true,
    type: 'insumos',
    id: Number(result.lastInsertRowid),
    message: 'Insumos request created successfully',
  });
}
