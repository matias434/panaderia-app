const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./src/config/db'); // Asegúrate de que esta ruta apunte a tu conexión de base de datos

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
const repartidores = ['Rodrigo', 'Elsa', 'Marcos'];
const nombreCookieProveedor = 'proveedor_sesion';
const intentosLoginProveedor = new Map();
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
    const result = await db.query('SELECT id, nombre, precio_unitario FROM productos ORDER BY nombre ASC');
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
            'cantidad', dp.cantidad
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
  try {
    const pedidos = await obtenerPedidos({
      soloPendientes: true,
      repartidor: req.repartidorAutenticado,
      hastaFecha: obtenerFechaArgentina()
    });
    res.json(pedidos);
  } catch (error) {
    console.error('Error al obtener envíos del proveedor:', error);
    res.status(500).json({ error: 'Error al obtener tus envíos' });
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
       SET estado = 'Completado'
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
        typeof item.producto_nombre !== 'string' ||
        !item.producto_nombre.trim() ||
        item.producto_nombre.trim().length > 150 ||
        !Number.isFinite(Number(item.cantidad)) ||
        Number(item.cantidad) <= 0
      )
    ) {
      return res.status(400).json({ error: 'Escribí cada producto y agregá una cantidad válida' });
    }

    client = await db.pool.connect();
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
      await client.query(
        `INSERT INTO detalle_pedidos (pedido_id, producto_nombre, cantidad) 
         VALUES ($1, $2, $3)`,
        [pedidoId, item.producto_nombre.trim(), item.cantidad]
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
         SUM(dp.cantidad) AS cantidad_total
       FROM pedidos p
       JOIN detalle_pedidos dp ON dp.pedido_id = p.id
       LEFT JOIN productos pr ON pr.id = dp.producto_id
       WHERE p.fecha_entrega::DATE = $1::DATE
       GROUP BY COALESCE(dp.producto_nombre, pr.nombre, 'Producto sin nombre')
       ORDER BY producto ASC`,
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

// Arrancar el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});