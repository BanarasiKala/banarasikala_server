const Shipment = require('../models/Shipment');
const { SHIPMENT_TYPE } = require('./orderModelV2');

// The money fields that make selected_courier_data a real rate card.
const RATE_CARD_MONEY_KEYS = [
  'rate', 'freight_charge', 'courier_charge',
  'rto_charges', 'rto_charge', 'rto_freight_charge',
  'cod_charges', 'cod_charge', 'cod_multiplier', 'whatsapp_charges', 'whatsapp_charge',
];

// True only when selected_courier_data actually carries the rate card. The AWB-assigned
// webhook OVERLAYS {courier_name, courier_company_id, awb_code, etd, awb_assigned_date}
// onto whatever is already there — so a shipment created WITHOUT a rate card ends up
// holding just those five keys. That looks populated but has no money fields, which is
// how an RTO charge quietly became 0.
const hasCourierRateCard = (data) => {
  const d = data || {};
  return RATE_CARD_MONEY_KEYS.some((k) => d[k] !== undefined && d[k] !== null && d[k] !== '');
};

// The order's rate card, resolved from the EARLIEST forward shipment that actually has
// one (the original dispatch captured it at checkout). Resilient to shipments created by
// paths that don't persist it (e.g. the admin pushOrder route).
//
// Every NEW forward shipment on an existing order (RTO re-dispatch, exchange replacement)
// must carry this forward. Without it a later RTO on that shipment computes rto_charge = 0,
// silently under-recovering the return leg.
const findOrderRateCard = async (orderId, transaction) => {
  const shipments = await Shipment.findAll({
    where: { order_id: orderId, type: SHIPMENT_TYPE.FORWARD },
    order: [['created_at', 'ASC']],
    ...(transaction ? { transaction } : {}),
  });
  return shipments.find((s) => hasCourierRateCard(s.selected_courier_data))?.selected_courier_data || null;
};

module.exports = {
  RATE_CARD_MONEY_KEYS,
  hasCourierRateCard,
  findOrderRateCard,
};
