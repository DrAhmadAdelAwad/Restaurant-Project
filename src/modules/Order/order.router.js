import { Router } from "express";
const router = Router()
import * as orderController from './order.controller.js'
import * as orderSchema from './order.schema.js'
import { validation } from '../../middlewares/validation.js'
import { isAuthenticated } from './../../middlewares/authentication.js';
import { isAuthorized } from './../../middlewares/authorization.js';

//createOrder
router.post("/" , isAuthenticated , isAuthorized("client") , validation(orderSchema.createOrder) , orderController.createOrder)

//cancelOrder
router.patch("/:id" , isAuthenticated , isAuthorized("client") , validation(orderSchema.cancelOrder) , orderController.cancelOrder)



export default router