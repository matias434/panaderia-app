const db = require('../config/db');

// Obtener lista de clientes para desplegable
const getClientes = async (req, res) => {
  try {
    const result = await db.query('SELECT id, nombre, direccion FROM clientes ORDER BY nombre ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener clientes' });
  }
};

// Obtener lista de productos para desplegable
const getProductos = async (req, res) => {
  try {
    const result = await db.query('SELECT id, nombre, precio_unitario FROM productos ORDER BY nombre ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos' });
  }
};

// Cargar nuevo pedido desde Recepción
const crearPedido = async (req, res) => {
  const { cliente_id, fecha_entrega, tipo_entrega, detalles } = req.body;

  try {
    await db.query('BEGIN');

    const resPedido = await db.query(
      `INSERT INTO pedidos (cliente_id, fecha_entrega, tipo_entrega) 
       VALUES ($1, $2, $3) RETURNING id`,
      [cliente_id, fecha_entrega, tipo_entrega || 'reparto']
    );
    const pedidoId = resPedido.rows[0].id;

    for (const item of detalles) {
      await db.query(
        `INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad) 
         VALUES ($1, $2, $3)`,
        [pedidoId, item.producto_id, item.cantidad]
      );
    }

    await db.query('COMMIT');
    res.status(201).json({ status: 'OK', message: 'Pedido registrado correctamente', pedidoId });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Error al crear pedido:', error);
    res.status(500).json({ error: 'Error al registrar el pedido' });
  }
};

// Consolidado para la Cocina
const getConsolidadoCocina = async (req, res) => {
  const { fecha } = req.query;

  try {
    const queryText = `
      SELECT 
        p.nombre AS producto,
        SUM(dp.cantidad) AS cantidad_total
      FROM pedidos ped
      JOIN detalle_pedidos dp ON ped.id = dp.pedido_id
      JOIN productos p ON dp.producto_id = p.id
      WHERE ped.fecha_entrega = $1 AND ped.tipo_entrega = 'reparto'
      GROUP BY p.nombre
      ORDER BY p.nombre ASC
    `;
    const result = await db.query(queryText, [fecha]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener consolidado:', error);
    res.status(500).json({ error: 'Error al generar la lista de producción' });
  }
};

module.exports = {
  getClientes,
  getProductos,
  crearPedido,
  getConsolidadoCocina
};