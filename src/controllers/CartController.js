const CartService = require("../services/CartService");
const { ok, asyncHandler } = require("../utils/http");

class CartController {
  getCart = asyncHandler(async (req, res) => {
    const items = await CartService.getCart(req.customer.id);
    return ok(res, items, "Cart fetched");
  });

  addToCart = asyncHandler(async (req, res) => {
    const { productId, quantity, colorId } = req.body;
    const item = await CartService.addToCart(req.customer.id, productId, quantity, colorId);
    return ok(res, item, "Item added to cart", 201);
  });

  updateQuantity = asyncHandler(async (req, res) => {
    const { productId, quantity, colorId } = req.body;
    const item = await CartService.updateQuantity(req.customer.id, productId, quantity, colorId);
    return ok(res, item, "Cart quantity updated");
  });

  removeFromCart = asyncHandler(async (req, res) => {
    const { productId } = req.params;
    await CartService.removeFromCart(req.customer.id, productId);
    return ok(res, null, "Item removed from cart");
  });

  clearCart = asyncHandler(async (req, res) => {
    await CartService.clearCart(req.customer.id);
    return ok(res, null, "Cart cleared");
  });

  validateCart = asyncHandler(async (req, res) => {
    const issues = await CartService.validateCart(req.customer.id);
    return ok(res, issues, "Cart validated");
  });
}

module.exports = new CartController();
