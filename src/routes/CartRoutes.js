const express = require("express");
const router = express.Router();
const CartController = require("../controllers/CartController");
const { authMiddleware } = require("../middleware/authMiddleware");

// Customer protected routes
router.use(authMiddleware);

router.get("/", CartController.getCart);
router.get("/validate", CartController.validateCart);
router.post("/", CartController.addToCart);
router.put("/quantity", CartController.updateQuantity);
router.delete("/:productId", CartController.removeFromCart);
router.delete("/", CartController.clearCart);

module.exports = router;
