const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/authMiddleware");
const CustomerAddressController = require("../controllers/CustomerAddressController");

router.get("/", authMiddleware, CustomerAddressController.list);
router.post("/", authMiddleware, CustomerAddressController.create);
router.put("/:id", authMiddleware, CustomerAddressController.update);
router.delete("/:id", authMiddleware, CustomerAddressController.remove);

module.exports = router;

