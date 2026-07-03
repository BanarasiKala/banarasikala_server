const axios = require('axios');
const { config } = require('../config/env');

const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';

/**
 * ShipRocketService
 * -----------------
 * Wraps the ShipRocket REST API.
 * Auth token is cached in memory and refreshed automatically before it expires (24h).
 */
class ShipRocketService {
  constructor() {
    this._token = null;
    this._tokenExpiry = null;
    this._pickupLocations = null;
    this._pickupLocationsExpiry = null;
  }

  // ─── AUTH ────────────────────────────────────────────────────────────────────

  async getToken() {
    if (this._token && this._tokenExpiry && Date.now() < this._tokenExpiry - 5 * 60 * 1000) {
      return this._token;
    }
    const response = await axios.post(`${BASE_URL}/auth/login`, {
      email: config.shiprocketEmail,
      password: config.shiprocketPassword,
    });
    this._token = response.data.token;
    this._tokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
    console.log('[ShipRocket] Auth token refreshed.');
    return this._token;
  }

  async _headers() {
    const token = await this.getToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  // ─── PICKUP LOCATION ─────────────────────────────────────────────────────────

  _normalizePickupLocation(raw = {}) {
    const name = raw.pickup_location || raw.pickup_location_name || raw.address_name || raw.name || raw.location_name || raw.title || '';
    const postcode = raw.pin_code || raw.pin || raw.pincode || raw.postcode || raw.pickup_pincode || raw.zipcode || raw.zip || '';
    const status = String(raw.status || raw.active || raw.is_active || '').toLowerCase();
    return {
      name: String(name || '').trim(),
      postcode: String(postcode || '').trim(),
      address: raw.address || raw.address_1 || raw.address_line_1 || raw.pickup_address || '',
      address2: raw.address_2 || raw.address2 || raw.landmark || '',
      city: raw.city || raw.pickup_city || '',
      state: raw.state || raw.pickup_state || '',
      email: raw.email || raw.pickup_email || '',
      phone: raw.phone || raw.pickup_phone || raw.mobile || '',
      isDefault: Boolean(raw.is_default || raw.default || raw.default_address),
      isActive: status ? !['0', 'false', 'inactive', 'disabled'].includes(status) : true,
      raw,
    };
  }

  _extractPickupLocations(responseData) {
    const candidates = [
      responseData?.data?.shipping_address,
      responseData?.data?.pickup_locations,
      responseData?.data?.addresses,
      responseData?.data,
      responseData?.shipping_address,
      responseData?.pickup_locations,
      responseData?.addresses,
      responseData,
    ];
    const list = candidates.find(Array.isArray) || [];
    return list
      .map((item) => this._normalizePickupLocation(item))
      .filter((item) => item.name || item.postcode);
  }

  async getPickupLocations({ force = false } = {}) {
    if (!force && this._pickupLocations && this._pickupLocationsExpiry && Date.now() < this._pickupLocationsExpiry) {
      return this._pickupLocations;
    }
    const headers = await this._headers();
    const response = await axios.get(`${BASE_URL}/settings/company/pickup`, { headers });
    const locations = this._extractPickupLocations(response.data);
    this._pickupLocations = locations;
    this._pickupLocationsExpiry = Date.now() + 30 * 60 * 1000;
    return locations;
  }

  async getActivePickupLocation() {
    const locations = await this.getPickupLocations({ force: true });
    const pickupName = config.shiprocketPickupLocation.trim().toLowerCase();
    const selected =
      locations.find((item) => item.isActive && item.name.toLowerCase() === pickupName) ||
      locations.find((item) => item.name.toLowerCase() === pickupName);

    if (!selected) {
      throw new Error(
        `ShipRocket pickup location "${config.shiprocketPickupLocation}" was not found in your ShipRocket account.`
      );
    }
    return selected;
  }

  // ─── PACKAGE METRICS (env-based box dimensions) ───────────────────────────────
  // Weight/dimensions use the fixed box size from .env, NOT product DB values.
  // PACKAGE_WEIGHT_KG × totalQty, PACKAGE_HEIGHT_CM × totalQty (stacking).
  // Length & Breadth stay fixed (the box never changes width/length).

  _computePackageMetrics(items) {
    const totalQty = items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    return {
      pkgWeight:  Math.max(parseFloat((config.packageWeightKg  * totalQty).toFixed(2)), 0.1),
      pkgLength:  config.packageLengthCm,
      pkgBreadth: config.packageBreadthCm,
      pkgHeight:  Math.max(config.packageHeightCm * totalQty, 1),
    };
  }

  // ─── ORDERS ──────────────────────────────────────────────────────────────────

  /**
   * Create a forward shipment order on ShipRocket.
   * @param {{ order: object, items: Array }} orderData
   */
  async createOrder(orderData) {
    const { order, items } = orderData;
    const pickupLocation = await this.getActivePickupLocation();

    const orderItems = items.map((item, idx) => ({
      name: item.name || item.product_name || `Product ${idx + 1}`,
      sku: item.sku || `BKS${item.product_id || idx + 1}`,
      units: item.quantity,
      selling_price: item.price,
      discount: 0,
      tax: 0,
      hsn: '',
    }));

    const { pkgLength, pkgBreadth, pkgHeight, pkgWeight } = this._computePackageMetrics(items);

    const now = new Date();
    const orderDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const isCod = order.payment_method === 'COD';
    const payload = {
      order_id: order.order_number,
      order_date: orderDate,
      pickup_location: pickupLocation.name,

      // Billing == Shipping for this store
      billing_customer_name: order.customer_name,
      billing_last_name: '',
      billing_address: order.address,
      billing_city: order.city,
      billing_pincode: String(order.pincode),
      billing_state: order.state || 'Uttar Pradesh',
      billing_country: 'India',
      billing_email: order.customer_email,
      billing_phone: String(order.phone),
      billing_is_billing_address: true,

      shipping_is_billing: 1,
      order_items: orderItems,

      payment_method: isCod ? 'COD' : 'Prepaid',
      cod_amount: isCod ? Number(order.total_amount) : 0,
      shipping_charges: 0,
      giftwrap_charges: 0,
      transaction_charges: 0,
      // sub_total is the final payable amount (coupon/wallet/fees already
      // applied), so total_discount must be 0 — otherwise ShipRocket subtracts
      // the coupon a second time and shows a lower order value.
      total_discount: 0,
      sub_total: Number(order.total_amount),
      length: pkgLength,
      breadth: pkgBreadth,
      height: pkgHeight,
      weight: pkgWeight,
      is_insurance: 0,
    };

    const headers = await this._headers();
    const response = await axios.post(`${BASE_URL}/orders/create/adhoc`, payload, { headers });
    return response.data;
  }

  /**
   * Create a return shipment order on ShipRocket.
   * @param {{ order: object, items: Array, reason: string }} returnData
   */
  async createReturnOrder(returnData) {
    const { order, items, reason } = returnData;
    const pickupLocation = await this.getActivePickupLocation();

    const orderItems = items.map((item, idx) => ({
      name: item.name || item.product_name || `Product ${idx + 1}`,
      sku: item.sku || `BKS${item.product_id || idx + 1}`,
      units: item.quantity,
      selling_price: item.price,
      discount: 0,
      tax: 0,
      hsn: '',
    }));

    const { pkgLength, pkgBreadth, pkgHeight, pkgWeight } = this._computePackageMetrics(items);

    const now = new Date();
    const orderDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const payload = {
      order_id: `RET-${order.order_number}`,
      order_date: orderDate,
      pickup_location: pickupLocation.name,

      pickup_customer_name: order.customer_name,
      pickup_last_name: '',
      pickup_address: order.address,
      pickup_address_2: '',
      pickup_city: order.city,
      pickup_pincode: String(order.pincode),
      pickup_state: order.state || 'Uttar Pradesh',
      pickup_country: 'India',
      pickup_email: order.customer_email,
      pickup_phone: String(order.phone),

      shipping_customer_name: pickupLocation.name,
      shipping_last_name: '',
      shipping_address: pickupLocation.address,
      shipping_address_2: pickupLocation.address2,
      shipping_city: pickupLocation.city,
      shipping_pincode: pickupLocation.postcode,
      shipping_state: pickupLocation.state,
      shipping_country: 'India',
      shipping_email: pickupLocation.email,
      shipping_phone: pickupLocation.phone,

      order_items: orderItems,
      payment_method: 'Prepaid',
      channel_id: '',
      comment: reason || 'Customer requested return',
      total_discount: 0,
      sub_total: Number(order.total_amount),
      length: pkgLength,
      breadth: pkgBreadth,
      height: pkgHeight,
      weight: pkgWeight,
    };

    const headers = await this._headers();
    const response = await axios.post(`${BASE_URL}/orders/create/return`, payload, { headers });
    return response.data;
  }

  // ─── AWB / COURIER ───────────────────────────────────────────────────────────

  /**
   * @param {string|number} shipmentId
   * @param {string} pincode
   * @param {number} weight  - kg
   * @param {boolean} isCod
   */
  async getServiceableCouries(shipmentId, pincode, weight = 0.5, isCod = false) {
    const headers = await this._headers();
    const pickupLocation = await this.getActivePickupLocation();
    const params = new URLSearchParams({
      pickup_postcode: pickupLocation.postcode,
      delivery_postcode: String(pincode),
      weight: String(weight),
      cod: isCod ? '1' : '0',
    });
    if (shipmentId) params.set('shipment_id', String(shipmentId));

    const response = await axios.get(
      `${BASE_URL}/courier/serviceability/?${params.toString()}`,
      { headers }
    );
    return {
      ...response.data,
      meta: {
        ...(response.data?.meta || {}),
        pickup_postcode: pickupLocation.postcode,
        pickup_location: pickupLocation.name,
        pickup_source: pickupLocation.source || 'unknown',
        delivery_postcode: String(pincode),
        weight: String(weight),
        cod: isCod ? 1 : 0,
      },
    };
  }

  /**
   * @param {string|number} shipmentId
   * @param {string|number|null} courierId
   */
  async assignAWB(shipmentId, courierId = null) {
    const headers = await this._headers();
    const payload = { shipment_id: String(shipmentId) };
    if (courierId) payload.courier_id = courierId;
    const response = await axios.post(`${BASE_URL}/courier/assign/awb`, payload, { headers });
    return response.data;
  }

  // ─── LABEL & MANIFEST ────────────────────────────────────────────────────────

  async generateLabel(shipmentIds) {
    const headers = await this._headers();
    const response = await axios.post(
      `${BASE_URL}/courier/generate/label`,
      { shipment_id: shipmentIds },
      { headers }
    );
    return response.data;
  }

  async generateManifest(shipmentIds) {
    const headers = await this._headers();
    const response = await axios.post(
      `${BASE_URL}/manifests/generate`,
      { shipment_id: shipmentIds },
      { headers }
    );
    return response.data;
  }

  // ─── TRACKING ────────────────────────────────────────────────────────────────

  async trackByAWB(awb) {
    const headers = await this._headers();
    const response = await axios.get(`${BASE_URL}/courier/track/awb/${awb}`, { headers });
    return response.data;
  }

  async trackByOrderId(shiprocketOrderId) {
    const headers = await this._headers();
    const response = await axios.get(`${BASE_URL}/orders/show/${shiprocketOrderId}`, { headers });
    return response.data;
  }

  // ─── CANCEL ──────────────────────────────────────────────────────────────────

  async cancelOrders(shiprocketOrderIds) {
    const headers = await this._headers();
    const response = await axios.post(
      `${BASE_URL}/orders/cancel`,
      { ids: shiprocketOrderIds },
      { headers }
    );
    return response.data;
  }

  // ─── PICKUP ──────────────────────────────────────────────────────────────────

  async schedulePickup(shipmentIds) {
    const headers = await this._headers();
    const response = await axios.post(
      `${BASE_URL}/courier/generate/pickup`,
      { shipment_id: shipmentIds },
      { headers }
    );
    return response.data;
  }
}

module.exports = new ShipRocketService();
