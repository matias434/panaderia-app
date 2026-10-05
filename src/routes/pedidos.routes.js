const express = require('express');
const router = express.Router();
const pedidosController = require('../controllers/pedidos.controller');

router.get('/clientes', pedidosController.getClientes);
router.get('/productos', pedidosController.getProductos);
router.post('/', pedidosController.crearPedido);
router.get('/cocina', pedidosController.getConsolidadoCocina);

module.exports = router;