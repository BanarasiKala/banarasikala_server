const MarketplaceService = require("../services/MarketplaceService");

const toInt = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const logError = (label, error) => {
  console.error(`[MarketplaceController] ${label}:`, error?.message || error);
};

const MarketplaceController = {
  // ─── Public ──────────────────────────────────────────────────────────────
  async list(req, res) {
    try {
      const marketplaces = await MarketplaceService.listPublicMarketplaces();
      res.json({ marketplaces });
    } catch (error) {
      logError("list", error);
      res.status(500).json({ message: "Could not load marketplaces." });
    }
  },

  // Everything the single /marketplace page renders: every channel, plus every product
  // that is listed on at least one of them carrying all of its badges.
  async showcase(req, res) {
    try {
      const limit = Math.min(Math.max(toInt(req.query.limit, 60), 1), 100);
      const offset = Math.max(toInt(req.query.offset, 0), 0);
      res.json(await MarketplaceService.getShowcase({ limit, offset }));
    } catch (error) {
      logError('showcase', error);
      res.status(500).json({ message: 'Could not load the marketplace page.' });
    }
  },

  async getPage(req, res) {
    try {
      const limit = Math.min(Math.max(toInt(req.query.limit, 60), 1), 100);
      const offset = Math.max(toInt(req.query.offset, 0), 0);
      const page = await MarketplaceService.getMarketplacePage(req.params.slug, { limit, offset });
      // Hidden channels 404 exactly like slugs that never existed — whether one is
      // retired or imaginary is not a distinction the public needs.
      if (!page) return res.status(404).json({ message: "Marketplace not found." });
      res.json(page);
    } catch (error) {
      logError("getPage", error);
      res.status(500).json({ message: "Could not load this marketplace." });
    }
  },

  // Links for a batch of products, so a grid of cards costs one request rather than one
  // per card. Capped because the ids arrive in the query string and this is public.
  async linksForProducts(req, res) {
    try {
      const ids = String(req.query.productIds || "")
        .split(",")
        .map((id) => parseInt(id, 10))
        .filter(Number.isInteger)
        .slice(0, 100);
      if (ids.length === 0) return res.json({ links: {} });
      res.json({ links: await MarketplaceService.listLinksForProducts(ids) });
    } catch (error) {
      logError("linksForProducts", error);
      res.status(500).json({ message: "Could not load marketplace links." });
    }
  },

  async linksForProduct(req, res) {
    try {
      const links = await MarketplaceService.listLinksForProduct(req.params.productId);
      res.json({ links });
    } catch (error) {
      logError("linksForProduct", error);
      res.status(500).json({ message: "Could not load marketplace links." });
    }
  },

  // ─── Admin ───────────────────────────────────────────────────────────────
  async adminList(req, res) {
    try {
      const marketplaces = await MarketplaceService.listAllMarketplaces();
      res.json({ marketplaces });
    } catch (error) {
      logError("adminList", error);
      res.status(500).json({ message: "Could not load marketplaces." });
    }
  },

  async create(req, res) {
    try {
      const marketplace = await MarketplaceService.createMarketplace(req.body);
      res.status(201).json(marketplace);
    } catch (error) {
      logError("create", error);
      res.status(400).json({ message: error.message || "Could not create the marketplace." });
    }
  },

  async update(req, res) {
    try {
      const marketplace = await MarketplaceService.updateMarketplace(req.params.id, req.body);
      res.json(marketplace);
    } catch (error) {
      logError("update", error);
      res.status(400).json({ message: error.message || "Could not update the marketplace." });
    }
  },

  async remove(req, res) {
    try {
      await MarketplaceService.deleteMarketplace(req.params.id);
      res.status(204).send();
    } catch (error) {
      logError("remove", error);
      res.status(400).json({ message: error.message || "Could not delete the marketplace." });
    }
  },

  async productLinks(req, res) {
    try {
      const links = await MarketplaceService.getProductLinks(req.params.productId);
      res.json({ links });
    } catch (error) {
      logError("productLinks", error);
      res.status(500).json({ message: "Could not load this product's links." });
    }
  },

  async saveProductLinks(req, res) {
    try {
      await MarketplaceService.setProductLinks(req.params.productId, req.body.links);
      const links = await MarketplaceService.getProductLinks(req.params.productId);
      res.json({ links });
    } catch (error) {
      logError("saveProductLinks", error);
      res.status(400).json({ message: error.message || "Could not save the links." });
    }
  },

  // Feeds the attach picker: products matching a search, each carrying whatever is
  // already linked to this channel.
  async pickerProducts(req, res) {
    try {
      const products = await MarketplaceService.listProductsForPicker(req.params.id, {
        search: req.query.search,
        limit: req.query.limit,
      });
      res.json({ products });
    } catch (error) {
      logError("pickerProducts", error);
      res.status(500).json({ message: "Could not search products." });
    }
  },

  // Partial success is the normal outcome here, so this answers 200 with a per-row
  // report rather than failing the whole paste because one line was wrong.
  async bulkAttach(req, res) {
    try {
      const result = await MarketplaceService.bulkAttach(req.params.id, req.body.rows || []);
      res.json(result);
    } catch (error) {
      logError("bulkAttach", error);
      res.status(400).json({ message: error.message || "Could not attach those links." });
    }
  },
};

module.exports = MarketplaceController;
