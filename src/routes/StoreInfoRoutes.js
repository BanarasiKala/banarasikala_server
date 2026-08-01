const express = require("express");
const { config } = require("../config/env");

const router = express.Router();

/**
 * Public store identity — the shop's own name, address and contact desk.
 *
 * This reads the *same* config.invoiceSeller block the tax invoice prints from, on purpose.
 * The footer, the Contact page and the invoice were three separate copies of the address
 * before this, so moving premises meant editing a React file and redeploying the client, and
 * whichever copy got missed then contradicted the others on a legal document.
 *
 * Nothing here is secret: every field is already printed on invoices customers receive.
 * GSTIN is deliberately left out anyway — the storefront has no use for it, and an endpoint
 * should hand back what its callers need rather than everything it can see.
 */
router.get("/", (req, res) => {
  const seller = config.invoiceSeller || {};

  res.json({
    store: {
      name: seller.name || "Banarasi Kala",
      // INVOICE_SELLER_EMAIL is the desk printed on invoices. SUPPORT_EMAIL is the reply-to
      // on transactional mail; it stands in only when the invoice field is left blank, so a
      // deployment that configures just one of the two still shows a working address.
      email: seller.email || config.supportEmail,
      website: seller.website || "",
      // Kept as separate fields rather than one pre-joined string so callers choose their own
      // granularity: the footer wants one line, a Contact page may want the street on its own.
      // Clearing INVOICE_SELLER_ADDRESS in .env collapses the footer to just the city/state.
      street: seller.address || "",
      cityState: seller.cityState || "",
      shortLocation: seller.shortLocation || "",
    },
  });
});

module.exports = router;
