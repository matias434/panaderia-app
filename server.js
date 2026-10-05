const express = require('express');
const path = require('path');
const db = require('./src/config/db'); // Asegúrate de que esta ruta apunte a tu conexión de base de datos

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json());

// Servir archivos estáticos desde src/public
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Ruta raíz: Redirige automáticamente a la pantalla de recepción
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'public', 'recepcion.html'));
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

async function obtenerPedidos({ fecha, soloPendientes = false }) {
  const filtros = [];
  const parametros = [];

  if (fecha) {
    parametros.push(fecha);
    filtros.push(`p.fecha_entrega::DATE = $${parametros.length}::DATE`);
  }
  if (soloPendientes) filtros.push("LOWER(COALESCE(p.estado, 'pendiente')) = 'pendiente'");

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
    ORDER BY ${soloPendientes ? 'p.fecha_entrega ASC, p.id ASC' : 'p.id DESC'};
  `;

  const { rows } = await db.query(query, parametros);
  return rows;
}

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