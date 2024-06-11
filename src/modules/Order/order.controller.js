import { asyncHandler } from "../../utils/errorHandling.js";
import cartModel from "../../../DB/models/Cart.model.js";
import foodModel from "../../../DB/models/Food.model.js";
import orderModel from "../../../DB/models/Order.model.js";
import couponModel from "../../../DB/models/Coupon.model.js";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { unlink } from 'node:fs/promises'
import createInvoice from "../../utils/pdfInvoice.js";
import cloudinary from "../../utils/cloudinary.js";
import sendEmail from "../../utils/email.js"
import { clearCart } from "./order.service.js";
import Stripe from "stripe";

//createOrder
export const createOrder = asyncHandler(async (req, res, next) => {
  const { payment, address, phone, coupon } = req.body
  let checkCoupon;
  if (coupon) {
    checkCoupon = await couponModel.findOne({ name: coupon, expiredAt: { $gt: Date.now() } })
    if (!checkCoupon) {
      return next(new Error("Coupon Not Found or Expired", { cause: 404 }))
    }
  }
  const cart = await cartModel.findOne({ userId: req.user._id })
  const foods = cart.foods
  if (!foods.length) {
    return next(new Error("Empty Cart", { cause: 404 }))
  }
  let orderFoods = [];
  let orderPrice = 0;
  for (let i = 0; i < foods.length; i++) {
    const food = await foodModel.findById({ _id: foods[i].foodId })
    if (!food) {
      return next(new Error(` ${food.title} Not Found`, { cause: 404 }))
    }
    orderFoods.push({
      foodId: food._id,
      title: food.title,
      itemPrice: food.price,
      quantity: foods[i].quantity,
      totalPrice: food.price * foods[i].quantity
    })
    orderPrice += food.price * foods[i].quantity
  }
  const order = await orderModel.create({
    userId: req.user._id,
    foods: orderFoods,
    price: orderPrice,
    payment,
    address,
    phone,
    coupon: {
      id: checkCoupon?._id,
      name: checkCoupon?.name,
      discount: checkCoupon?.discount
    }
  })
  const invoice = {
    shipping: {
      name: req.user.userName,
      address: order.address,
      country: "Egypt"
    },
    items: order.foods,
    subtotal: order.price,
    discount: parseInt(order.price - order.finalPrice),
    finalPrice: order.finalPrice,
    invoice_number: order._id
  };

  let pdfPath = process.env.MOOD == "DEV" ? path.join(__dirname, `./../../tempInvoices/${order._id}.pdf`) : `/tmp/${order._id}.pdf`;
  createInvoice(invoice, pdfPath);

  const { secure_url, public_id } = await cloudinary.uploader.upload(pdfPath, { folder: `Restaurant/invoices/${order._id}` })
  order.invoice = { url: secure_url, id: public_id }
  await order.save();
  await unlink(pdfPath)
  await sendEmail({
    to: req.user.email,
    subject: `Order Invoice #${order._id}`,
    attachments: [{ path: secure_url, contentType: "application/pdf" }]
  })

  if (payment === "visa") {
    //Stripe gateway payment
    const stripe = new Stripe(process.env.STRIPE_KEY);
    //Coupon Stripe
    let couponExist;
    if (order.coupon !== undefined) {
      couponExist = await stripe.coupons.create({
        percent_off: order.coupon.discount,
        duration: "once",
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      metadata: {order_id: order._id.toString()},
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      line_items: order.foods.map((food) => {
        return {
          price_data: {
            currency: "egp",
            product_data: {
              name: food.title,
            },
            unit_amount: food.itemPrice * 100,
          },
          quantity: food.quantity,
        };
      }),
      discounts: couponExist ? [{ coupon: couponExist.id }] : [],
    });
    return res.json({ message: 'Done', url: session.url })
  }
  clearCart(req.user._id)
  return res.status(201).json({ success: true, message: "Order Created Successfully", order })
})


//cancelOrder
export const cancelOrder = asyncHandler(async (req, res, next) => {
  const order = await orderModel.findOne({ _id: req.params.id, userId: req.user._id })
  if (!order) {
    return next(new Error("Order Not Found", { cause: 404 }))
  }
  if (order.status !== "preparing") {
    return next(new Error("You are not allowed to Cancel this Order", { cause: 403 }))
  }
  order.status = "canceled"
  await order.save()
  return res.status(200).json({ success: true, message: "Order Cancelled Successfully", order })
})

//webhook
export const webhook = asyncHandler(async (req, res, next) => {
  const stripe = new Stripe(process.env.ENDPOINT_SECRET);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.ENDPOINT_SECRET);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }
  // Handle the event
  const orderId = event.data.object.metadata.order._id
  if(event.type == 'checkout.session.completed'){
    await orderModel.findOneAndUpdate({_id : orderId} , {status : "visaPaid"})
  } else {
    await orderModel.findOneAndUpdate({_id : orderId} , {status : "failedToPay"})
  }
});

