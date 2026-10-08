const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./src/config/db'); // Asegúrate de que esta ruta apunte a tu conexión de base de datos
const initSchema = require('./src/config/initDb');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
const repartidores = ['Rodrigo', 'Elsa', 'Marcos'];
const nombreCookieProveedor = 'proveedor_sesion';
const nombreCookieSecretaria = 'secretaria_sesion';
const intentosLoginProveedor = new Map();
const intentosLoginSecretaria = new Map();
const duracionSesionMs = 12 * 60 * 60 * 1000;

// Middlewares
app.use(express.json());

// Servir archivos estáticos desde src/public
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Ruta raíz: Redirige automáticamente a la pantalla de recepción
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'recepcion.html'));
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ------------------ RUTAS DE LA API ------------------

// 1. Obtener todos los clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const result = await db.query('SELECT id, nombre FROM clientes ORDER BY nombre ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener clientes:', error);
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
});

// 2. Obtener todos los productos
app.get('/api/productos', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre, precio_unitario, categoria, subcategoria, unidad
       FROM productos
       WHERE activo = TRUE AND categoria IN ('Mayorista', 'Minorista')
       ORDER BY categoria ASC, subcategoria ASC, nombre ASC, unidad ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

async function obtenerPedidos({ fecha, soloPendientes = false, repartidor, hastaFecha }) {
  const filtros = [];
  const parametros = [];

  if (fecha) {
    parametros.push(fecha);
    filtros.push(`p.fecha_entrega::DATE = $${parametros.length}::DATE`);
  }
  if (soloPendientes) filtros.push("LOWER(COALESCE(p.estado, 'pendiente')) = 'pendiente'");
  if (repartidor) {
    parametros.push(repartidor);
    filtros.push(`p.repartidor = $${parametros.length}`);
    filtros.push("p.tipo_entrega = 'Reparto'");
  }
  if (hastaFecha) {
    parametros.push(hastaFecha);
    filtros.push(`p.fecha_entrega::DATE <= $${parametros.length}::DATE`);
  }

  const query = `
    SELECT 
      p.id, 
      TO_CHAR(p.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega, 
      p.tipo_entrega, 
      p.estado,
      p.repartidor,
      COALESCE(p.cliente_nombre, c.nombre) AS cliente_nombre,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'producto_nombre', COALESCE(dp.producto_nombre, pr.nombre, 'Producto sin nombre'),
            'cantidad', dp.cantidad,
            'unidad', COALESCE(dp.unidad, '')
          )
        ) FILTER (WHERE dp.id IS NOT NULL), '[]'
      ) AS items
    FROM pedidos p
    LEFT JOIN clientes c ON p.cliente_id = c.id
    LEFT JOIN detalle_pedidos dp ON dp.pedido_id = p.id
    LEFT JOIN productos pr ON dp.producto_id = pr.id
    ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
    GROUP BY p.id, p.fecha_entrega, p.tipo_entrega, p.estado, p.repartidor, p.cliente_nombre, c.nombre
    ORDER BY ${soloPendientes || hastaFecha ? 'p.fecha_entrega ASC, p.id ASC' : 'p.id DESC'};
  `;

  const { rows } = await db.query(query, parametros);
  return rows;
}

function crearFirmaSesion(contenido, secreto) {
  return crypto.createHmac('sha256', secreto).update(contenido).digest('base64url');
}

function leerCookie(req, nombre) {
  const cookies = (req.headers.cookie || '').split(';');
  const cookie = cookies.map(valor => valor.trim()).find(valor => valor.startsWith(`${nombre}=`));
  return cookie ? cookie.slice(nombre.length + 1) : '';
}

function obtenerRepartidorDeSesion(req) {
  const secreto = process.env.PROVIDER_SESSION_SECRET;
  if (!secreto || secreto.length < 32) return null;

  const [contenido, firma, extra] = leerCookie(req, nombreCookieProveedor).split('.');
  if (!contenido || !firma || extra) return null;

  const firmaEsperada = crearFirmaSesion(contenido, secreto);
  const firmaBuffer = Buffer.from(firma);
  const firmaEsperadaBuffer = Buffer.from(firmaEsperada);
  if (
    firmaBuffer.length !== firmaEsperadaBuffer.length ||
    !crypto.timingSafeEqual(firmaBuffer, firmaEsperadaBuffer)
  ) return null;

  try {
    const sesion = JSON.parse(Buffer.from(contenido, 'base64url').toString('utf8'));
    if (
      !repartidores.includes(sesion.repartidor) ||
      !Number.isFinite(sesion.expira) ||
      sesion.expira <= Date.now()
    ) return null;
    return sesion.repartidor;
  } catch {
    return null;
  }
}

function requiereSesionProveedor(req, res, next) {
  const repartidor = obtenerRepartidorDeSesion(req);
  if (!repartidor) {
    return res.status(401).json({ error: 'La sesión venció. Ingresá nuevamente tu PIN.' });
  }
  req.repartidorAutenticado = repartidor;
  next();
}

function obtenerSecretariaDeSesion(req) {
  const secreto = process.env.SECRETARY_SESSION_SECRET;
  if (!secreto || secreto.length < 32) return false;

  const [contenido, firma, extra] = leerCookie(req, nombreCookieSecretaria).split('.');
  if (!contenido || !firma || extra) return false;

  const firmaEsperada = crearFirmaSesion(contenido, secreto);
  const firmaBuffer = Buffer.from(firma);
  const firmaEsperadaBuffer = Buffer.from(firmaEsperada);
  if (
    firmaBuffer.length !== firmaEsperadaBuffer.length ||
    !crypto.timingSafeEqual(firmaBuffer, firmaEsperadaBuffer)
  ) return false;

  try {
    const sesion = JSON.parse(Buffer.from(contenido, 'base64url').toString('utf8'));
    return sesion.rol === 'secretaria' && Number.isFinite(sesion.expira) && sesion.expira > Date.now();
  } catch {
    return false;
  }
}

function requiereSesionSecretaria(req, res, next) {
  if (!obtenerSecretariaDeSesion(req)) {
    return res.status(401).json({ error: 'La sesión de Secretaría venció. Ingresá nuevamente.' });
  }
  next();
}

function configurarCookieSecretaria(res, valor) {
  const segura = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'railway' || res.req.secure
    ? '; Secure'
    : '';
  res.setHeader(
    'Set-Cookie',
    `${nombreCookieSecretaria}=${valor}; HttpOnly; SameSite=Strict; Path=/api/secretaria; Max-Age=${duracionSesionMs / 1000}${segura}`
  );
}

function validarFechaISO(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const fechaParseada = new Date(`${fecha}T00:00:00.000Z`);
  return Number.isFinite(fechaParseada.getTime()) && fechaParseada.toISOString().slice(0, 10) === fecha;
}

function obtenerFechaArgentina() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const valores = Object.fromEntries(partes.map(parte => [parte.type, parte.value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}

function configurarCookieProveedor(res, valor) {
  const segura = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'railway' || res.req.secure
    ? '; Secure'
    : '';
  res.setHeader(
    'Set-Cookie',
    `${nombreCookieProveedor}=${valor}; HttpOnly; SameSite=Strict; Path=/api/proveedor; Max-Age=${duracionSesionMs / 1000}${segura}`
  );
}

app.post('/api/secretaria/login', (req, res) => {
  const { pin } = req.body || {};
  if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) {
    return res.status(400).json({ error: 'Ingresá un PIN de 4 a 12 números' });
  }

  const pinConfigurado = process.env.SECRETARY_PIN;
  const secretoSesion = process.env.SECRETARY_SESSION_SECRET;
  if (!pinConfigurado || !/^\d{4,12}$/.test(pinConfigurado) || !secretoSesion || secretoSesion.length < 32) {
    console.error('Falta configurar SECRETARY_PIN o SECRETARY_SESSION_SECRET (mínimo 32 caracteres)');
    return res.status(503).json({ error: 'El acceso de Secretaría aún no está configurado' });
  }

  const ahora = Date.now();
  const claveIntento = req.ip || req.socket.remoteAddress || 'desconocido';
  const intento = intentosLoginSecretaria.get(claveIntento);
  if (intento && intento.bloqueadoHasta > ahora) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos e intentá nuevamente.' });
  }
  if (intento && ahora - intento.inicio > 15 * 60 * 1000) {
    intentosLoginSecretaria.delete(claveIntento);
  }

  const pinIngresado = Buffer.from(pin);
  const pinValido = Buffer.from(pinConfigurado);
  const coincide = pinIngresado.length === pinValido.length &&
    crypto.timingSafeEqual(pinIngresado, pinValido);
  if (!coincide) {
    const intentosActuales = intentosLoginSecretaria.get(claveIntento) || { inicio: ahora, cantidad: 0 };
    intentosActuales.cantidad += 1;
    if (intentosActuales.cantidad >= 5) intentosActuales.bloqueadoHasta = ahora + 15 * 60 * 1000;
    intentosLoginSecretaria.set(claveIntento, intentosActuales);
    return res.status(401).json({ error: 'PIN incorrecto' });
  }

  intentosLoginSecretaria.delete(claveIntento);
  const contenido = Buffer.from(JSON.stringify({
    rol: 'secretaria',
    expira: ahora + duracionSesionMs
  })).toString('base64url');
  configurarCookieSecretaria(res, `${contenido}.${crearFirmaSesion(contenido, secretoSesion)}`);
  res.json({ rol: 'secretaria' });
});

app.get('/api/secretaria/sesion', requiereSesionSecretaria, (_req, res) => {
  res.json({ rol: 'secretaria' });
});

app.post('/api/secretaria/logout', (req, res) => {
  const segura = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'railway' || req.secure
    ? '; Secure'
    : '';
  res.setHeader(
    'Set-Cookie',
    `${nombreCookieSecretaria}=; HttpOnly; SameSite=Strict; Path=/api/secretaria; Max-Age=0${segura}`
  );
  res.status(204).end();
});

app.get('/api/secretaria/pedidos', requiereSesionSecretaria, async (req, res) => {
  const { fecha, repartidor } = req.query;
  if (!validarFechaISO(fecha) || !repartidores.includes(repartidor)) {
    return res.status(400).json({ error: 'Seleccioná una fecha y un repartidor válidos' });
  }

  try {
    const result = await db.query(
      `SELECT
         p.id,
         TO_CHAR(p.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega,
         p.estado,
         p.repartidor,
         COALESCE(p.cliente_nombre, c.nombre) AS cliente_nombre,
         COALESCE(detalles.items, '[]'::JSON) AS items,
         detalles.total_pedido,
         COALESCE(pagos.total_pagado, 0) AS total_pagado,
         COALESCE(pagos.registros, '[]'::JSON) AS pagos
       FROM pedidos p
       LEFT JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN LATERAL (
         SELECT
           JSON_AGG(JSON_BUILD_OBJECT(
             'id', dp.id,
             'producto_nombre', COALESCE(dp.producto_nombre, pr.nombre, 'Producto sin nombre'),
             'cantidad', dp.cantidad,
             'unidad', COALESCE(dp.unidad, ''),
             'precio_unitario', dp.precio_unitario,
             'subtotal', ROUND(dp.cantidad * dp.precio_unitario, 2)
           ) ORDER BY dp.id) AS items,
           CASE
             WHEN COUNT(*) FILTER (WHERE dp.precio_unitario IS NULL) > 0 THEN NULL
             ELSE SUM(ROUND(dp.cantidad * dp.precio_unitario, 2))
           END AS total_pedido
         FROM detalle_pedidos dp
         LEFT JOIN productos pr ON pr.id = dp.producto_id
         WHERE dp.pedido_id = p.id
       ) detalles ON TRUE
       LEFT JOIN LATERAL (
         SELECT
           SUM(pp.monto) AS total_pagado,
           JSON_AGG(JSON_BUILD_OBJECT(
             'id', pp.id,
             'medio', pp.medio,
             'monto', pp.monto,
             'registrado_en', pp.registrado_en,
             'repartidor', pp.repartidor
           ) ORDER BY pp.registrado_en, pp.id) AS registros
         FROM pagos_pedidos pp
         WHERE pp.pedido_id = p.id
       ) pagos ON TRUE
       WHERE p.fecha_entrega::DATE = $1::DATE
         AND p.repartidor = $2
         AND p.tipo_entrega = 'Reparto'
       ORDER BY c.nombre ASC, p.id ASC`,
      [fecha, repartidor]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al consultar pedidos de Secretaría:', error);
    res.status(500).json({ error: 'No se pudieron consultar los pedidos para el reparto' });
  }
});

app.put('/api/secretaria/pedidos/:id/precios', requiereSesionSecretaria, async (req, res) => {
  const pedidoId = Number(req.params.id);
  const { items } = req.body || {};
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    return res.status(400).json({ error: 'El número de pedido no es válido' });
  }
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.some(item =>
      !item ||
      !Number.isInteger(Number(item.detalle_id)) ||
      Number(item.detalle_id) <= 0 ||
      !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(item.precio_unitario))
    ) ||
    new Set(items.map(item => Number(item.detalle_id))).size !== items.length
  ) {
    return res.status(400).json({ error: 'Ingresá un precio válido para cada producto del pedido' });
  }

  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const pedido = await client.query(
      `SELECT id FROM pedidos
       WHERE id = $1 AND tipo_entrega = 'Reparto'
       FOR UPDATE`,
      [pedidoId]
    );
    if (pedido.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No se encontró el pedido de reparto' });
    }

    const detalles = await client.query(
      'SELECT id FROM detalle_pedidos WHERE pedido_id = $1 ORDER BY id',
      [pedidoId]
    );
    const idsEnviados = items.map(item => Number(item.detalle_id)).sort((a, b) => a - b);
    const idsExistentes = detalles.rows.map(item => item.id).sort((a, b) => a - b);
    if (
      idsEnviados.length !== idsExistentes.length ||
      idsEnviados.some((id, index) => id !== idsExistentes[index])
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Los productos del pedido cambiaron. Actualizá la pantalla e intentá nuevamente' });
    }

    for (const item of items) {
      await client.query(
        'UPDATE detalle_pedidos SET precio_unitario = $1 WHERE id = $2 AND pedido_id = $3',
        [item.precio_unitario, Number(item.detalle_id), pedidoId]
      );
    }
    const totales = await client.query(
      `SELECT
         SUM(ROUND(cantidad * precio_unitario, 2)) AS total,
         COUNT(*) FILTER (WHERE precio_unitario IS NULL) AS sin_precio
       FROM detalle_pedidos
       WHERE pedido_id = $1`,
      [pedidoId]
    );
    const pagos = await client.query(
      'SELECT COALESCE(SUM(monto), 0) AS total_pagado FROM pagos_pedidos WHERE pedido_id = $1',
      [pedidoId]
    );
    if (Number(totales.rows[0].total) < Number(pagos.rows[0].total_pagado)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'El nuevo total no puede ser menor que lo ya cobrado' });
    }

    await client.query('COMMIT');
    res.json({
      id: pedidoId,
      total: Number(totales.rows[0].total || 0),
      sin_precio: Number(totales.rows[0].sin_precio)
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error al deshacer precios de Secretaría:', rollbackError);
      }
    }
    console.error('Error al guardar precios del pedido:', error);
    res.status(500).json({ error: 'No se pudieron guardar los precios del pedido' });
  } finally {
    if (client) client.release();
  }
});

// Acceso móvil de proveedores
app.post('/api/proveedor/login', (req, res) => {
  const { repartidor, pin } = req.body || {};
  if (!repartidores.includes(repartidor) || typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) {
    return res.status(400).json({ error: 'Ingresá tu repartidor y un PIN de 4 a 12 números' });
  }

  const secretoSesion = process.env.PROVIDER_SESSION_SECRET;
  const nombreVariablePin = `PROVIDER_PIN_${repartidor.toUpperCase()}`;
  const pinConfigurado = process.env[nombreVariablePin];
  if (
    !secretoSesion ||
    secretoSesion.length < 32 ||
    !pinConfigurado ||
    !/^\d{4,12}$/.test(pinConfigurado)
  ) {
    console.error(`Falta configurar ${nombreVariablePin} o PROVIDER_SESSION_SECRET (mínimo 32 caracteres)`);
    return res.status(503).json({ error: 'El acceso de proveedores aún no está configurado' });
  }

  const ahora = Date.now();
  const claveIntento = req.ip || req.socket.remoteAddress || 'desconocido';
  const intento = intentosLoginProveedor.get(claveIntento);
  if (intento && intento.bloqueadoHasta > ahora) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos e intentá nuevamente.' });
  }
  if (intento && ahora - intento.inicio > 15 * 60 * 1000) {
    intentosLoginProveedor.delete(claveIntento);
  }

  const pinIngresado = Buffer.from(pin);
  const pinValido = Buffer.from(pinConfigurado);
  const coincide = pinIngresado.length === pinValido.length &&
    crypto.timingSafeEqual(pinIngresado, pinValido);
  if (!coincide) {
    const intentosActuales = intentosLoginProveedor.get(claveIntento) || { inicio: ahora, cantidad: 0 };
    intentosActuales.cantidad += 1;
    if (intentosActuales.cantidad >= 5) intentosActuales.bloqueadoHasta = ahora + 15 * 60 * 1000;
    intentosLoginProveedor.set(claveIntento, intentosActuales);
    return res.status(401).json({ error: 'PIN incorrecto' });
  }

  intentosLoginProveedor.delete(claveIntento);
  const contenido = Buffer.from(JSON.stringify({
    repartidor,
    expira: ahora + duracionSesionMs
  })).toString('base64url');
  configurarCookieProveedor(res, `${contenido}.${crearFirmaSesion(contenido, secretoSesion)}`);
  res.json({ repartidor });
});

app.get('/api/proveedor/sesion', requiereSesionProveedor, (req, res) => {
  res.json({ repartidor: req.repartidorAutenticado });
});

app.post('/api/proveedor/logout', (req, res) => {
  res.setHeader(
    'Set-Cookie',
    `${nombreCookieProveedor}=; HttpOnly; SameSite=Strict; Path=/api/proveedor; Max-Age=0${process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'railway' || req.secure ? '; Secure' : ''}`
  );
  res.status(204).end();
});

app.get('/api/proveedor/pedidos', requiereSesionProveedor, async (req, res) => {
  const fechaSeleccionada = req.query.fecha;
  if (fechaSeleccionada !== undefined && !validarFechaISO(fechaSeleccionada)) {
    return res.status(400).json({ error: 'La fecha debe tener el formato AAAA-MM-DD' });
  }

  try {
    const result = await db.query(
      `SELECT
         p.id,
         TO_CHAR(p.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega,
         p.tipo_entrega,
         p.estado,
         p.repartidor,
         COALESCE(p.cliente_nombre, c.nombre) AS cliente_nombre,
         p.entregado_en,
         COALESCE(detalles.items, '[]'::JSON) AS items,
         detalles.total_pedido,
         COALESCE(pagos.total_pagado, 0) AS total_pagado,
         COALESCE(pagos.registros, '[]'::JSON) AS pagos
       FROM pedidos p
       LEFT JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN LATERAL (
         SELECT
           JSON_AGG(JSON_BUILD_OBJECT(
             'producto_nombre', COALESCE(dp.producto_nombre, pr.nombre, 'Producto sin nombre'),
             'cantidad', dp.cantidad,
             'unidad', COALESCE(dp.unidad, ''),
             'precio_unitario', dp.precio_unitario,
             'subtotal', ROUND(dp.cantidad * dp.precio_unitario, 2)
           ) ORDER BY dp.id) AS items,
           CASE
             WHEN COUNT(*) FILTER (WHERE dp.precio_unitario IS NULL) > 0 THEN NULL
             ELSE SUM(ROUND(dp.cantidad * dp.precio_unitario, 2))
           END AS total_pedido
         FROM detalle_pedidos dp
         LEFT JOIN productos pr ON pr.id = dp.producto_id
         WHERE dp.pedido_id = p.id
       ) detalles ON TRUE
       LEFT JOIN LATERAL (
         SELECT
           SUM(pp.monto) AS total_pagado,
           JSON_AGG(JSON_BUILD_OBJECT(
             'medio', pp.medio,
             'monto', pp.monto,
             'registrado_en', pp.registrado_en
           ) ORDER BY pp.registrado_en, pp.id) AS registros
         FROM pagos_pedidos pp
         WHERE pp.pedido_id = p.id
       ) pagos ON TRUE
       WHERE p.repartidor = $1
         AND p.tipo_entrega = 'Reparto'
         AND COALESCE(p.oculto_proveedor, FALSE) = FALSE
         AND (
           ($2::DATE IS NULL AND p.fecha_entrega::DATE <= $3::DATE)
           OR ($2::DATE IS NOT NULL AND p.fecha_entrega::DATE = $2::DATE)
         )
         AND (
           $2::DATE IS NOT NULL
           OR LOWER(COALESCE(p.estado, 'pendiente')) = 'pendiente'
           OR (
             LOWER(COALESCE(p.estado, 'pendiente')) = 'completado'
             AND (
               detalles.total_pedido IS NULL
               OR detalles.total_pedido > COALESCE(pagos.total_pagado, 0)
               OR p.entregado_en >= CURRENT_TIMESTAMP - INTERVAL '8 hours'
               OR (p.entregado_en IS NULL AND p.fecha_entrega::DATE = $2::DATE)
             )
           )
         )
       ORDER BY p.fecha_entrega ASC, p.id ASC`,
      [req.repartidorAutenticado, fechaSeleccionada || null, obtenerFechaArgentina()]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener envíos del proveedor:', error);
    res.status(500).json({ error: 'Error al obtener tus envíos' });
  }
});

app.patch('/api/proveedor/pedidos/:id/ocultar', requiereSesionProveedor, async (req, res) => {
  const pedidoId = Number(req.params.id);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    return res.status(400).json({ error: 'El número de pedido no es válido' });
  }

  try {
    const result = await db.query(
      `UPDATE pedidos
       SET oculto_proveedor = TRUE
       WHERE id = $1
         AND repartidor = $2
         AND tipo_entrega = 'Reparto'
         AND LOWER(COALESCE(estado, 'pendiente')) = 'completado'
         AND COALESCE(oculto_proveedor, FALSE) = FALSE
       RETURNING id`,
      [pedidoId, req.repartidorAutenticado]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No se encontró un pedido entregado tuyo para quitar de Mis envíos' });
    }
    res.json({ id: result.rows[0].id, mensaje: 'Pedido quitado de Mis envíos; el historial se conserva' });
  } catch (error) {
    console.error('Error al ocultar pedido de Mis envíos:', error);
    res.status(500).json({ error: 'No se pudo quitar el pedido de Mis envíos' });
  }
});

app.patch('/api/proveedor/pedidos/:id/entregar', requiereSesionProveedor, async (req, res) => {
  const pedidoId = Number(req.params.id);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    return res.status(400).json({ error: 'El número de pedido no es válido' });
  }

  try {
    const result = await db.query(
      `UPDATE pedidos
       SET estado = 'Completado', entregado_en = CURRENT_TIMESTAMP
       WHERE id = $1
         AND repartidor = $2
         AND tipo_entrega = 'Reparto'
         AND fecha_entrega::DATE <= $3::DATE
         AND LOWER(COALESCE(estado, 'pendiente')) = 'pendiente'
       RETURNING id, estado`,
      [pedidoId, req.repartidorAutenticado, obtenerFechaArgentina()]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No se encontró un envío pendiente tuyo para hoy o atrasado con ese número' });
    }
    res.json({ id: result.rows[0].id, estado: result.rows[0].estado });
  } catch (error) {
    console.error('Error al confirmar envío del proveedor:', error);
    res.status(500).json({ error: 'No se pudo confirmar el envío' });
  }
});

app.post('/api/proveedor/pedidos/:id/pagos', requiereSesionProveedor, async (req, res) => {
  const pedidoId = Number(req.params.id);
  const { medio, monto } = req.body || {};
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    return res.status(400).json({ error: 'El número de pedido no es válido' });
  }
  if (
    !['Efectivo', 'Mercado Pago'].includes(medio) ||
    !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(monto)) ||
    Number(monto) <= 0
  ) {
    return res.status(400).json({ error: 'Ingresá un monto mayor a cero y un medio de pago válido' });
  }

  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const pedido = await client.query(
      `SELECT p.id, p.estado
       FROM pedidos p
       WHERE p.id = $1
         AND p.repartidor = $2
         AND p.tipo_entrega = 'Reparto'
         AND p.fecha_entrega::DATE <= $3::DATE
       FOR UPDATE`,
      [pedidoId, req.repartidorAutenticado, obtenerFechaArgentina()]
    );
    if (pedido.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No se encontró un pedido tuyo para hoy o atrasado' });
    }
    if (String(pedido.rows[0].estado || '').toLowerCase() !== 'completado') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Confirmá la entrega antes de registrar el cobro' });
    }

    const totales = await client.query(
      `SELECT
         CASE
           WHEN COUNT(*) FILTER (WHERE precio_unitario IS NULL) > 0 THEN NULL
           ELSE SUM(ROUND(cantidad * precio_unitario, 2))
         END AS total_pedido
       FROM detalle_pedidos
       WHERE pedido_id = $1`,
      [pedidoId]
    );
    if (totales.rows[0].total_pedido === null) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'El pedido todavía no tiene todos sus precios cargados por Secretaría' });
    }
    const pagosActuales = await client.query(
      'SELECT COALESCE(SUM(monto), 0) AS total_pagado FROM pagos_pedidos WHERE pedido_id = $1',
      [pedidoId]
    );
    const saldo = Number(totales.rows[0].total_pedido) - Number(pagosActuales.rows[0].total_pagado);
    if (Number(monto) > saldo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El cobro no puede superar el saldo pendiente del pedido' });
    }

    const result = await client.query(
      `INSERT INTO pagos_pedidos (pedido_id, repartidor, medio, monto)
       VALUES ($1, $2, $3, $4)
       RETURNING id, medio, monto, registrado_en`,
      [pedidoId, req.repartidorAutenticado, medio, monto]
    );
    await client.query('COMMIT');
    res.status(201).json({
      pago: result.rows[0],
      total_pedido: Number(totales.rows[0].total_pedido),
      total_pagado: Number(pagosActuales.rows[0].total_pagado) + Number(monto),
      saldo_pendiente: saldo - Number(monto)
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error al deshacer el cobro:', rollbackError);
      }
    }
    console.error('Error al registrar pago del repartidor:', error);
    res.status(500).json({ error: 'No se pudo registrar el cobro' });
  } finally {
    if (client) client.release();
  }
});

// 3. Crear un nuevo pedido con transacción
app.post('/api/pedidos', async (req, res) => {
  let client;
  try {
    const {
      cliente_id,
      cliente_nombre,
      fecha_entrega,
      tipo_entrega = 'Reparto',
      repartidor,
      items
    } = req.body;
    const esRetiro = tipo_entrega === 'Retiro en local';

    if (!['Reparto', 'Retiro en local'].includes(tipo_entrega)) {
      return res.status(400).json({ error: 'Seleccioná un tipo de entrega válido' });
    }

    if (esRetiro && (typeof cliente_nombre !== 'string' || !cliente_nombre.trim())) {
      return res.status(400).json({ error: 'Escribí el nombre de la persona que retira el pedido' });
    }

    if (!esRetiro && (!cliente_id || !['Rodrigo', 'Elsa', 'Marcos'].includes(repartidor))) {
      return res.status(400).json({ error: 'Seleccioná un cliente y un repartidor válido' });
    }

    if (typeof cliente_nombre === 'string' && cliente_nombre.trim().length > 100) {
      return res.status(400).json({ error: 'El nombre no puede superar los 100 caracteres' });
    }

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.some(item =>
        !item ||
        !Number.isInteger(Number(item.producto_id)) ||
        Number(item.producto_id) <= 0 ||
        !Number.isFinite(Number(item.cantidad)) ||
        Number(item.cantidad) <= 0
      )
    ) {
      return res.status(400).json({ error: 'Seleccioná un producto y completá la cantidad en cada renglón' });
    }

    client = await db.pool.connect();
    const idsProductos = [...new Set(items.map(item => Number(item.producto_id)))];
    const resultProductos = await client.query(
      `SELECT id, nombre, unidad
       FROM productos
      WHERE id = ANY($1::INT[]) AND activo = TRUE AND categoria IN ('Mayorista', 'Minorista')`,
      [idsProductos]
    );
    const productosPorId = new Map(resultProductos.rows.map(producto => [producto.id, producto]));
    if (productosPorId.size !== idsProductos.length) {
      return res.status(400).json({ error: 'Uno o más productos seleccionados no están en el catálogo' });
    }

    await client.query('BEGIN');

    // Insertar cabecera del pedido
    const resPedido = await client.query(
      `INSERT INTO pedidos (cliente_id, cliente_nombre, fecha_entrega, estado, tipo_entrega, repartidor) 
       VALUES ($1, $2, $3, 'Pendiente', $4, $5) RETURNING id`,
      [
        esRetiro ? null : cliente_id,
        esRetiro ? cliente_nombre.trim() : null,
        fecha_entrega,
        tipo_entrega,
        esRetiro ? null : repartidor
      ]
    );
    const pedidoId = resPedido.rows[0].id;

    // Insertar ítems del detalle
    for (const item of items) {
      const producto = productosPorId.get(Number(item.producto_id));
      await client.query(
        `INSERT INTO detalle_pedidos (pedido_id, producto_id, producto_nombre, cantidad, unidad)
         VALUES ($1, $2, $3, $4, $5)`,
        [pedidoId, producto.id, producto.nombre, item.cantidad, producto.unidad]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      id: pedidoId,
      tipo_entrega,
      repartidor: esRetiro ? null : repartidor,
      mensaje: 'Pedido creado exitosamente'
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('ERROR AL DESHACER LA TRANSACCIÓN DEL PEDIDO:', rollbackError);
      }
    }
    console.error('ERROR DETALLADO AL CREAR PEDIDO:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// 4. Obtener los pedidos pendientes, independientemente de su fecha
app.get('/api/pedidos/pendientes', async (req, res) => {
  try {
    res.json(await obtenerPedidos({ soloPendientes: true }));
  } catch (error) {
    console.error('Error al obtener pedidos pendientes:', error);
    res.status(500).json({ error: 'Error al obtener pedidos pendientes' });
  }
});

// 5. Obtener pedidos por fecha para el listado e impresión
app.get('/api/pedidos/fecha/:fecha', async (req, res) => {
  try {
    const { fecha } = req.params;
    res.json(await obtenerPedidos({ fecha }));
  } catch (error) {
    console.error('Error al obtener pedidos por fecha:', error);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

app.delete('/api/pedidos/:id', async (req, res) => {
  const pedidoId = Number(req.params.id);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    return res.status(400).json({ error: 'El número de pedido no es válido' });
  }

  let client;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const pedidoExistente = await client.query(
      'SELECT id FROM pedidos WHERE id = $1 FOR UPDATE',
      [pedidoId]
    );
    if (pedidoExistente.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No se encontró el pedido' });
    }
    const pagosExistentes = await client.query(
      'SELECT COUNT(*) AS cantidad FROM pagos_pedidos WHERE pedido_id = $1',
      [pedidoId]
    );
    if (Number(pagosExistentes.rows[0].cantidad) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No se puede eliminar un pedido con cobros registrados' });
    }
    await client.query('DELETE FROM detalle_pedidos WHERE pedido_id = $1', [pedidoId]);
    const result = await client.query('DELETE FROM pedidos WHERE id = $1 RETURNING id', [pedidoId]);

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No se encontró el pedido' });
    }

    await client.query('COMMIT');
    res.json({ id: result.rows[0].id, mensaje: 'Pedido eliminado definitivamente' });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error al deshacer la eliminación del pedido:', rollbackError);
      }
    }
    console.error('Error al eliminar pedido:', error);
    res.status(500).json({ error: 'No se pudo eliminar el pedido' });
  } finally {
    if (client) client.release();
  }
});

// Consolidar la producción por producto y fecha de entrega
app.get('/api/pedidos/cocina', async (req, res) => {
  const { fecha } = req.query;
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return res.status(400).json({ error: 'Seleccioná una fecha válida' });
  }

  try {
    const result = await db.query(
      `SELECT
         COALESCE(dp.producto_nombre, pr.nombre, 'Producto sin nombre') AS producto,
         COALESCE(dp.unidad, '') AS unidad,
         SUM(dp.cantidad) AS cantidad_total
       FROM pedidos p
       JOIN detalle_pedidos dp ON dp.pedido_id = p.id
       LEFT JOIN productos pr ON pr.id = dp.producto_id
       WHERE p.fecha_entrega::DATE = $1::DATE
       GROUP BY COALESCE(dp.producto_nombre, pr.nombre, 'Producto sin nombre'), COALESCE(dp.unidad, '')
       ORDER BY producto ASC, unidad ASC`,
      [fecha]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener consolidado de cocina:', error);
    res.status(500).json({ error: 'Error al generar la lista de producción' });
  }
});

// Marcar como completado un pedido que todavía está pendiente
app.patch('/api/pedidos/:id/completar', async (req, res) => {
  const pedidoId = Number(req.params.id);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    return res.status(400).json({ error: 'El número de pedido no es válido' });
  }

  try {
    const result = await db.query(
      `UPDATE pedidos
       SET estado = 'Completado'
       WHERE id = $1 AND LOWER(COALESCE(estado, 'pendiente')) = 'pendiente'
       RETURNING id, estado`,
      [pedidoId]
    );

    if (result.rowCount === 0) {
      const existente = await db.query('SELECT estado FROM pedidos WHERE id = $1', [pedidoId]);
      if (existente.rowCount === 0) {
        return res.status(404).json({ error: 'No se encontró el pedido' });
      }
      return res.status(409).json({ error: 'El pedido ya no está pendiente' });
    }

    res.json({ id: result.rows[0].id, estado: result.rows[0].estado });
  } catch (error) {
    console.error('Error al completar pedido:', error);
    res.status(500).json({ error: 'Error al actualizar el pedido' });
  }
});

// Crear/verificar el esquema antes de aceptar consultas.
async function startServer() {
  try {
    await initSchema();
    const { rows } = await db.query('SELECT current_database() AS database, current_schema() AS schema');
    console.log(`✅ Base preparada: ${rows[0].database}, esquema ${rows[0].schema}`);
    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ No se pudo preparar PostgreSQL; el servidor no se inició:', error);
    await db.pool.end();
    process.exitCode = 1;
  }
}

startServer();