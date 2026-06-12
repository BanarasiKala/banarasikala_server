const CustomerAddress = require("../models/CustomerAddress");

const MAX_ADDRESSES = 3;
let cachedAddressColumns = null;

const cleanText = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const cleanCoordinate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const getAddressColumns = async () => {
  if (cachedAddressColumns) return cachedAddressColumns;
  const description = await CustomerAddress.describe();
  cachedAddressColumns = new Set(Object.keys(description));
  return cachedAddressColumns;
};

const getReadableAddressAttributes = async () => {
  const columns = await getAddressColumns();
  return Object.keys(CustomerAddress.rawAttributes).filter((key) => columns.has(key));
};

const keepExistingColumns = async (payload) => {
  const columns = await getAddressColumns();
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.has(key)));
};

const normalizeAddressRow = (row) => {
  const address = row?.toJSON ? row.toJSON() : row;
  if (!address) return address;
  return {
    ...address,
    house_building: address.house_building || address.address_line1 || "",
    area_street: address.area_street || address.address_line2 || "",
    address_line1: address.house_building || address.address_line1 || "",
    address_line2: address.area_street || address.address_line2 || "",
  };
};

class CustomerAddressController {
  async list(req, res) {
    try {
      const rows = await CustomerAddress.findAll({
        where: { customer_id: req.user.id },
        attributes: await getReadableAddressAttributes(),
        order: [["is_default", "DESC"], ["updated_at", "DESC"]],
      });
      return res.status(200).json(rows.map(normalizeAddressRow));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  async create(req, res) {
    try {
      const existingCount = await CustomerAddress.count({
        where: { customer_id: req.user.id },
      });
      if (existingCount >= MAX_ADDRESSES) {
        return res.status(400).json({ message: `You can save maximum ${MAX_ADDRESSES} addresses.` });
      }

      const {
        label,
        name,
        phone,
        alternate_phone,
        country,
        house_building,
        area_street,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        landmark,
        delivery_instructions,
        map_address,
        map_lat,
        map_lng,
        is_default,
      } = req.body || {};

      const primaryAddress = cleanText(house_building) || cleanText(address_line1);
      const areaAddress = cleanText(area_street) || cleanText(address_line2);

      if (!primaryAddress) {
        return res.status(400).json({ message: "Please enter Flat, House no. or Building." });
      }

      const payload = await keepExistingColumns({
        customer_id: req.user.id,
        label: cleanText(label),
        name: cleanText(name),
        phone: cleanText(phone),
        alternate_phone: cleanText(alternate_phone),
        country: cleanText(country) || "India",
        house_building: primaryAddress,
        area_street: areaAddress,
        address_line1: primaryAddress,
        address_line2: areaAddress,
        city: cleanText(city),
        state: cleanText(state),
        pincode: cleanText(pincode),
        landmark: cleanText(landmark),
        delivery_instructions: cleanText(delivery_instructions),
        map_address: cleanText(map_address),
        map_lat: cleanCoordinate(map_lat),
        map_lng: cleanCoordinate(map_lng),
        is_default: !!is_default,
      });

      if (payload.is_default) {
        await CustomerAddress.update(
          { is_default: false },
          { where: { customer_id: req.user.id } },
        );
      }

      const created = await CustomerAddress.create(payload, { returning: Object.keys(payload) });
      return res.status(201).json(normalizeAddressRow(created));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  async update(req, res) {
    try {
      const { id } = req.params;
      const address = await CustomerAddress.findOne({
        where: { id, customer_id: req.user.id },
        attributes: await getReadableAddressAttributes(),
      });
      if (!address) return res.status(404).json({ message: "Address not found" });

      const {
        label,
        name,
        phone,
        alternate_phone,
        country,
        house_building,
        area_street,
        address_line1,
        address_line2,
        city,
        state,
        pincode,
        landmark,
        delivery_instructions,
        map_address,
        map_lat,
        map_lng,
        is_default,
      } = req.body || {};

      let payload = {};
      if (label !== undefined) payload.label = cleanText(label);
      if (name !== undefined) payload.name = cleanText(name);
      if (phone !== undefined) payload.phone = cleanText(phone);
      if (alternate_phone !== undefined) payload.alternate_phone = cleanText(alternate_phone);
      if (country !== undefined) payload.country = cleanText(country) || "India";
      if (house_building !== undefined || address_line1 !== undefined) {
        const primaryAddress = cleanText(house_building) || cleanText(address_line1);
        payload.house_building = primaryAddress;
        payload.address_line1 = primaryAddress;
      }
      if (area_street !== undefined || address_line2 !== undefined) {
        const areaAddress = cleanText(area_street) || cleanText(address_line2);
        payload.area_street = areaAddress;
        payload.address_line2 = areaAddress;
      }
      if (city !== undefined) payload.city = cleanText(city);
      if (state !== undefined) payload.state = cleanText(state);
      if (pincode !== undefined) payload.pincode = cleanText(pincode);
      if (landmark !== undefined) payload.landmark = cleanText(landmark);
      if (delivery_instructions !== undefined) payload.delivery_instructions = cleanText(delivery_instructions);
      if (map_address !== undefined) payload.map_address = cleanText(map_address);
      if (map_lat !== undefined) payload.map_lat = cleanCoordinate(map_lat);
      if (map_lng !== undefined) payload.map_lng = cleanCoordinate(map_lng);
      if (is_default !== undefined) payload.is_default = !!is_default;
      payload = await keepExistingColumns(payload);

      if (
        (payload.house_building !== undefined && !payload.house_building) ||
        (payload.address_line1 !== undefined && !payload.address_line1)
      ) {
        return res.status(400).json({ message: "Please enter Flat, House no. or Building." });
      }

      if (payload.is_default) {
        await CustomerAddress.update(
          { is_default: false },
          { where: { customer_id: req.user.id } },
        );
      }

      await address.update(payload);
      return res.status(200).json(normalizeAddressRow(address));
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }

  async remove(req, res) {
    try {
      const { id } = req.params;
      const address = await CustomerAddress.findOne({
        where: { id, customer_id: req.user.id },
        attributes: await getReadableAddressAttributes(),
      });
      if (!address) return res.status(404).json({ message: "Address not found" });

      await address.destroy();
      return res.status(200).json({ message: "Address deleted" });
    } catch (error) {
      return res.status(500).json({ message: error.message });
    }
  }
}

module.exports = new CustomerAddressController();
